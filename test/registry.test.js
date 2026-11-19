import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchemaRegistry } from '../src/registry.js';
import { EventStore, rawWalLineCount, snapshotExists } from '../src/store.js';
import { FakeClock } from '../src/clock.js';
import { ErrorCode, RegistryError } from '../src/errors.js';
import { CompatibilityMode } from '../src/compatibility.js';

const v1Schema = () => ({
  name: 'OrderEvent',
  fields: [
    { name: 'orderId', type: 'string', required: true },
    { name: 'amount', type: 'long', required: true }
  ]
});

async function expectError(code, fn) {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof RegistryError);
    assert.equal(err.code, code);
    return true;
  });
}

function newRegistry(clock = new FakeClock()) {
  // dir=null -> 纯内存 EventStore，专注业务语义
  const { registry } = SchemaRegistry.recover({ dir: null, clock, snapshotEvery: 0 });
  return registry;
}

async function bootstrap(clock = new FakeClock()) {
  const registry = newRegistry(clock);
  registry.createSubject({ name: 'orders', compatibilityMode: CompatibilityMode.BACKWARD });
  const r = await registry.registerVersion('orders', v1Schema());
  return { registry, clock, v1: r.version.version };
}

describe('模式发布三闸门', () => {
  let registry;
  beforeEach(async () => {
    registry = newRegistry();
  });

  it('初始模式直接发布为 v1', async () => {
    registry.createSubject({ name: 't' });
    const { version } = await registry.registerVersion('t', v1Schema());
    assert.equal(version.version, 1);
    assert.equal(version.check, null);
  });

  it('存量数据闸门：新增必填字段命中历史记录且无迁移计划 -> 阻断', async () => {
    registry.createSubject({ name: 't' });
    await registry.registerVersion('t', v1Schema());
    await registry.ingestRecord('t', { orderId: 'o-1', amount: 100 });

    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string', required: true },
        { name: 'amount', type: 'long', required: true },
        { name: 'tenant', type: 'string', required: true }
      ]
    };
    await expectError(ErrorCode.MIGRATION_PLAN_REQUIRED, () =>
      registry.registerVersion('t', v3)
    );
  });

  it('迁移计划 key 未覆盖全部数据项 -> MIGRATION_PLAN_INCOMPLETE', async () => {
    registry.createSubject({ name: 't' });
    await registry.registerVersion('t', v1Schema());
    await registry.ingestRecord('t', { orderId: 'o-1', amount: 100 });
    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'tenant', type: 'string' }
      ]
    };
    await expectError(ErrorCode.MIGRATION_PLAN_INCOMPLETE, () =>
      registry.registerVersion('t', v3, {
        migrationPlan: { steps: [{ key: 'WRONG:KEY', description: 'x' }] }
      })
    );
  });

  it('迁移计划覆盖全部影响项后发布成功，并记录数据违规明细', async () => {
    registry.createSubject({ name: 't' });
    await registry.registerVersion('t', v1Schema());
    await registry.ingestRecord('t', { orderId: 'o-1', amount: 100 });
    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'tenant', type: 'string' }
      ]
    };
    const { version, check } = await registry.registerVersion('t', v3, {
      migrationPlan: {
        steps: [{ key: 'FIELD_ADDED_REQUIRED:tenant', description: '回填默认租户' }]
      }
    });
    assert.equal(version.version, 2);
    const impacting = check.dataViolations.filter((v) => v.dataImpacting);
    assert.equal(impacting.length, 1);
    assert.deepEqual(impacting[0].affectedRecordIds, [1]);
    assert.equal(check.acceptedPlan.length, 1);
  });

  it('没有存量记录时，相同的破坏性演进可直接发布', async () => {
    registry.createSubject({ name: 't' });
    await registry.registerVersion('t', v1Schema());
    const v3 = {
      name: 'OrderEvent',
      fields: [{ name: 'orderId', type: 'string' }, { name: 'tenant', type: 'string' }]
    };
    const { version } = await registry.registerVersion('t', v3);
    assert.equal(version.version, 2);
  });

  it('活跃消费者闸门：FORWARD 消费者遇到必填新增 -> 阻断发布', async () => {
    const { registry: r } = await bootstrap();
    await r.registerActor('orders', {
      name: 'c1',
      role: 'consumer',
      mode: CompatibilityMode.FORWARD,
      schemaVersion: 1
    });
    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'tenant', type: 'string' }
      ]
    };
    await expectError(ErrorCode.COMPATIBILITY_VIOLATION, () =>
      r.registerVersion('orders', v3)
    );
  });

  it('BACKWARD 消费者不受新增可选字段影响，发布通过', async () => {
    const { registry: r } = await bootstrap();
    await r.registerActor('orders', {
      name: 'c1',
      role: 'consumer',
      mode: CompatibilityMode.BACKWARD,
      schemaVersion: 1
    });
    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'note', type: 'string', required: false, default: '' }
      ]
    };
    const { version, check } = await r.registerVersion('orders', v3);
    assert.equal(version.version, 2);
    assert.equal(check.consumerResults[0].compatible, true);
  });

  it('已注销的消费者不再参与闸门判定', async () => {
    const { registry: r } = await bootstrap();
    await r.registerActor('orders', {
      name: 'c1',
      role: 'consumer',
      mode: CompatibilityMode.FORWARD,
      schemaVersion: 1
    });
    await r.deregisterActor('orders', 'c1');
    const v3 = {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'tenant', type: 'string' }
      ]
    };
    const { version } = await r.registerVersion('orders', v3);
    assert.equal(version.version, 2);
  });

  it('相同模式重复发布被拒绝', async () => {
    const { registry: r } = await bootstrap();
    await expectError(ErrorCode.CONFLICT, () => r.registerVersion('orders', v1Schema()));
  });
});

