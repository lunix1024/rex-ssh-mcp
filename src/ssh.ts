import { createHash } from 'node:crypto';
import ssh2, { type Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { SSHConfig } from './config.js';
import { AppError } from './errors.js';
import { SafeLogger } from './logger.js';
import { BoundedOutput } from './output.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: { stdout: boolean; stderr: boolean };
}

const CONNECTION_TIMEOUT_MS = 15_000;
const SFTP_TIMEOUT_MS = 30_000;

/** 单个实例只维护一条 SSH 连接；并发调用共享建立连接的 Promise。 */
export class SSHConnectionManager {
  private connection?: Client;
  private connecting?: Promise<Client>;
  private pendingClient?: Client;
  private stopped = false;

  private readonly logger: SafeLogger;

  constructor(private config: SSHConfig, logger?: SafeLogger) {
    this.logger = logger ?? new SafeLogger(config.password);
  }

  connect(): Promise<Client> { return this.getConnection(); }

  /** 只公开非敏感的连接生命周期，供服务器列表展示。 */
  getStatus(): 'disconnected' | 'connecting' | 'connected' {
    if (this.connection) return 'connected';
    if (this.connecting || this.pendingClient) return 'connecting';
    return 'disconnected';
  }

  getConnection(): Promise<Client> {
    if (this.stopped) return Promise.reject(new AppError('server_stopping', 'The MCP server is shutting down.'));
    if (this.connection) return Promise.resolve(this.connection);
    if (!this.connecting) {
      const attempt = this.connectWithRetry();
      this.connecting = attempt;
      // 只清理自己对应的 Promise，避免旧连接结束时误删重连已经创建的新 Promise。
      void attempt.then(
        () => { if (this.connecting === attempt) this.connecting = undefined; },
        () => { if (this.connecting === attempt) this.connecting = undefined; },
      );
    }
    return this.connecting;
  }

  /** 关闭旧连接、替换全部连接配置，并立即验证新配置可以建立 SSH 连接。 */
  async reconnect(config: SSHConfig): Promise<void> {
    if (this.stopped) throw new AppError('server_stopping', 'The MCP server is shutting down.');
    const previousAttempt = this.connecting;
    this.connecting = undefined;
    this.closeConnections();
    // pendingClient.destroy() 会让旧连接 Promise 很快结束；接住错误，避免成为未处理拒绝。
    await previousAttempt?.catch(() => {});
    if (this.stopped) throw new AppError('server_stopping', 'The MCP server is shutting down.');
    this.config = config;
    await this.getConnection();
  }

  private async connectWithRetry(): Promise<Client> {
    // 只有尚未派发业务操作的连接阶段允许重试一次，认证和主机指纹失败不重试。
    for (let attempt = 0; ; attempt++) {
      this.logger.info('正在建立 SSH 连接', { attempt: attempt + 1 });
      try { return await this.openConnection(); }
      catch (error) {
        const code = error instanceof AppError ? error.code : 'unknown_error';
        this.logger.warn('SSH 连接尝试失败', { attempt: attempt + 1, error: code });
        if (attempt === 1 || this.stopped || !(error instanceof AppError) || error.code !== 'ssh_connection_failed') throw error;
        this.logger.info('准备重试 SSH 连接', { nextAttempt: attempt + 2 });
      }
    }
  }

