import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCompatibility,
  CompatibilityMode,
  diffSchemas,
  evaluateDataImpact,
  ViolationCode
} from '../src/compatibility.js';
import { normalizeSchema } from '../src/schema.js';

const field = (name, type, extra = {}) => ({ name, type, required: true, ...extra });
const schema = (name, fields) => normalizeSchema({ name, fields });

const v1 = schema('Event', [field('id', 'string'), field('count', 'int')]);

describe('diffSchemas 字段级差异', () => {
  it('识别新增、类型变更与必填性变更', () => {
    const v2 = schema('Event', [
      field('id', 'string'),
      field('count', 'long', { required: false, default: 0 }),
      field('tag', 'string', { required: false, default: 'x' })
    ]);
    const kinds = diffSchemas(v1, v2).map((c) => c.kind);
    assert.ok(kinds.includes('field-added'));
    assert.ok(kinds.includes('field-type-changed'));
    assert.ok(kinds.includes('field-became-optional'));
  });

  it('识别字段删除', () => {
    const v2 = schema('Event', [field('id', 'string')]);
    const kinds = diffSchemas(v1, v2).map((c) => c.kind);
    assert.deepEqual(kinds, ['field-removed']);
  });

  it('识别枚举取值的新增与删除', () => {
    const e1 = schema('E', [field('color', 'enum', { symbols: ['RED', 'GREEN'] })]);
    const e2 = schema('E', [field('color', 'enum', { symbols: ['GREEN', 'BLUE'] })]);
    const kinds = diffSchemas(e1, e2).map((c) => `${c.kind}:${c.symbol}`);
    assert.ok(kinds.includes('enum-symbol-added:BLUE'));
    assert.ok(kinds.includes('enum-symbol-removed:RED'));
  });
});

describe('BACKWARD 向后兼容（老读取方读新数据）', () => {
  it('新增带默认值的可选字段：兼容', () => {
    const v2 = schema('Event', [
      ...v1.fields,
      field('tag', 'string', { required: false, default: 'none' })
    ]);
    const r = checkCompatibility(v1, v2, CompatibilityMode.BACKWARD);
    assert.equal(r.compatible, true);
  });

  it('新增必填且无默认值的字段：破坏', () => {
    const v2 = schema('Event', [...v1.fields, field('tag', 'string')]);
    const r = checkCompatibility(v1, v2, CompatibilityMode.BACKWARD);
    assert.equal(r.compatible, false);
    assert.equal(r.violations[0].code, ViolationCode.FIELD_ADDED_REQUIRED);
  });

  it('删除字段不影响老读取方：兼容', () => {
    const v2 = schema('Event', [field('id', 'string')]);
    const r = checkCompatibility(v1, v2, CompatibilityMode.BACKWARD);
    assert.equal(r.compatible, true);
  });

  it('int→long 数值拓宽：兼容；long→int 收窄：破坏', () => {
    const widened = schema('Event', [field('id', 'string'), field('count', 'long')]);
    assert.equal(checkCompatibility(v1, widened, CompatibilityMode.BACKWARD).compatible, true);

    const narrowed = schema('Event', [field('id', 'string'), field('count', 'int')]);
    const base = schema('Event', [field('id', 'string'), field('count', 'long')]);
    const r = checkCompatibility(base, narrowed, CompatibilityMode.BACKWARD);
    assert.equal(r.compatible, false);
    assert.equal(r.violations[0].code, ViolationCode.FIELD_TYPE_CHANGED);
  });

  it('新增枚举取值：老读取方无法识别，破坏', () => {
    const e1 = schema('E', [field('color', 'enum', { symbols: ['RED'] })]);
    const e2 = schema('E', [field('color', 'enum', { symbols: ['RED', 'BLUE'] })]);
    const r = checkCompatibility(e1, e2, CompatibilityMode.BACKWARD);
    assert.equal(r.compatible, false);
    assert.equal(r.violations[0].code, ViolationCode.ENUM_SYMBOL_ADDED);
  });
});