describe('兼容窗口与旧生产者阻断', () => {
  it('窗口内旧版本生产者允许写入；到期后阻断并提示升级', async () => {
    const clock = new FakeClock();
    const { registry: r } = await bootstrap(clock);
    await r.registerActor('orders', {
      name: 'p-old',
      role: 'producer',
      mode: CompatibilityMode.BACKWARD,
      schemaVersion: 1
    });
    // 发布 v2：新增可选字段，对 BACKWARD 生产者无破坏
    await r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'note', type: 'string', required: false, default: '' }
      ]
    }, { compatibilityWindowMs: 60_000 });

    clock.advance(30_000);
    const ok = await r.checkProduce('orders', 'p-old');
    assert.equal(ok.allowed, true);
    assert.equal(ok.windowRemainingMs, 30_000);
    const rec = await r.produce('orders', 'p-old', { orderId: 'o-1', amount: 9 });
    assert.equal(rec.schemaVersion, 1);

    clock.advance(30_001);
    await expectError(ErrorCode.OLD_PRODUCER_BLOCKED, () =>
      r.checkProduce('orders', 'p-old')
    );
    await expectError(ErrorCode.OLD_PRODUCER_BLOCKED, async () =>
      r.produce('orders', 'p-old', { orderId: 'o-2', amount: 9 })
    );
  });

  it('延长窗口后旧生产者恢复写入', async () => {
    const clock = new FakeClock();
    const { registry: r } = await bootstrap(clock);
    await r.registerActor('orders', {
      name: 'p-old',
      role: 'producer',
      mode: CompatibilityMode.BACKWARD,
      schemaVersion: 1
    });
    await r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'note', type: 'string', required: false, default: '' }
      ]
    }, { compatibilityWindowMs: 60_000 });

    clock.advance(61_000);
    await expectError(ErrorCode.OLD_PRODUCER_BLOCKED, () =>
      r.checkProduce('orders', 'p-old')
    );
    await r.extendWindow('orders', 2, 120_000);
    const ok = await r.checkProduce('orders', 'p-old');
    assert.equal(ok.allowed, true);
    assert.equal(ok.windowRemainingMs, 119_000);
  });

  it('已升级到最新版本的生产者不受窗口影响', async () => {
    const clock = new FakeClock();
    const { registry: r } = await bootstrap(clock);
    await r.registerActor('orders', {
      name: 'p-new',
      role: 'producer',
      mode: CompatibilityMode.BACKWARD,
      schemaVersion: 1
    });
    await r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'note', type: 'string', required: false, default: '' }
      ]
    }, { compatibilityWindowMs: 1_000 });
    // 注册第二个直接基于 v2 的生产者
    await r.registerActor('orders', {
      name: 'p-current',
      role: 'producer',
      mode: CompatibilityMode.BACKWARD,
      schemaVersion: 2
    });
    clock.advance(10_000);
    const ok = await r.checkProduce('orders', 'p-current');
    assert.equal(ok.allowed, true);
    await expectError(ErrorCode.OLD_PRODUCER_BLOCKED, () =>
      r.checkProduce('orders', 'p-new')
    );
  });
});