  private openConnection(): Promise<Client> {
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      this.pendingClient = client;
      let settled = false;
      let fingerprintRejected = false;
      const failed = (error?: unknown): void => {
        if (this.connection === client) {
          this.connection = undefined;
          this.logger.warn('SSH 连接已断开');
        }
        if (this.pendingClient === client) this.pendingClient = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const authentication = typeof error === 'object' && error !== null && 'level' in error && error.level === 'client-authentication';
          reject(fingerprintRejected
            ? new AppError('ssh_host_key_mismatch', 'SSH host key verification failed. Check the MCP server host fingerprint configuration.')
            : authentication
              ? new AppError('ssh_authentication_failed', "SSH authentication failed. Check the MCP server's SSH credentials configuration.")
              : new AppError('ssh_connection_failed', 'Unable to connect to the configured SSH server.'));
        }
        client.destroy();
      };
      const timer = setTimeout(() => failed(), CONNECTION_TIMEOUT_MS);
      // error 监听器终身保留，避免迟到的底层错误成为未处理异常。
      client.on('error', failed);
      client.on('end', () => failed());
      client.on('close', () => failed());
      client.once('ready', () => {
        if (settled || this.stopped) { failed(); return; }
        settled = true;
        clearTimeout(timer);
        this.pendingClient = undefined;
        this.connection = client;
        this.logger.info('SSH 连接已建立');
        resolve(client);
      });
      try {
        client.connect({
          host: this.config.host, port: this.config.port,
          username: this.config.username, password: this.config.password,
          readyTimeout: CONNECTION_TIMEOUT_MS,
          keepaliveInterval: 10_000, keepaliveCountMax: 3,
          // 可选公钥指纹只从服务端配置读取，永远不出现在 tool 参数中。
          ...(this.config.hostFingerprint ? {
            hostVerifier: (key: Buffer) => {
              const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
              fingerprintRejected = fingerprint !== this.config.hostFingerprint?.replace(/=+$/, '');
              return !fingerprintRejected;
            },
          } : {}),
        });
      } catch { failed(); }
    });
  }

  async exec(command: string, timeout = 30): Promise<ExecResult> {
    const connection = await this.getConnection();
    return new Promise((resolve, reject) => {
      const stdout = new BoundedOutput();
      const stderr = new BoundedOutput();
      let channel: ClientChannel | undefined;
      let finished = false;
      let exitCode: number | null = null;
      let signal: string | null = null;
      const result = (): ExecResult => ({ stdout: stdout.text(), stderr: stderr.text(), exitCode, signal, truncated: { stdout: stdout.truncated, stderr: stderr.truncated } });
      const finish = (error?: AppError): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        connection.off('close', lost);
        connection.off('end', lost);
        connection.off('error', lost);
        if (error) {
          // 超时发出尽力终止信号，但不承诺远端派生进程一定终止，也绝不重放命令。
          try { channel?.signal('TERM'); } catch { /* 通道可能已经断开。 */ }
          channel?.destroy();
          reject(error);
        } else resolve(result());
      };
      const lost = (): void => finish(new AppError('ssh_connection_lost', 'SSH connection lost. The command may have run; it was not retried.', { ...result() }));
      const timer = setTimeout(() => finish(new AppError('command_timeout', `Remote command timed out after ${timeout} seconds. The remote process may still be running.`, { ...result(), timedOut: true })), timeout * 1000);
      connection.once('close', lost);
      connection.once('end', lost);
      connection.once('error', lost);
      try {
        connection.exec(command, (error, stream) => {
          if (finished) { stream?.on('error', () => {}); stream?.destroy(); return; }
          if (error) { finish(new AppError('ssh_exec_failed', 'Unable to execute the remote command. Execution was not retried.')); return; }
          channel = stream;
          stream.on('data', (data: Buffer) => stdout.append(data));
          stream.stderr.on('data', (data: Buffer) => stderr.append(data));
          stream.stderr.on('error', lost);
          stream.on('error', lost);
          stream.on('exit', (code: number | null, remoteSignal?: string) => {
            exitCode = typeof code === 'number' ? code : null;
            signal = remoteSignal ?? null;
          });
          // 等待 close 而非 exit，确保所有 stdout/stderr 已经接收完毕。
          stream.on('close', () => {
            if (exitCode === null && signal === null) lost();
            else finish();
          });
          // 不提供交互输入，及时发送 EOF，防止 cat/read 一直等待 stdin。
          stream.end();
        });
      } catch { finish(new AppError('ssh_exec_failed', 'Unable to execute the remote command. Execution was not retried.')); }
    });
  }

  async withSftp<T>(operation: (sftp: SFTPWrapper) => Promise<T>, timeoutSeconds = 30): Promise<T> {
    const connection = await this.getConnection();
    return new Promise<T>((resolve, reject) => {
      let sftp: SFTPWrapper | undefined;
      let finished = false;
      const finish = (error: unknown, value?: T): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        connection.off('close', lost);
        connection.off('end', lost);
        connection.off('error', lost);
        // 每次操作结束释放 SFTP 子通道，底层 SSH 连接仍然复用。
        sftp?.destroy();
        if (error) reject(error); else resolve(value as T);
      };
      const lost = (): void => finish(new AppError('ssh_connection_lost', 'SSH connection lost during the file operation. A write may have completed; it was not retried.'));
      const timeoutMs = timeoutSeconds === 30 ? SFTP_TIMEOUT_MS : timeoutSeconds * 1000;
      const timer = setTimeout(() => finish(new AppError('sftp_timeout', `Remote file operation timed out after ${timeoutSeconds} seconds. A write may have completed; inspect the target before retrying.`)), timeoutMs);
      connection.once('close', lost);
      connection.once('end', lost);
      connection.once('error', lost);
      try {
        connection.sftp((error, subsystem) => {
          if (finished) { subsystem?.on('error', () => {}); subsystem?.destroy(); return; }
          if (error) { finish(new AppError('sftp_unavailable', 'Unable to open SFTP on the configured SSH server.')); return; }
          sftp = subsystem;
          subsystem.on('error', lost);
          subsystem.on('close', () => { if (!finished) lost(); });
          // Promise 链同时接住同步异常与异步异常，关闭后迟到的回调不会二次完成请求。
          Promise.resolve().then(() => operation(subsystem)).then((value) => finish(null, value), (failure: unknown) => finish(failure));
        });
      } catch { finish(new AppError('sftp_unavailable', 'Unable to open SFTP on the configured SSH server.')); }
    });
  }

  disconnect(): void {
    this.stopped = true;
    this.connecting = undefined;
    this.closeConnections();
  }

  /** 释放当前及正在建立的连接；重连和最终停机共用，调用者决定是否永久 stopped。 */
  private closeConnections(): void {
    const hadConnection = Boolean(this.pendingClient || this.connection);
    this.pendingClient?.destroy();
    this.connection?.end();
    this.connection?.destroy();
    this.connection = undefined;
    if (hadConnection) this.logger.info('SSH 连接已关闭');
  }
}
