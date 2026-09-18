import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AppError, errorCode } from './errors.js';

export interface SSHConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  hostFingerprint?: string;
}

export interface StoredServerProfile {
  alias: string;
  host: string;
  port: number;
  username: string;
  encryptedPassword: string;
  hostFingerprint?: string;
}

export interface ServersDocument {
  version: 1;
  servers: StoredServerProfile[];
}

export interface LoadedServersDocument {
  document: ServersDocument;
  /** 原始文件摘要；缺少文件时使用固定标记，供 TUI 做乐观并发控制。 */
  revision: string;
}

export const SERVERS_CONFIG_PATH = fileURLToPath(new URL('../servers.json', import.meta.url));
export const MISSING_CONFIG_REVISION = 'missing';

const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/);
const profileSchema = z.object({
  alias: z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), 'Alias contains control characters.'),
  host: z.string().trim().min(1).max(253).refine((value) => !/[\u0000-\u0020\u007f]/u.test(value), 'Host contains whitespace or control characters.'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(128).refine((value) => !/[\u0000\r\n]/u.test(value), 'Username contains control characters.'),
  encryptedPassword: z.string().regex(/^dpapi:v1:[A-Za-z0-9+/]+={0,2}$/),
  hostFingerprint: fingerprint.optional(),
}).strict();

const documentSchema = z.object({ version: z.literal(1), servers: z.array(profileSchema).max(1000) }).strict();

/** 别名比较统一使用 NFC 与 Unicode 小写，展示时仍保留用户输入的原始大小写。 */
export function normalizeAlias(alias: string): string {
  return alias.trim().normalize('NFC').toLocaleLowerCase('en-US');
}

export function parseServersDocument(value: unknown): ServersDocument {
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success) throw new AppError('invalid_server_configuration', 'The servers.json file contains invalid server configuration.');
  const seen = new Set<string>();
  const servers = parsed.data.servers.map((profile) => ({
    ...profile,
    alias: profile.alias.trim().normalize('NFC'),
    host: profile.host.trim(),
    username: profile.username.trim(),
  }));
  for (const profile of servers) {
    const key = normalizeAlias(profile.alias);
    if (seen.has(key)) throw new AppError('duplicate_server_alias', 'The servers.json file contains duplicate server aliases.');
    seen.add(key);
  }
  return { version: 1, servers };
}

export function loadServersDocument(path = SERVERS_CONFIG_PATH): LoadedServersDocument {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { document: { version: 1, servers: [] }, revision: MISSING_CONFIG_REVISION };
    throw new AppError('server_configuration_unreadable', 'Unable to read the servers.json file.');
  }
  try {
    const document = parseServersDocument(JSON.parse(raw) as unknown);
    return { document, revision: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('invalid_server_configuration', 'The servers.json file is not valid JSON.');
  }
}

/** 配置指纹包含密文，因此密码变化也会创建新的连接代次；指纹永远不返回给 MCP 客户端。 */
export function profileRevision(profile: StoredServerProfile): string {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}

/** 使用同目录临时文件发布完整配置，并在写入前检查调用者读取到的旧版本。 */
export function saveServersDocument(document: ServersDocument, expectedRevision: string, path = SERVERS_CONFIG_PATH): string {
  const normalized = parseServersDocument(document);
  if (loadServersDocument(path).revision !== expectedRevision) {
    throw new AppError('server_configuration_conflict', 'servers.json changed after it was loaded. Reload it before saving.');
  }
  const raw = `${JSON.stringify(normalized, null, 2)}\n`;
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(tempPath, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tempPath, path);
  } catch {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch { /* 清理失败不能覆盖固定的安全错误。 */ }
    }
    throw new AppError('server_configuration_write_failed', 'Unable to save servers.json.');
  }
  return createHash('sha256').update(raw).digest('hex');
}