describe('回滚保留新字段', () => {
  it('回滚后新增字段成为可选透传字段，历史数据不丢失且可继续写入', async () => {
    const { registry: r } = await bootstrap();
    // v2 新增必填带默认值的字段（兼容发布）
    await r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'region', type: 'string', required: true, default: 'cn' }
      ]
    });
    await r.ingestRecord('orders', { orderId: 'o-1', amount: 100, region: 'us' });

    const rolled = await r.rollback('orders', 1);
    assert.equal(rolled.version, 3);
    assert.equal(rolled.kind, 'rollback');
    assert.equal(rolled.rollbackOf, 1);
    assert.deepEqual(rolled.retainedFields, ['region']);

    const retained = rolled.schema.fields.find((f) => f.name === 'region');
    assert.equal(retained.required, false);
    assert.equal(retained.default, 'cn');

    // 老生产者按回滚后的基础字段写入，不会因缺少 region 被拒绝
    const oldProducerRecord = await r.ingestRecord('orders', { orderId: 'o-2', amount: 50 });
    assert.equal(oldProducerRecord.id, 2);

    // 关键断言：包含新字段的历史记录原样保留
    const records = r.listRecords('orders');
    assert.equal(records[0].payload.region, 'us');
    assert.equal(records.length, 2);

    const view = r.describeSubject('orders');
    const v3 = view.versions.find((x) => x.version === 3);
    assert.equal(v3.check.gateBypassed, true);
  });

  it('不可逆迁移执行后禁止回滚', async () => {
    const { registry: r } = await bootstrap();
    await r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'region', type: 'string', required: false, default: 'cn' }
      ]
    });
    await r.applyMigration('orders', [
      { key: 'FIELD_BECAME_REQUIRED:region', description: '全量回填' }
    ], { irreversible: true });

    await expectError(ErrorCode.IRREVERSIBLE_MIGRATION, () => r.rollback('orders', 1));
  });

  it('回滚到当前版本被拒绝', async () => {
    const { registry: r } = await bootstrap();
    await expectError(ErrorCode.CONFLICT, () => r.rollback('orders', 1));
  });
});