describe('FORWARD 向前兼容（新读取方读旧数据）', () => {
  it('删除必填字段：破坏；删除可选字段：兼容', () => {
    const removedRequired = schema('Event', [field('id', 'string')]);
    const r1 = checkCompatibility(v1, removedRequired, CompatibilityMode.FORWARD);
    assert.equal(r1.compatible, false);
    assert.equal(r1.violations[0].code, ViolationCode.FIELD_REMOVED);

    const withOptional = schema('Event', [
      field('id', 'string'),
      field('note', 'string', { required: false })
    ]);
    const removedOptional = schema('Event', [field('id', 'string')]);
    assert.equal(
      checkCompatibility(withOptional, removedOptional, CompatibilityMode.FORWARD).compatible,
      true
    );
  });

  it('新增必填字段：旧数据缺值，破坏', () => {
    const v2 = schema('Event', [...v1.fields, field('tag', 'string')]);
    const r = checkCompatibility(v1, v2, CompatibilityMode.FORWARD);
    assert.equal(r.compatible, false);
    assert.ok(r.violations.some((v) => v.code === ViolationCode.FIELD_ADDED_REQUIRED));
  });

  it('字段变为必填：破坏；字段变为可选：兼容', () => {
    const madeRequired = schema('Event', [
      field('id', 'string'),
      field('count', 'int', { required: false })
    ]);
    const target = schema('Event', [field('id', 'string'), field('count', 'int')]);
    assert.equal(
      checkCompatibility(madeRequired, target, CompatibilityMode.FORWARD).compatible,
      false
    );
    assert.equal(
      checkCompatibility(target, madeRequired, CompatibilityMode.FORWARD).compatible,
      true
    );
  });

  it('删除枚举取值：旧数据可能仍包含，破坏', () => {
    const e1 = schema('E', [field('color', 'enum', { symbols: ['RED', 'BLUE'] })]);
    const e2 = schema('E', [field('color', 'enum', { symbols: ['RED'] })]);
    const r = checkCompatibility(e1, e2, CompatibilityMode.FORWARD);
    assert.equal(r.compatible, false);
    assert.equal(r.violations[0].code, ViolationCode.ENUM_SYMBOL_REMOVED);
  });
});

describe('FULL 全兼容', () => {
  it('新增可选带默认值字段：两个方向都通过', () => {
    const v2 = schema('Event', [
      ...v1.fields,
      field('tag', 'string', { required: false, default: 'x' })
    ]);
    assert.equal(checkCompatibility(v1, v2, CompatibilityMode.FULL).compatible, true);
  });

  it('新增必填字段：两个方向都不通过', () => {
    const v2 = schema('Event', [...v1.fields, field('tag', 'string')]);
    const r = checkCompatibility(v1, v2, CompatibilityMode.FULL);
    assert.equal(r.compatible, false);
    assert.ok(r.violations.length >= 2);
  });

  it('NONE 策略永远通过', () => {
    const v2 = schema('Event', [field('totally', 'string')]);
    assert.equal(checkCompatibility(v1, v2, CompatibilityMode.NONE).compatible, true);
  });
});

describe('evaluateDataImpact 存量数据精确判定', () => {
  it('只标记真实命中历史记录的破坏项', () => {
    const v2 = schema('Event', [
      field('id', 'string'),
      field('count', 'int'),
      field('tenant', 'string') // 新增必填 -> FORWARD 破坏
    ]);
    const forward = checkCompatibility(v1, v2, CompatibilityMode.FORWARD);
    const records = [
      { id: 1, payload: { id: 'a', count: 1 } }, // 缺 tenant，命中
      { id: 2, payload: { id: 'b', count: 2 } }
    ];
    const result = evaluateDataImpact(v1, v2, records, forward.violations);
    const impacting = result.filter((v) => v.dataImpacting);
    assert.equal(impacting.length, 1);
    assert.deepEqual(impacting[0].affectedRecordIds, [1, 2]);
    assert.match(impacting[0].migrationKey, /FIELD_ADDED_REQUIRED:tenant/);
  });

  it('枚举删除仅在旧记录包含被删取值时命中', () => {
    const e1 = schema('E', [field('color', 'enum', { symbols: ['RED', 'BLUE'] })]);
    const e2 = schema('E', [field('color', 'enum', { symbols: ['RED'] })]);
    const forward = checkCompatibility(e1, e2, CompatibilityMode.FORWARD);
    const records = [
      { id: 1, payload: { color: 'RED' } },
      { id: 2, payload: { color: 'BLUE' } }
    ];
    const result = evaluateDataImpact(e1, e2, records, forward.violations);
    const hit = result.find((v) => v.dataImpacting);
    assert.ok(hit);
    assert.deepEqual(hit.affectedRecordIds, [2]);
  });
});
