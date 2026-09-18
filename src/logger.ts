import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactText, redactValue } from './errors.js';

type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type LogSink = (line: string) => void;

export interface FileLogOptions {
  /** 单个日志文件的最大字节数，达到上限后在下一次写入前轮转。 */
  maxBytes?: number;
  /** 保留的历史日志文件数量。 */
  backupCount?: number;
  /** 测试时可替换 stderr 输出；生产环境默认使用 console.error。 */
  consoleSink?: LogSink;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_BACKUP_COUNT = 5;

/**
 * 创建同时写入 stderr 与本地文件的日志输出器。
 *
 * stdio MCP 的 stdout 专用于 JSON-RPC 协议，任何普通文本都会破坏通信，因此日志只能写
 * stderr 或独立文件。文件写入失败时只在 stderr 提示一次，不能让日志故障中断 MCP 服务。
 */
export function createFileLogSink(logPath: string, options: FileLogOptions = {}): LogSink {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const backupCount = options.backupCount ?? DEFAULT_BACKUP_COUNT;
  const consoleSink = options.consoleSink ?? ((line: string) => console.error(line));
  let fileLoggingAvailable = true;
  let failureReported = false;

  return (line: string): void => {
    consoleSink(line);
    if (!fileLoggingAvailable) return;

    try {
      mkdirSync(dirname(logPath), { recursive: true });
      const bytesToAppend = Buffer.byteLength(`${line}\n`, 'utf8');
      if (existsSync(logPath) && statSync(logPath).size + bytesToAppend > maxBytes) {
        rotateLogs(logPath, backupCount);
      }
      appendFileSync(logPath, `${line}\n`, { encoding: 'utf8' });
    } catch {
      // 日志路径权限、磁盘空间等问题不应导致 MCP 协议服务退出。
      fileLoggingAvailable = false;
      if (!failureReported) {
        failureReported = true;
        consoleSink(`[${new Date().toISOString()}] [WARN] 无法写入 MCP 日志文件，后续日志仅输出到 stderr。`);
      }
    }
  };
}

/** 按 .1（最新）到 .N（最旧）的顺序保存有限数量的历史日志。 */
function rotateLogs(logPath: string, backupCount: number): void {
  if (backupCount <= 0) {
    unlinkSync(logPath);
    return;
  }

  const oldestPath = `${logPath}.${backupCount}`;
  if (existsSync(oldestPath)) unlinkSync(oldestPath);
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const sourcePath = `${logPath}.${index}`;
    if (existsSync(sourcePath)) renameSync(sourcePath, `${logPath}.${index + 1}`);
  }
  renameSync(logPath, `${logPath}.1`);
}

/**
 * MCP 的 stdout 必须留给协议，因此运行日志统一交给可配置 sink；生产入口会同时写入
 * stderr 和日志文件。所有内容在最终写出前再次执行密码脱敏。
 */
export class SafeLogger {
  private readonly secrets = new Set<string>();

  constructor(
    secret = '',
    private readonly sink: LogSink = (line) => console.error(line),
  ) {
    this.addSecret(secret);
  }

  /** 重连后同时保留新旧密码，保护重连期间仍在结束的旧请求日志。 */
  addSecret(secret: string): void {
    if (secret) this.secrets.add(secret);
  }

  redactText(value: string): string {
    let safe = value;
    for (const secret of this.secrets) {
      // SDK 的文本错误可能包含 JSON 转义后的参数，因此原始值和转义形式都要替换。
      const escapedSecret = JSON.stringify(secret).slice(1, -1);
      safe = redactText(redactText(safe, escapedSecret), secret);
    }
    return safe;
  }

  redactValue(value: unknown): unknown {
    let safe = value;
    for (const secret of this.secrets) safe = redactValue(safe, secret);
    return safe;
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.write('INFO', message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write('WARN', message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write('ERROR', message, details);
  }

  private write(level: LogLevel, message: string, details?: Record<string, unknown>): void {
    const safeMessage = this.redactText(message);
    let safeDetails = '';
    if (details) {
      // 先对值递归脱敏，再对序列化文本脱敏，连 JSON 键名和转义后的密码也不会漏出。
      let serialized = JSON.stringify(this.redactValue(details), null, 2);
      for (const secret of this.secrets) {
        const escapedSecret = JSON.stringify(secret).slice(1, -1);
        serialized = redactText(redactText(serialized, escapedSecret), secret);
      }
      safeDetails = `\n${serialized}`;
    }
    this.sink(`[${new Date().toISOString()}] [${level}] ${safeMessage}${safeDetails}`);
  }
}