describe('并发发布与失败恢复', () => {
  it('并发发布获得连续不重复的版本号', async () => {
    const { registry: r } = await bootstrap();
    const builds = [2, 3, 4, 5, 6].map((n) =>
      r.registerVersion('orders', {
        name: 'OrderEvent',
        fields: [
          { name: 'orderId', type: 'string' },
          { name: 'amount', type: 'long' },
          { name: `f${n}`, type: 'string', required: false, default: '' }
        ]
      })
    );
    const results = await Promise.all(builds);
    const versions = results.map((x) => x.version.version).sort((a, b) => a - b);
    assert.deepEqual(versions, [2, 3, 4, 5, 6]);
    assert.equal(r.describeSubject('orders').versions.length, 6);
  });

  it('并发发布中失败的请求不消耗版本号', async () => {
    const { registry: r } = await bootstrap();
    await r.registerActor('orders', {
      name: 'c1',
      role: 'consumer',
      mode: CompatibilityMode.FORWARD,
      schemaVersion: 1
    });
    const breaking = r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'tenant', type: 'string' }
      ]
    });
    const safe = r.registerVersion('orders', {
      name: 'OrderEvent',
      fields: [
        { name: 'orderId', type: 'string' },
        { name: 'amount', type: 'long' },
        { name: 'note', type: 'string', required: false, default: '' }
      ]
    });
    const results = await Promise.allSettled([breaking, safe]);
    const rejected = results.filter((x) => x.status === 'rejected');
    const fulfilled = results.filter((x) => x.status === 'fulfilled');
    assert.equal(rejected.length, 1);
    assert.equal(fulfilled.length, 1);
    // 只有成功的发布占用 v2
    assert.equal(r.describeSubject('orders').currentVersion, 2);
  });

  it('WAL + 快照恢复：重启后状态完整还原', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-restore-'));
    try {
      const clock = new FakeClock();
      // 关闭周期性快照，仅靠显式 checkpoint()，确保心跳事件留在 WAL 尾部待重放
      const { registry: r1 } = SchemaRegistry.recover({ dir, clock, snapshotEvery: 0 });
      r1.createSubject({ name: 'orders' });
      await r1.registerVersion('orders', v1Schema());
      await r1.registerActor('orders', {
        name: 'p1',
        role: 'producer',
        mode: CompatibilityMode.BACKWARD,
        schemaVersion: 1
      });
      await r1.produce('orders', 'p1', { orderId: 'o-1', amount: 7 });
      await r1.registerVersion('orders', {
        name: 'OrderEvent',
        fields: [
          { name: 'orderId', type: 'string' },
          { name: 'amount', type: 'long' },
          { name: 'note', type: 'string', required: false, default: '' }
        ]
      });
      await r1.checkpoint();
      // 快照之后再产生事件，验证「快照 + WAL 尾部重放」
      await r1.heartbeat('orders', 'p1');

      const { registry: r2, recovery } = SchemaRegistry.recover({
        dir,
        clock: new FakeClock(clock.now()),
        snapshotEvery: 3
      });
      assert.ok(recovery.replayed >= 1);
      const view = r2.describeSubject('orders');
      assert.equal(view.currentVersion, 2);
      assert.equal(view.actors[0].name, 'p1');
      assert.equal(view.recordCount, 1);
      assert.equal(r2.listRecords('orders')[0].payload.orderId, 'o-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WAL 末尾半写行被识别并截断，已确认事件不丢', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-partial-'));
    try {
      const clock = new FakeClock();
      const { registry: r1 } = SchemaRegistry.recover({ dir, clock, snapshotEvery: 0 });
      r1.createSubject({ name: 'orders' });
      await r1.registerVersion('orders', v1Schema());
      const before = rawWalLineCount(dir);
      assert.equal(before, 2);

      // 模拟崩溃：向 WAL 追加一条无法解析的半截行
      const walPath = join(dir, 'wal.log');
      const raw = readFileSync(walPath, 'utf8');
      writeFileSync(walPath, raw + '{"seq":3,"type":"VERS');

      const { registry: r2, recovery } = SchemaRegistry.recover({
        dir,
        clock: new FakeClock(clock.now()),
        snapshotEvery: 0
      });
      assert.equal(recovery.recoveredPartial, true);
      assert.equal(r2.describeSubject('orders').currentVersion, 1);
      // 重放后 WAL 被截断回干净状态
      assert.equal(rawWalLineCount(dir), 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('周期性快照触发后 WAL 被压缩，仅保留快照之后的事件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sr-snap-'));
    try {
      const { registry: r } = SchemaRegistry.recover({
        dir,
        clock: new FakeClock(),
        snapshotEvery: 2
      });
      r.createSubject({ name: 'orders' }); // seq 1
      await r.registerVersion('orders', v1Schema()); // seq 2 -> 触发快照
      assert.ok(snapshotExists(dir));
      assert.equal(rawWalLineCount(dir), 0);

      await r.registerActor('orders', {
        name: 'p1',
        role: 'producer',
        mode: CompatibilityMode.BACKWARD,
        schemaVersion: 1
      }); // seq 3
      const { registry: r2 } = SchemaRegistry.recover({ dir, clock: new FakeClock() });
      assert.equal(r2.describeSubject('orders').actors.length, 1);
      assert.equal(r2.describeSubject('orders').currentVersion, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('无目录的内存模式不触碰文件系统，append 仅推进序号', () => {
    const store = new EventStore(null);
    const event = store.append('PING', { x: 1 });
    assert.equal(store.sequence, 1);
    assert.equal(event.type, 'PING');
    const { state } = store.load(() => {}, () => ({}));
    assert.deepEqual(state, {});
  });
});

describe('记录校验', () => {
  it('缺少必填字段或类型不符被拒绝', async () => {
    const { registry: r } = await bootstrap();
    await expectError(ErrorCode.INVALID_RECORD, async () =>
      r.ingestRecord('orders', { orderId: 'o-1' })
    );
    await expectError(ErrorCode.INVALID_RECORD, async () =>
      r.ingestRecord('orders', { orderId: 1, amount: 1 })
    );
  });

  it('非法模式定义被拒绝', async () => {
    const r = newRegistry();
    r.createSubject({ name: 't' });
    await expectError(ErrorCode.INVALID_SCHEMA, () =>
      r.registerVersion('t', {
        name: 'Bad',
        fields: [{ name: 'x', type: 'datetime' }]
      })
    );
  });
});
