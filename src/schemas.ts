import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
// 远端路径采用 Linux POSIX 语义；禁止 NUL，保留空格、单引号和换行等合法字符。
const remotePath = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Remote path must not contain NUL.');
// MCP 进程的工作目录由客户端决定，本机路径必须使用绝对路径以免文件落到意外位置。
const localPath = z.string().min(1).max(32768)
  .refine((value) => !value.includes('\0'), 'Local path must not contain NUL.')
  .refine((value) => isAbsolute(value), 'Local path must be absolute.');
const transferTimeout = z.number().int().min(1).max(3600).default(300)
  .describe('Transfer timeout in seconds (1–3600), default 300.');
const server = z.string().trim().min(1).max(64)
  .describe('Exact configured server alias returned by ssh_list_servers.');
export const execSchema = z.object({
  server,
  command: z.string().trim().min(1).max(65536).refine((value) => !value.includes('\0'), 'Command must not contain NUL.'),
  timeout: z.number().int().min(1).max(300).default(30).describe('Command timeout in seconds (1–300), default 30.'),
}).strict();
export const readFileSchema = z.object({
  server,
  path: remotePath,
  maxBytes: z.number().int().min(1).max(MAX_FILE_BYTES).default(1024 * 1024),
}).strict();
export const writeFileSchema = z.object({
  server,
  path: remotePath,
  content: z.string().max(MAX_FILE_BYTES).refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_FILE_BYTES, 'UTF-8 content must not exceed 5 MiB.'),
  createBackup: z.boolean().default(true),
}).strict();
export const pathSchema = z.object({ server, path: remotePath }).strict();
export const tailFileSchema = z.object({
  server,
  path: remotePath,
  lines: z.number().int().min(1).max(5000).default(100),
}).strict();
export const uploadFileSchema = z.object({
  server,
  localPath,
  remotePath,
  createBackup: z.boolean().default(true),
  timeout: transferTimeout,
}).strict();
export const downloadFileSchema = z.object({
  server,
  remotePath,
  localPath,
  overwrite: z.boolean().default(false),
  timeout: transferTimeout,
}).strict();
export const reconnectSchema = z.object({ server }).strict();
export const listServersSchema = z.object({
  query: z.string().trim().min(1).max(253).optional()
    .describe('Optional alias, host/IP fragment, or username used to filter configured servers.'),
}).strict();
