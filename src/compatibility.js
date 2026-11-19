import { isWidening } from './schema.js';

/**
 * 兼容性方向（以模式演进 oldSchema → newSchema 为基准）：
 * - BACKWARD（向后兼容）：新数据要能被老读取方读 —— 老消费者/老读取视角。
 * - FORWARD（向前兼容）：新读取方要能读老数据 —— 升级后的读取方视角。
 * - FULL（全兼容）：两个方向都必须通过。
 *
 * 生产者/消费者分别声明自己的策略：
 *  - 生产者 BACKWARD：演进模式时保证老消费者可读（最常见）。
 *  - 生产者 FORWARD：保证未来读取方也能读它产出的数据。
 *  - 消费者 BACKWARD：能读“比自己注册版本更新”的数据。
 *  - 消费者 FORWARD：能读“比自己注册版本更旧”的数据。
 */
export const CompatibilityMode = Object.freeze({
  BACKWARD: 'BACKWARD',
  FORWARD: 'FORWARD',
  FULL: 'FULL',
  NONE: 'NONE'
});

export const ViolationCode = Object.freeze({
  FIELD_ADDED_REQUIRED: 'FIELD_ADDED_REQUIRED',
  FIELD_REMOVED: 'FIELD_REMOVED',
  FIELD_TYPE_CHANGED: 'FIELD_TYPE_CHANGED',
  FIELD_BECAME_REQUIRED: 'FIELD_BECAME_REQUIRED',
  FIELD_BECAME_OPTIONAL: 'FIELD_BECAME_OPTIONAL',
  ENUM_SYMBOL_ADDED: 'ENUM_SYMBOL_ADDED',
  ENUM_SYMBOL_REMOVED: 'ENUM_SYMBOL_REMOVED'
});

/** 计算 old → new 的结构化差异（按字段名对齐），始终以演进方向为基准。 */
export function diffSchemas(oldSchema, newSchema) {
  const oldByName = new Map(oldSchema.fields.map((f) => [f.name, f]));
  const newByName = new Map(newSchema.fields.map((f) => [f.name, f]));
  const changes = [];

  for (const field of newSchema.fields) {
    const before = oldByName.get(field.name);
    if (!before) {
      changes.push({ kind: 'field-added', field: field.name, newField: field });
      continue;
    }
    if (before.type !== field.type) {
      changes.push({
        kind: 'field-type-changed',
        field: field.name,
        fromType: before.type,
        toType: field.type,
        widened: isWidening(before.type, field.type)
      });
    }
    if (before.required !== field.required) {
      changes.push({
        kind: field.required ? 'field-became-required' : 'field-became-optional',
        field: field.name
      });
    }
    if (before.type === 'enum' && field.type === 'enum') {
      const beforeSymbols = new Set(before.symbols);
      const afterSymbols = new Set(field.symbols);
      for (const symbol of field.symbols) {
        if (!beforeSymbols.has(symbol)) {
          changes.push({ kind: 'enum-symbol-added', field: field.name, symbol });
        }
      }
      for (const symbol of before.symbols) {
        if (!afterSymbols.has(symbol)) {
          changes.push({ kind: 'enum-symbol-removed', field: field.name, symbol });
        }
      }
    }
  }

  for (const field of oldSchema.fields) {
    if (!newByName.has(field.name)) {
      changes.push({ kind: 'field-removed', field: field.name, oldField: field });
    }
  }

  return changes;
}

function makeViolation(code, change, direction, message) {
  return {
    code,
    field: change.field,
    symbol: change.symbol,
    fromType: change.fromType,
    toType: change.toType,
    direction,
    message
  };
}

/**
 * 基于同一份 old→new 差异，按方向解释破坏项。
 * 方向只决定“哪种变化对该读取视角有害”，避免交换参数带来的规则反转。
 */
function evaluate(changes, direction) {
  const violations = [];
  const push = (code, change, message) =>
    violations.push(makeViolation(code, change, direction, message));

  for (const change of changes) {
    switch (change.kind) {
      case 'field-added': {
        const f = change.newField;
        if (direction === CompatibilityMode.BACKWARD) {
          // 老读取方不认识新字段；必填且无默认值时无法跳过。
          if (f.required && f.default === undefined) {
            push(
              ViolationCode.FIELD_ADDED_REQUIRED,
              change,
              `新增必填字段 ${f.name} 且无默认值，旧读取方无法处理`
            );
          }
        } else {
          // FORWARD：新读取方要求该字段，而旧数据里根本没有它。
          if (f.required && f.default === undefined) {
            push(
              ViolationCode.FIELD_ADDED_REQUIRED,
              change,
              `新增必填字段 ${f.name}，旧数据缺失且无默认值`
            );
          }
        }
        break;
      }
      case 'field-removed': {
        if (direction === CompatibilityMode.FORWARD) {
          // 新读取方期待该字段，旧数据里没有；必填字段才构成破坏。
          if (change.oldField.required) {
            push(
              ViolationCode.FIELD_REMOVED,
              change,
              `必填字段 ${change.field} 被移除，新读取方在旧数据中读不到它`
            );
          }
        }
        // BACKWARD：老读取方不需要新数据中已消失的字段，无破坏
        break;
      }
      case 'field-type-changed': {
        // BACKWARD（老 reader 读新 writer 值）：old→new 拓宽才安全。
        // FORWARD（新 reader 读旧 writer 值）：需要 new→old 拓宽，即 old→new 收窄才安全。
        const safe =
          direction === CompatibilityMode.BACKWARD
            ? change.widened
            : isWidening(change.toType, change.fromType);
        if (!safe) {
          push(
            ViolationCode.FIELD_TYPE_CHANGED,
            change,
            `字段 ${change.field} 类型由 ${change.fromType} 变为 ${change.toType}`
          );
        }
        break;
      }
      case 'field-became-required': {
        if (direction === CompatibilityMode.FORWARD) {
          push(
            ViolationCode.FIELD_BECAME_REQUIRED,
            change,
            `字段 ${change.field} 变为必填，旧数据可能缺失`
          );
        }
        break;
      }
      case 'field-became-optional': {
        if (direction === CompatibilityMode.BACKWARD) {
          push(
            ViolationCode.FIELD_BECAME_OPTIONAL,
            change,
            `字段 ${change.field} 变为可选，旧读取方仍按必填处理`
          );
        }
        break;
      }
      case 'enum-symbol-added': {
        if (direction === CompatibilityMode.BACKWARD) {
          push(
            ViolationCode.ENUM_SYMBOL_ADDED,
            change,
            `枚举字段 ${change.field} 新增取值 ${change.symbol}，旧读取方无法识别`
          );
        }
        break;
      }
      case 'enum-symbol-removed': {
        if (direction === CompatibilityMode.FORWARD) {
          push(
            ViolationCode.ENUM_SYMBOL_REMOVED,
            change,
            `枚举字段 ${change.field} 删除取值 ${change.symbol}，旧数据仍可能包含它`
          );
        }
        break;
      }
      default:
        break;
    }
  }

  return { direction, compatible: violations.length === 0, violations, changes };
}

