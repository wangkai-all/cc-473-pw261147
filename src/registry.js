import { EventStore } from './store.js';
import { KeyedLock } from './lock.js';
import { SystemClock } from './clock.js';
import {
  fingerprint,
  normalizeSchema,
  validateRecord
} from './schema.js';
import {
  checkCompatibility,
  CompatibilityMode,
  evaluateDataImpact
} from './compatibility.js';
import { ErrorCode, RegistryError } from './errors.js';

const AUDIT_LIMIT = 200;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 默认兼容窗口 7 天

function emptyState() {
  return {
    subjects: {}, // subjectName -> Subject
    records: {}, // subjectName -> Record[]
    migrations: {}, // subjectName -> { steps, irreversible, updatedAt }
    audit: []
  };
}

function safeDefaultFor(field) {
  switch (field.type) {
    case 'string':
      return '';
    case 'boolean':
      return false;
    case 'int':
    case 'long':
    case 'float':
    case 'double':
      return 0;
    case 'enum':
      return field.symbols[0];
    default:
      return null;
  }
}

/**
 * 事件溯源注册表。所有状态变更都先落 WAL 再经 reducer 应用，
 * 崩溃后由 EventStore.load 重放恢复，内存状态永远是事件的归约结果。
 */
export class SchemaRegistry {
  #store;
  #clock;
  #locks;
  #snapshotEvery;
  #state;
  #recovery;

  constructor({ store, clock = new SystemClock(), snapshotEvery = 10, state, recovery } = {}) {
    this.#store = store;
    this.#clock = clock;
    this.#locks = new KeyedLock();
    this.#snapshotEvery = snapshotEvery;
    this.#state = state ?? emptyState();
    this.#recovery = recovery ?? { replayed: 0, recoveredPartial: false };
  }

  /** 从目录恢复注册表（快照 + WAL 重放）。 */
  static recover({ dir, clock, snapshotEvery = 10 } = {}) {
    const store = new EventStore(dir ?? null);
    const registry = new SchemaRegistry({
      store,
      clock,
      snapshotEvery,
      state: emptyState(),
      recovery: { replayed: 0, recoveredPartial: false }
    });
    const result = store.load(
      (state, event) => registry.applyEvent(state, event),
      emptyState
    );
    registry.#state = result.state;
    registry.#recovery = {
      replayed: result.replayed,
      recoveredPartial: result.recoveredPartial
    };
    return { registry, recovery: registry.#recovery };
  }

