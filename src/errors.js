/**
 * 统一的领域错误类型。HTTP 层依据 code 映射状态码，业务层只抛出语义错误。
 */
export class RegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = Object.freeze({
  SUBJECT_EXISTS: 'SUBJECT_EXISTS',
  SUBJECT_NOT_FOUND: 'SUBJECT_NOT_FOUND',
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  ACTOR_EXISTS: 'ACTOR_EXISTS',
  ACTOR_NOT_FOUND: 'ACTOR_NOT_FOUND',
  INVALID_SCHEMA: 'INVALID_SCHEMA',
  INVALID_RECORD: 'INVALID_RECORD',
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** 发布时兼容性检查未通过（含活跃消费者、存量数据两个闸门） */
  COMPATIBILITY_VIOLATION: 'COMPATIBILITY_VIOLATION',
  /** 存在破坏性变更但未提供迁移计划 */
  MIGRATION_PLAN_REQUIRED: 'MIGRATION_PLAN_REQUIRED',
  /** 迁移计划未覆盖全部破坏性差异 */
  MIGRATION_PLAN_INCOMPLETE: 'MIGRATION_PLAN_INCOMPLETE',
  /** 兼容窗口已到期，旧版本生产者被阻断 */
  OLD_PRODUCER_BLOCKED: 'OLD_PRODUCER_BLOCKED',
  /** 已完成不可逆迁移，无法回滚 */
  IRREVERSIBLE_MIGRATION: 'IRREVERSIBLE_MIGRATION',
  CONFLICT: 'CONFLICT'
});

export function httpStatusFor(code) {
  switch (code) {
    case ErrorCode.SUBJECT_NOT_FOUND:
    case ErrorCode.VERSION_NOT_FOUND:
    case ErrorCode.ACTOR_NOT_FOUND:
      return 404;
    case ErrorCode.SUBJECT_EXISTS:
    case ErrorCode.ACTOR_EXISTS:
    case ErrorCode.OLD_PRODUCER_BLOCKED:
    case ErrorCode.IRREVERSIBLE_MIGRATION:
    case ErrorCode.CONFLICT:
      return 409;
    default:
      return 422;
  }
}
