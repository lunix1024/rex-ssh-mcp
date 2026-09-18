import { loadServersDocument, normalizeAlias, profileRevision, type LoadedServersDocument, type StoredServerProfile } from './config.js';
import { WindowsDpapiProtector, type SecretProtector } from './dpapi.js';
import { AppError } from './errors.js';
import { SafeLogger } from './logger.js';
import { SSHConnectionManager } from './ssh.js';
import { RemoteFiles } from './tools/files.js';

export type ServerConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface ListedServer {
  alias: string;
  host: string;
  port: number;
  username: string;
  hostFingerprintConfigured: boolean;
  status: ServerConnectionStatus;
}

interface Generation {
  manager: SSHConnectionManager;
  files: RemoteFiles;
  leases: number;
  retired: boolean;
}

interface PoolEntry {
  signature: string;
  generation: Generation;
}

interface PendingEntry {
  signature: string;
  promise: Promise<Generation>;
}

export type ServerDocumentLoader = () => LoadedServersDocument;

/**
 * 按服务器别名维护独立连接代次。配置变化后，新请求切换到新代次；旧代次在租约归零后关闭，
 * 从而不会因为 TUI 保存配置而主动打断正在执行的命令或文件传输。
 */
export class ServerConnectionPool {
  private readonly active = new Map<string, PoolEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly retired = new Set<Generation>();
  private stopped = false;

  constructor(
    private readonly logger: SafeLogger,
    private readonly protector: SecretProtector = new WindowsDpapiProtector(),
    private readonly loader: ServerDocumentLoader = loadServersDocument,
  ) {}

  list(query?: string): ListedServer[] {
    const profiles = this.loader().document.servers;
    this.retireRemovedProfiles(profiles);
    const needle = query?.trim().normalize('NFC').toLocaleLowerCase('en-US');
    return profiles
      .filter((profile) => !needle || [profile.alias, profile.host, profile.username]
        .some((value) => value.normalize('NFC').toLocaleLowerCase('en-US').includes(needle)))
      .map((profile) => {
        const entry = this.active.get(normalizeAlias(profile.alias));
        const current = entry?.signature === profileRevision(profile) ? entry.generation.manager.getStatus() : 'disconnected';
        return {
          alias: profile.alias,
          host: profile.host,
          port: profile.port,
          username: profile.username,
          hostFingerprintConfigured: Boolean(profile.hostFingerprint),
          status: current,
        };
      });
  }

  async withServer<T>(alias: string, operation: (manager: SSHConnectionManager, files: RemoteFiles) => Promise<T>): Promise<T> {
    if (this.stopped) throw new AppError('server_stopping', 'The MCP server is shutting down.');
    const generation = await this.getGeneration(alias);
    generation.leases += 1;
    try { return await operation(generation.manager, generation.files); }
    finally { this.release(generation); }
  }

  /** 强制创建并验证新代次；验证失败时保留原连接供后续修正配置。 */
  async reconnect(alias: string): Promise<void> {
    if (this.stopped) throw new AppError('server_stopping', 'The MCP server is shutting down.');
    const profile = this.findProfile(alias);
    const generation = await this.createGeneration(profile);
    try { await generation.manager.connect(); }
    catch (error) { generation.manager.disconnect(); throw error; }
    this.install(normalizeAlias(profile.alias), profileRevision(profile), generation);
  }

  disconnect(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.active.values()) entry.generation.manager.disconnect();
    for (const generation of this.retired) generation.manager.disconnect();
    for (const pending of this.pending.values()) void pending.promise.then((generation) => generation.manager.disconnect(), () => {});
    this.active.clear();
    this.retired.clear();
  }

  private async getGeneration(alias: string): Promise<Generation> {
    const profile = this.findProfile(alias);
    const key = normalizeAlias(profile.alias);
    const signature = profileRevision(profile);
    const existing = this.active.get(key);
    if (existing?.signature === signature) return existing.generation;

    const pending = this.pending.get(key);
    if (pending?.signature === signature) return pending.promise;

    const promise = this.createGeneration(profile);
    this.pending.set(key, { signature, promise });
    try {
      const generation = await promise;
      if (this.stopped) { generation.manager.disconnect(); throw new AppError('server_stopping', 'The MCP server is shutting down.'); }
      const current = this.active.get(key);
      if (current?.signature === signature) {
        if (current.generation !== generation) generation.manager.disconnect();
        return current.generation;
      }
      this.install(key, signature, generation);
      return generation;
    } finally {
      if (this.pending.get(key)?.promise === promise) this.pending.delete(key);
    }
  }

  private findProfile(alias: string): StoredServerProfile {
    const profiles = this.loader().document.servers;
    this.retireRemovedProfiles(profiles);
    if (profiles.length === 0) throw new AppError('server_not_configured', 'No SSH servers are configured. Run npm run config locally.');
    const key = normalizeAlias(alias);
    const profile = profiles.find((candidate) => normalizeAlias(candidate.alias) === key);
    if (!profile) throw new AppError('unknown_server', 'Unknown server alias. Call ssh_list_servers and use an exact alias.');
    return profile;
  }

  private async createGeneration(profile: StoredServerProfile): Promise<Generation> {
    let password: string;
    try { password = await this.protector.decrypt(profile.encryptedPassword); }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('credential_decryption_failed', 'Unable to decrypt the configured SSH password.');
    }
    // 必须先注册秘密再创建连接，确保后续任何日志和返回都已受脱敏保护。
    this.logger.addSecret(password);
    const manager = new SSHConnectionManager({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password,
      ...(profile.hostFingerprint ? { hostFingerprint: profile.hostFingerprint } : {}),
    }, this.logger);
    return { manager, files: new RemoteFiles(manager), leases: 0, retired: false };
  }

  private install(key: string, signature: string, generation: Generation): void {
    const old = this.active.get(key)?.generation;
    this.active.set(key, { signature, generation });
    if (old && old !== generation) this.retire(old);
  }

  private retireRemovedProfiles(profiles: StoredServerProfile[]): void {
    const configured = new Set(profiles.map((profile) => normalizeAlias(profile.alias)));
    for (const [key, entry] of this.active) {
      if (!configured.has(key)) {
        this.active.delete(key);
        this.retire(entry.generation);
      }
    }
  }

  private retire(generation: Generation): void {
    generation.retired = true;
    if (generation.leases === 0) generation.manager.disconnect();
    else this.retired.add(generation);
  }

  private release(generation: Generation): void {
    generation.leases -= 1;
    if (generation.retired && generation.leases === 0) {
      this.retired.delete(generation);
      generation.manager.disconnect();
    }
  }
}