  get recoveryInfo() {
    return { ...this.#recovery, walSeq: this.#store.sequence };
  }

  // ---------- 事件归约 ----------

  applyEvent(state, event) {
    const { type, payload, seq, at } = event;
    switch (type) {
      case 'SUBJECT_CREATED': {
        state.subjects[payload.name] = {
          name: payload.name,
          compatibilityMode: payload.compatibilityMode,
          versions: [],
          actors: {},
          nextRecordId: 0
        };
        state.records[payload.name] = [];
        break;
      }
      case 'VERSION_PUBLISHED': {
        const subject = state.subjects[payload.subject];
        subject.versions.push({
          version: payload.version,
          kind: payload.kind ?? 'evolution',
          schema: payload.schema,
          publishedBy: payload.publishedBy,
          createdAt: payload.createdAt,
          previousVersion: payload.previousVersion,
          rollbackOf: payload.rollbackOf ?? null,
          retainedFields: payload.retainedFields ?? [],
          compatibilityWindowMs: payload.compatibilityWindowMs,
          windowDeadline: payload.windowDeadline,
          check: payload.check ?? null,
          migrationPlan: payload.migrationPlan ?? null
        });
        break;
      }
      case 'ACTOR_REGISTERED': {
        const subject = state.subjects[payload.subject];
        subject.actors[payload.actor.name] = { ...payload.actor, active: true };
        break;
      }
      case 'ACTOR_HEARTBEAT': {
        const actor = state.subjects[payload.subject].actors[payload.name];
        if (actor) actor.lastHeartbeat = payload.at;
        break;
      }
      case 'ACTOR_DEREGISTERED': {
        const actor = state.subjects[payload.subject].actors[payload.name];
        if (actor) actor.active = false;
        break;
      }
      case 'RECORD_WRITTEN': {
        state.records[payload.subject].push(payload.record);
        state.subjects[payload.subject].nextRecordId = payload.record.id;
        break;
      }
      case 'MIGRATION_APPLIED': {
        const existing = state.migrations[payload.subject] ?? { steps: {}, irreversible: false };
        for (const step of payload.steps) {
          existing.steps[step.key] = {
            ...step,
            appliedAt: payload.at
          };
        }
        existing.irreversible = existing.irreversible || Boolean(payload.irreversible);
        existing.updatedAt = payload.at;
        state.migrations[payload.subject] = existing;
        break;
      }
      case 'WINDOW_EXTENDED': {
        const v = state.subjects[payload.subject].versions.find(
          (x) => x.version === payload.version
        );
        if (v) v.windowDeadline = payload.newDeadline;
        break;
      }
      default:
        break;
    }

    state.audit.push({ seq, type, at, subject: payload.subject ?? null });
    if (state.audit.length > AUDIT_LIMIT) {
      state.audit.splice(0, state.audit.length - AUDIT_LIMIT);
    }
  }

  #persist(type, payload) {
    const event = this.#store.append(type, payload);
    this.applyEvent(this.#state, event);
    if (this.#snapshotEvery > 0 && event.seq % this.#snapshotEvery === 0) {
      this.#store.saveSnapshot(this.#state);
      this.#store.truncateBefore(event.seq);
    }
    return event;
  }

  // ---------- 查询辅助 ----------

  #requireSubject(name) {
    const subject = this.#state.subjects[name];
    if (!subject) {
      throw new RegistryError(
        ErrorCode.SUBJECT_NOT_FOUND,
        `主题不存在: ${name}`
      );
    }
    return subject;
  }