/**
 * 按策略模式评估 oldSchema → newSchema 的演进。
 * @returns {{mode, compatible, violations, backward, forward}}
 */
export function checkCompatibility(oldSchema, newSchema, mode) {
  if (mode === CompatibilityMode.NONE) {
    return { mode, compatible: true, violations: [], backward: null, forward: null };
  }

  const changes = diffSchemas(oldSchema, newSchema);
  const backward = evaluate(changes, CompatibilityMode.BACKWARD);
  const forward = evaluate(changes, CompatibilityMode.FORWARD);

  let compatible;
  let violations;
  if (mode === CompatibilityMode.BACKWARD) {
    compatible = backward.compatible;
    violations = backward.violations;
  } else if (mode === CompatibilityMode.FORWARD) {
    compatible = forward.compatible;
    violations = forward.violations;
  } else {
    compatible = backward.compatible && forward.compatible;
    violations = [...backward.violations, ...forward.violations];
  }

  return { mode, compatible, violations, backward, forward };
}

/** 单条旧记录在新读取方下的取值问题（用于存量数据闸门的精确判定）。 */
function recordValueProblems(oldSchema, newSchema, record) {
  const problems = [];
  const oldNames = new Set(oldSchema.fields.map((f) => f.name));
  for (const field of newSchema.fields) {
    const has = Object.prototype.hasOwnProperty.call(record, field.name);
    if (!has) {
      // 旧记录缺值：新增字段归类为 FIELD_ADDED_REQUIRED，存量字段则为 FIELD_BECAME_REQUIRED。
      if (field.required && field.default === undefined) {
        problems.push({
          code: oldNames.has(field.name)
            ? ViolationCode.FIELD_BECAME_REQUIRED
            : ViolationCode.FIELD_ADDED_REQUIRED,
          field: field.name
        });
      }
      continue;
    }
    const value = record[field.name];
    if (!valueMatches(field, value)) {
      problems.push({
        code: ViolationCode.FIELD_TYPE_CHANGED,
        field: field.name,
        toType: field.type
      });
    }
    if (field.type === 'enum' && !field.symbols.includes(value)) {
      problems.push({
        code: ViolationCode.ENUM_SYMBOL_REMOVED,
        field: field.name,
        symbol: value
      });
    }
  }
  return problems;
}

function valueMatches(field, value) {
  switch (field.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'int':
    case 'long':
      return Number.isInteger(value);
    case 'float':
    case 'double':
      return typeof value === 'number';
    case 'enum':
      return field.symbols.includes(value);
    default:
      return false;
  }
}

const problemKey = (p) =>
  p.symbol !== undefined ? `${p.code}:${p.field}:${p.symbol}` : `${p.code}:${p.field}`;

/**
 * 存量数据闸门：把 FORWARD 方向的理论破坏与真实记录比对，
 * 仅当至少一条历史记录确实受影响时才算阻断性问题。
 *
 * @returns 带 dataImpacting/affectedRecordIds/migrationKey 的违规列表
 */
export function evaluateDataImpact(oldSchema, newSchema, records, forwardViolations) {
  const theoretical = new Map();
  for (const v of forwardViolations) {
    const key =
      v.symbol !== undefined ? `${v.code}:${v.field}:${v.symbol}` : `${v.code}:${v.field}`;
    theoretical.set(key, v);
  }

  const impacted = new Map();
  for (const record of records) {
    for (const problem of recordValueProblems(oldSchema, newSchema, record.payload)) {
      const key = problemKey(problem);
      if (!theoretical.has(key)) continue;
      if (!impacted.has(key)) {
        impacted.set(key, {
          ...theoretical.get(key),
          dataImpacting: true,
          affectedRecordIds: [],
          migrationKey: key
        });
      }
      impacted.get(key).affectedRecordIds.push(record.id);
    }
  }

  return forwardViolations.map((v) => {
    const key =
      v.symbol !== undefined ? `${v.code}:${v.field}:${v.symbol}` : `${v.code}:${v.field}`;
    const hit = impacted.get(key);
    return hit ?? { ...v, dataImpacting: false, affectedRecordIds: [], migrationKey: key };
  });
}
