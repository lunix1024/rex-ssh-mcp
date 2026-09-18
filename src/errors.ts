/** 只使用本项目定义的错误信息；第三方异常、连接配置和堆栈不得直接返回给模型。 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 提取可用于分类的错误码，不传播未经审核的原始 message。 */
export function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
}

export function fileError(error: unknown, path: string): AppError {
  if (error instanceof AppError) return error;
  switch (errorCode(error)) {
    case 2: case 'ENOENT':
      return new AppError('file_not_found', `Remote file does not exist: ${path}`);
    case 3: case 'EACCES': case 'EPERM':
      return new AppError('permission_denied', `Permission denied for remote path: ${path}`);
    default:
      return new AppError('sftp_operation_failed', `Unable to complete the remote file operation: ${path}`);
  }
}

/** 本机文件错误与远端 SFTP 错误分开分类，避免用户误判失败发生的位置。 */
export function localFileError(error: unknown, path: string): AppError {
  if (error instanceof AppError) return error;
  switch (errorCode(error)) {
    case 'ENOENT':
      return new AppError('local_file_not_found', `Local file or directory does not exist: ${path}`);
    case 'EEXIST':
      return new AppError('local_file_exists', `Local path already exists: ${path}`);
    case 'EACCES': case 'EPERM':
      return new AppError('local_permission_denied', `Permission denied for local path: ${path}`);
    default:
      return new AppError('local_file_operation_failed', `Unable to complete the local file operation: ${path}`);
  }
}

/** 同时保护正常输出和错误输出；即使远端恰好输出配置密码，也会在返回前脱敏。 */
export function redactText(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

export function redactValue(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item: unknown) => redactValue(item, secret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secret)]));
  }
  return value;
}
