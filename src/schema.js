import { ErrorCode, RegistryError } from './errors.js';

/**
 * 受支持的字段类型。int→long、float→double 属于数值拓宽，
 * 在兼容性引擎中作为唯一允许的类型变更处理。
 */
export const FIELD_TYPES = Object.freeze([
  'string',
  'boolean',
  'int',
  'long',
  'float',
  'double',
  'enum'
]);

const WIDENING = Object.freeze({
  int: 'long',
  float: 'double'
});

/**
 * 校验并规范化模式。字段默认 required=true（与 Avro 一致），
 * enum 必须提供 symbols，default 必须符合字段类型。
 *
 * @returns 规范化后的深拷贝模式
 */
export function normalizeSchema(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new RegistryError(ErrorCode.INVALID_SCHEMA, '模式必须是对象');
  }
  if (!input.name || typeof input.name !== 'string') {
    throw new RegistryError(ErrorCode.INVALID_SCHEMA, '模式缺少 name');
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new RegistryError(
      ErrorCode.INVALID_SCHEMA,
      `模式 ${input.name} 至少需要一个字段`
    );
  }

  const names = new Set();
  const fields = input.fields.map((raw) => {
    if (!raw || typeof raw !== 'object') {
      throw new RegistryError(ErrorCode.INVALID_SCHEMA, '字段必须是对象');
    }
    if (!raw.name || typeof raw.name !== 'string') {
      throw new RegistryError(ErrorCode.INVALID_SCHEMA, '字段缺少 name');
    }
    if (names.has(raw.name)) {
      throw new RegistryError(
        ErrorCode.INVALID_SCHEMA,
        `字段名重复: ${raw.name}`
      );
    }
    names.add(raw.name);
    if (!FIELD_TYPES.includes(raw.type)) {
      throw new RegistryError(
        ErrorCode.INVALID_SCHEMA,
        `字段 ${raw.name} 类型不支持: ${raw.type}`
      );
    }
    if (raw.type === 'enum') {
      if (!Array.isArray(raw.symbols) || raw.symbols.length === 0) {
        throw new RegistryError(
          ErrorCode.INVALID_SCHEMA,
          `枚举字段 ${raw.name} 缺少 symbols`
        );
      }
      if (raw.symbols.some((s) => typeof s !== 'string')) {
        throw new RegistryError(
          ErrorCode.INVALID_SCHEMA,
          `枚举字段 ${raw.name} 的 symbols 必须是字符串数组`
        );
      }
    }
    const hasDefault = Object.prototype.hasOwnProperty.call(raw, 'default');
    if (hasDefault) {
      validateDefault(raw);
    }
    const field = {
      name: raw.name,
      type: raw.type,
      required: raw.required === undefined ? true : Boolean(raw.required)
    };
    if (raw.type === 'enum') field.symbols = [...raw.symbols];
    if (hasDefault) field.default = raw.default;
    return field;
  });

  return { name: input.name, fields };
}

function validateDefault(field) {
  const value = field.default;
  const check = (ok, hint) => {
    if (!ok) {
      throw new RegistryError(
        ErrorCode.INVALID_SCHEMA,
        `字段 ${field.name} 的默认值无效，应为 ${hint}`
      );
    }
  };
  switch (field.type) {
    case 'string':
      check(typeof value === 'string', 'string');
      break;
    case 'boolean':
      check(typeof value === 'boolean', 'boolean');
      break;
    case 'int':
    case 'long':
      check(Number.isInteger(value), '整数');
      break;
    case 'float':
    case 'double':
      check(typeof value === 'number', '数值');
      break;
    case 'enum':
      check(Array.isArray(field.symbols) && field.symbols.includes(value),
        'symbols 中的枚举值');
      break;
    default:
      check(false, field.type);
  }
}

/** 校验单条写入记录是否符合模式；required 字段缺失或类型不符即拒绝。 */
export function validateRecord(schema, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new RegistryError(ErrorCode.INVALID_RECORD, '记录必须是对象');
  }
  for (const field of schema.fields) {
    const present = Object.prototype.hasOwnProperty.call(record, field.name);
    if (!present) {
      if (field.required) {
        throw new RegistryError(
          ErrorCode.INVALID_RECORD,
          `缺少必填字段: ${field.name}`
        );
      }
      continue;
    }
    validateValue(field, record[field.name]);
  }
}

function validateValue(field, value) {
  const fail = () => {
    throw new RegistryError(
      ErrorCode.INVALID_RECORD,
      `字段 ${field.name} 的值不符合类型 ${field.type}`
    );
  };
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') fail();
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail();
      break;
    case 'int':
    case 'long':
      if (!Number.isInteger(value)) fail();
      break;
    case 'float':
    case 'double':
      if (typeof value !== 'number') fail();
      break;
    case 'enum':
      if (!field.symbols.includes(value)) fail();
      break;
    default:
      fail();
  }
}

/** 仅允许 int→long、float→double 的拓宽（单向）。 */
export function isWidening(fromType, toType) {
  return WIDENING[fromType] === toType;
}

/** 模式指纹：规范化后序列化，用于判断两次提交是否完全一致。 */
export function fingerprint(schema) {
  return JSON.stringify({
    name: schema.name,
    fields: schema.fields.map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
      symbols: f.symbols,
      default: f.default
    }))
  });
}