  #requireActor(subject, name) {
    const actor = subject.actors[name];
    if (!actor) {
      throw new RegistryError(
        ErrorCode.ACTOR_NOT_FOUND,
        `生产者/消费者未注册: ${name}`
      );
    }
    return actor;
  }

  #versionSchema(subject, version) {
    const v = subject.versions.find((x) => x.version === version);
    if (!v) {
      throw new RegistryError(
        ErrorCode.VERSION_NOT_FOUND,
        `版本不存在: ${version}`
      );
    }
    return v;
  }

  listSubjects() {
    return Object.values(this.#state.subjects).map((s) => this.describeSubject(s.name));
  }

  // ---------- 主题与参与者 ----------

  createSubject({ name, compatibilityMode = CompatibilityMode.BACKWARD }) {
    if (!name || typeof name !== 'string') {
      throw new RegistryError(ErrorCode.INVALID_REQUEST, '主题名称必填');
    }
    if (!Object.values(CompatibilityMode).includes(compatibilityMode)) {
      throw new RegistryError(
        ErrorCode.INVALID_REQUEST,
        `未知兼容策略: ${compatibilityMode}`
      );
    }
    if (this.#state.subjects[name]) {
      throw new RegistryError(
        ErrorCode.SUBJECT_EXISTS,
        `主题已存在: ${name}`
      );
    }
    this.#persist('SUBJECT_CREATED', { name, compatibilityMode });
    return this.describeSubject(name);
  }

  registerActor(subjectName, { name, role, mode, schemaVersion }) {
    if (role !== 'producer' && role !== 'consumer') {
      throw new RegistryError(
        ErrorCode.INVALID_REQUEST,
        'role 必须是 producer 或 consumer'
      );
    }
    if (!Object.values(CompatibilityMode).includes(mode)) {
      throw new RegistryError(
        ErrorCode.INVALID_REQUEST,
        `未知兼容策略: ${mode}`
      );
    }
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      if (subject.actors[name]) {
        throw new RegistryError(
          ErrorCode.ACTOR_EXISTS,
          `参与者已存在: ${name}`
        );
      }
      this.#versionSchema(subject, schemaVersion);
      const actor = {
        name,
        role,
        mode,
        schemaVersion,
        registeredAt: this.#clock.now(),
        lastHeartbeat: this.#clock.now()
      };
      this.#persist('ACTOR_REGISTERED', { subject: subjectName, actor });
      return { ...actor, active: true };
    });
  }

  heartbeat(subjectName, actorName) {
    const subject = this.#requireSubject(subjectName);
    this.#requireActor(subject, actorName);
    const at = this.#clock.now();
    this.#persist('ACTOR_HEARTBEAT', { subject: subjectName, name: actorName, at });
    return { name: actorName, lastHeartbeat: at };
  }

  deregisterActor(subjectName, actorName) {
    const subject = this.#requireSubject(subjectName);
    this.#requireActor(subject, actorName);
    this.#persist('ACTOR_DEREGISTERED', {
      subject: subjectName,
      name: actorName
    });
  }

  // ---------- 模式发布（三个闸门） ----------

  /**
   * 发布新版本。发布前依次检查：
   *  1. 存量数据闸门：FORWARD 方向破坏若真实命中历史记录，必须附带覆盖全部问题的迁移计划；
   *  2. 活跃消费者闸门：每个活跃消费者按其声明的兼容策略分别判定，任一不通过即阻断；
   *  3. 迁移计划闸门：计划中的 key 必须覆盖全部数据影响项。
   * 活跃生产者不阻断发布，而是通过兼容窗口到期后阻断其写入来治理。
   */
  async registerVersion(
    subjectName,
    schemaInput,
    {
      publishedBy = 'api',
      compatibilityWindowMs = DEFAULT_WINDOW_MS,
      migrationPlan = null
    } = {}
  ) {
    const subject = this.#requireSubject(subjectName);
    return this.#locks.run(subjectName, () => {
      const schema = normalizeSchema(schemaInput);
      const latest = subject.versions.at(-1);
      if (latest && fingerprint(latest.schema) === fingerprint(schema)) {
        throw new RegistryError(
          ErrorCode.CONFLICT,
          '新模式与当前最新版本完全相同，无需发布新版本'
        );
      }

      let check = null;
      if (latest) {
        check = this.#evaluatePublish(subject, latest, schema, migrationPlan);
      }

      const version = latest ? latest.version + 1 : 1;
      const now = this.#clock.now();
      this.#persist('VERSION_PUBLISHED', {
        subject: subjectName,
        version,
        kind: 'evolution',
        schema,
        publishedBy,
        createdAt: now,
        previousVersion: latest?.version ?? null,
        compatibilityWindowMs,
        windowDeadline: now + compatibilityWindowMs,
        check,
        migrationPlan: check?.acceptedPlan ?? null
      });
      return { version: this.#versionSchema(subject, version), check };
    });
  }

  #evaluatePublish(subject, latest, schema, migrationPlan) {
    // 主题级三种方向全部计算，页面与默认策略判定各取所需
    const backward = checkCompatibility(latest.schema, schema, CompatibilityMode.BACKWARD);
    const forward = checkCompatibility(latest.schema, schema, CompatibilityMode.FORWARD);
    const full = checkCompatibility(latest.schema, schema, CompatibilityMode.FULL);

    // 闸门 1：存量数据 —— 只统计真实命中历史记录的破坏项
    const records = this.#state.records[subject.name] ?? [];
    const dataViolations = evaluateDataImpact(
      latest.schema,
      schema,
      records,
      forward.violations
    );
    const blockingData = dataViolations.filter((v) => v.dataImpacting);

    // 闸门 3：迁移计划校验
    let acceptedPlan = null;
    if (blockingData.length > 0) {
      if (!migrationPlan || !Array.isArray(migrationPlan.steps) || migrationPlan.steps.length === 0) {
        throw new RegistryError(
          ErrorCode.MIGRATION_PLAN_REQUIRED,
          '存量数据会被新版本破坏，必须提供迁移计划',
          { blockingData }
        );
      }
      const planByKey = new Map(migrationPlan.steps.map((s) => [s.key, s]));
      const missing = blockingData.filter((v) => !planByKey.has(v.migrationKey));
      if (missing.length > 0) {
        throw new RegistryError(
          ErrorCode.MIGRATION_PLAN_INCOMPLETE,
          '迁移计划未覆盖全部受影响的数据项',
          {
            missing: missing.map((v) => ({
              key: v.migrationKey,
              field: v.field,
              affectedRecordIds: v.affectedRecordIds
            }))
          }
        );
      }
      acceptedPlan = migrationPlan.steps.map((step) => ({
        key: step.key,
        description: step.description ?? '',
        transformation: step.transformation ?? null,
        status: 'planned'
      }));
    }

    // 闸门 2：活跃消费者按各自策略判定
    const consumerResults = [];
    const consumerBlockers = [];
    for (const actor of Object.values(subject.actors)) {
      if (!actor.active || actor.role !== 'consumer') continue;
      const actorVersion = this.#versionSchema(subject, actor.schemaVersion);
      const result = checkCompatibility(actorVersion.schema, schema, actor.mode);
      const row = {
        actor: actor.name,
        mode: actor.mode,
        schemaVersion: actor.schemaVersion,
        compatible: result.compatible,
        violations: result.violations
      };
      consumerResults.push(row);
      if (!result.compatible) consumerBlockers.push(row);
    }
    if (consumerBlockers.length > 0) {
      throw new RegistryError(
        ErrorCode.COMPATIBILITY_VIOLATION,
        '存在不兼容的活跃消费者，发布被阻断',
        { consumerBlockers, dataViolations }
      );
    }

    // 活跃生产者结果仅记录，不阻断；交给兼容窗口治理
    const producerResults = [];
    for (const actor of Object.values(subject.actors)) {
      if (!actor.active || actor.role !== 'producer') continue;
      const actorVersion = this.#versionSchema(subject, actor.schemaVersion);
      const result = checkCompatibility(actorVersion.schema, schema, actor.mode);
      producerResults.push({
        actor: actor.name,
        mode: actor.mode,
        schemaVersion: actor.schemaVersion,
        compatible: result.compatible,
        violations: result.violations
      });
    }

    const summarize = (r) => ({
      compatible: r.compatible,
      violationCount: r.violations.length,
      violations: r.violations
    });

    return {
      evaluatedAt: this.#clock.now(),
      subjectMode: subject.compatibilityMode,
      subjectModeCompatible:
        subject.compatibilityMode === CompatibilityMode.NONE
          ? true
          : (subject.compatibilityMode === CompatibilityMode.BACKWARD
              ? backward.compatible
              : subject.compatibilityMode === CompatibilityMode.FORWARD
                ? forward.compatible
                : full.compatible),
      backward: summarize(backward),
      forward: summarize(forward),
      full: summarize(full),
      dataViolations,
      consumerResults,
      producerResults,
      acceptedPlan
    };
  }

  /** 登记迁移计划已执行；irreversible=true 后该主题禁止回滚。 */
  applyMigration(subjectName, steps, { irreversible = false } = {}) {
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new RegistryError(
          ErrorCode.INVALID_REQUEST,
          '迁移步骤不能为空'
        );
      }
      const normalized = steps.map((s) => {
        if (!s.key) {
          throw new RegistryError(ErrorCode.INVALID_REQUEST, '迁移步骤缺少 key');
        }
        return {
          key: s.key,
          description: s.description ?? '',
          transformation: s.transformation ?? null
        };
      });
      this.#persist('MIGRATION_APPLIED', {
        subject: subject.name,
        steps: normalized,
        irreversible,
        at: this.#clock.now()
      });
      return this.#state.migrations[subjectName];
    });
  }

  /** 延长某版本的兼容窗口（迁移未完成时的缓冲手段）。 */
  extendWindow(subjectName, version, extraMs) {
    if (!Number.isInteger(extraMs) || extraMs <= 0) {
      throw new RegistryError(ErrorCode.INVALID_REQUEST, '延长时长必须是正整数毫秒');
    }
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      const v = this.#versionSchema(subject, version);
      const newDeadline = v.windowDeadline + extraMs;
      this.#persist('WINDOW_EXTENDED', {
        subject: subjectName,
        version,
        newDeadline
      });
      return { version, windowDeadline: newDeadline };
    });
  }

  // ---------- 兼容窗口与写入 ----------

  /** 判定某生产者当前是否允许写入；窗口到期且落后于最新版本即阻断。 */
  checkProduce(subjectName, actorName) {
    return this.#locks.run(subjectName, () =>
      this.#checkProduceLocked(subjectName, actorName)
    );
  }

  #checkProduceLocked(subjectName, actorName) {
    const subject = this.#requireSubject(subjectName);
    const actor = this.#requireActor(subject, actorName);
    if (actor.role !== 'producer') {
      throw new RegistryError(ErrorCode.INVALID_REQUEST, `${actorName} 不是生产者`);
    }
    const latest = subject.versions.at(-1);
    const now = this.#clock.now();
    const behind = actor.schemaVersion < latest.version;
    const expired = now > latest.windowDeadline;
    if (behind && expired) {
      throw new RegistryError(
        ErrorCode.OLD_PRODUCER_BLOCKED,
        `生产者 ${actorName} 仍停留在 v${actor.schemaVersion}，兼容窗口已于 ${new Date(
          latest.windowDeadline
        ).toISOString()} 到期，请升级到 v${latest.version}`,
        {
          actor: actorName,
          actorVersion: actor.schemaVersion,
          currentVersion: latest.version,
          windowDeadline: latest.windowDeadline
        }
      );
    }
    return {
      allowed: true,
      actorVersion: actor.schemaVersion,
      currentVersion: latest.version,
      windowDeadline: latest.windowDeadline,
      windowRemainingMs: Math.max(0, latest.windowDeadline - now)
    };
  }

  /** 生产者写入：先过窗口闸门，再按其注册版本的模式校验，最后持久化。 */
  produce(subjectName, actorName, payload) {
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      const actor = this.#requireActor(subject, actorName);
      this.#checkProduceLocked(subjectName, actorName);
      const actorVersion = this.#versionSchema(subject, actor.schemaVersion);
      validateRecord(actorVersion.schema, payload);
      const record = {
        id: subject.nextRecordId + 1,
        subject: subjectName,
        payload,
        writtenBy: actorName,
        writtenAt: this.#clock.now(),
        schemaVersion: actor.schemaVersion
      };
      this.#persist('RECORD_WRITTEN', { subject: subjectName, record });
      return record;
    });
  }

  /** 无参与者的直接写入（种子/运维通道），按指定或最新版本模式校验。 */
  ingestRecord(subjectName, payload, { schemaVersion, writtenBy = 'system' } = {}) {
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      const version = this.#versionSchema(
        subject,
        schemaVersion ?? subject.versions.at(-1).version
      );
      validateRecord(version.schema, payload);
      const record = {
        id: subject.nextRecordId + 1,
        subject: subjectName,
        payload,
        writtenBy,
        writtenAt: this.#clock.now(),
        schemaVersion: version.version
      };
      this.#persist('RECORD_WRITTEN', { subject: subjectName, record });
      return record;
    });
  }

  listRecords(subjectName) {
    this.#requireSubject(subjectName);
    return this.#state.records[subjectName] ?? [];
  }

  // ---------- 回滚（保留新字段） ----------

  /**
   * 回滚到历史版本。
   * - 已执行不可逆迁移时禁止回滚；
   * - 当前版本相对目标版本新增的字段作为“透传字段”保留（可选 + 默认值），
   *   历史记录里的这些字段不会丢失，老生产者也能继续写入；
   * - 回滚是显式运维动作，绕过常规兼容闸门，但仍生成完整兼容检查结果用于展示。
   */
  rollback(subjectName, targetVersion, { compatibilityWindowMs = DEFAULT_WINDOW_MS } = {}) {
    return this.#locks.run(subjectName, () => {
      const subject = this.#requireSubject(subjectName);
      const target = this.#versionSchema(subject, targetVersion);
      const latest = subject.versions.at(-1);
      if (latest.version === targetVersion) {
        throw new RegistryError(
          ErrorCode.CONFLICT,
          `v${targetVersion} 已经是当前版本，无需回滚`
        );
      }
      const migration = this.#state.migrations[subjectName];
      if (migration?.irreversible) {
        throw new RegistryError(
          ErrorCode.IRREVERSIBLE_MIGRATION,
          '已执行不可逆迁移，无法回滚',
          { appliedSteps: Object.keys(migration.steps) }
        );
      }

      const targetNames = new Set(target.schema.fields.map((f) => f.name));
      const retainedFields = latest.schema.fields
        .filter((f) => !targetNames.has(f.name))
        .map((f) => ({
          name: f.name,
          type: f.type,
          symbols: f.symbols,
          // 优先沿用字段原有默认值，保证回滚后语义不漂移；无默认值时按类型补安全值
          default: f.default !== undefined ? f.default : safeDefaultFor(f)
        }));

      const rollbackSchema = normalizeSchema({
        name: target.schema.name,
        fields: [
          ...target.schema.fields,
          ...retainedFields.map((f) => ({
            name: f.name,
            type: f.type,
            symbols: f.symbols,
            required: false,
            default: f.default
          }))
        ]
      });

      const check = this.#evaluateRollbackCheck(subject, latest, rollbackSchema);
      const version = latest.version + 1;
      const now = this.#clock.now();
      this.#persist('VERSION_PUBLISHED', {
        subject: subjectName,
        version,
        kind: 'rollback',
        schema: rollbackSchema,
        publishedBy: 'rollback',
        createdAt: now,
        previousVersion: latest.version,
        rollbackOf: targetVersion,
        retainedFields: retainedFields.map((f) => f.name),
        compatibilityWindowMs,
        windowDeadline: now + compatibilityWindowMs,
        check
      });
      return this.#versionSchema(subject, version);
    });
  }

  #evaluateRollbackCheck(subject, latest, rollbackSchema) {
    const backward = checkCompatibility(
      latest.schema,
      rollbackSchema,
      CompatibilityMode.BACKWARD
    );
    const forward = checkCompatibility(
      latest.schema,
      rollbackSchema,
      CompatibilityMode.FORWARD
    );
    const full = checkCompatibility(
      latest.schema,
      rollbackSchema,
      CompatibilityMode.FULL
    );
    const summarize = (r) => ({
      compatible: r.compatible,
      violationCount: r.violations.length,
      violations: r.violations
    });
    return {
      evaluatedAt: this.#clock.now(),
      gateBypassed: true,
      note: '回滚为显式运维操作，绕过发布闸门；新增字段以可选透传字段保留',
      backward: summarize(backward),
      forward: summarize(forward),
      full: summarize(full)
    };
  }

  // ---------- 页面视图模型 ----------

  describeSubject(name) {
    const subject = this.#requireSubject(name);
    const now = this.#clock.now();
    const latest = subject.versions.at(-1);

    const versions = subject.versions.map((v) => ({
      version: v.version,
      kind: v.kind,
      publishedBy: v.publishedBy,
      createdAt: v.createdAt,
      previousVersion: v.previousVersion,
      rollbackOf: v.rollbackOf,
      retainedFields: v.retainedFields,
      fieldCount: v.schema.fields.length,
      compatibilityWindowMs: v.compatibilityWindowMs,
      windowDeadline: v.windowDeadline,
      windowExpired: now > v.windowDeadline,
      windowRemainingMs: Math.max(0, v.windowDeadline - now),
      check: v.check,
      migrationPlan: v.migrationPlan,
      schema: v.schema
    }));

    const actors = Object.values(subject.actors).map((a) => {
      const behind = latest ? a.schemaVersion < latest.version : false;
      const blockedNow =
        a.role === 'producer' && behind && now > latest.windowDeadline;
      return {
        ...a,
        behindLatest: behind,
        blockedNow
      };
    });

    return {
      name: subject.name,
      compatibilityMode: subject.compatibilityMode,
      currentVersion: latest?.version ?? null,
      versions,
      actors,
      recordCount: (this.#state.records[name] ?? []).length,
      migration: this.#state.migrations[name] ?? null,
      audit: this.#state.audit.filter((e) => e.subject === name).slice(-20).reverse()
    };
  }

  getVersion(subjectName, version) {
    const subject = this.#requireSubject(subjectName);
    return this.#versionSchema(subject, version);
  }

  /** 强制写快照（测试与优雅关停使用）。 */
  checkpoint() {
    this.#store.saveSnapshot(this.#state);
  }
}
