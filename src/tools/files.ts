import { randomUUID } from 'node:crypto';
import { chmod, lstat, link, mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { AppError, errorCode, fileError, localFileError } from '../errors.js';
import type { SSHConnectionManager } from '../ssh.js';

export interface RemoteFileInfo {
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  permissions: string;
  modifyTime: string;
}

/** 将 ssh2 的回调 API 转换成 Promise，原始异常只在内部流转。 */
function request<T>(invoke: (done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => invoke((error, value) => error ? reject(error) : resolve(value)));
}
function complete(invoke: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => invoke((error) => error ? reject(error) : resolve()));
}

export function describeFile(attrs: Stats): RemoteFileInfo {
  return {
    type: attrs.isFile() ? 'file' : attrs.isDirectory() ? 'directory' : attrs.isSymbolicLink() ? 'symlink' : 'other',
    size: attrs.size,
    permissions: (attrs.mode & 0o7777).toString(8).padStart(4, '0'),
    modifyTime: new Date(attrs.mtime * 1000).toISOString(),
  };
}

/** UTF-8 文本检测：NUL 或大量异常控制字符通常意味着二进制文件。 */
export function decodeText(data: Buffer, truncated = false): string {
  const controls = data.reduce((count, byte) => count + Number(byte < 32 && ![9, 10, 13, 27].includes(byte)), 0);
  if (data.includes(0) || controls > Math.max(1, data.length * 0.01)) {
    throw new AppError('binary_file', 'This file contains binary content and is not suitable for read_file.');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data, { stream: truncated }); }
  catch { throw new AppError('unsupported_encoding', 'This file is binary or is not valid UTF-8 text and is not suitable for read_file.'); }
}

async function maybeStat(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  try { return await request<Stats>((done) => sftp.lstat(path, done)); }
  catch (error) { if (errorCode(error) === 2) return undefined; throw error; }
}

function requireRegular(attrs: Stats): void {
  if (!attrs.isFile()) throw new AppError('not_regular_file', 'The remote path must be a regular file. Symlinks cannot be replaced by write_file.');
}

function requireLocalRegular(attrs: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!attrs.isFile()) throw new AppError('local_not_regular_file', `The local path must be a regular file: ${path}`);
}

export class RemoteFiles {
  private writes: Promise<unknown> = Promise.resolve();
  private downloads: Promise<unknown> = Promise.resolve();
  constructor(private readonly ssh: SSHConnectionManager) {}

  async readFile(path: string, maxBytes: number) {
    try {
      return await this.ssh.withSftp(async (sftp) => {
        // 先 stat，避免主动打开设备或 FIFO；打开后再 fstat 验证真实句柄。
        requireRegular(await request<Stats>((done) => sftp.stat(path, done)));
        const handle = await request<Buffer>((done) => sftp.open(path, 'r', done));
        try {
          const attrs = await request<Stats>((done) => sftp.fstat(handle, done));
          requireRegular(attrs);
          // 多读一个字节判断截断，不信任可能过时的 stat.size，内存始终有上界。
          const data = Buffer.alloc(maxBytes + 1);
          let used = 0;
          while (used < data.length) {
            const bytes = await request<number>((done) => sftp.read(handle, data, used, Math.min(65536, data.length - used), used, (error, count) => done(error, count)));
            if (bytes === 0) break;
            used += bytes;
          }
          const truncated = used > maxBytes;
          const bytesRead = Math.min(used, maxBytes);
          return { path, content: decodeText(data.subarray(0, bytesRead), truncated), size: attrs.size, bytesRead, truncated };
        } finally { await complete((done) => sftp.close(handle, done)); }
      });
    } catch (error) { throw fileError(error, path); }
  }

  async listDir(path: string) {
    try {
      return await this.ssh.withSftp(async (sftp) => {
        // 用 opendir/readdir(handle) 逐批读取，避免超大目录在内存中无限累积。
        const handle = await request<Buffer>((done) => sftp.opendir(path, done));
        const entries: Array<RemoteFileInfo & { name: string }> = [];
        let truncated = false;
        try {
          for (;;) {
            const batch = await request<false | Array<{ filename: string; attrs: Stats }>>((done) => sftp.readdir(handle, done)).catch((error: unknown) => {
              // ssh2 在句柄读取到 EOF 时可能返回状态码 1，而不是 false。
              if (errorCode(error) === 1) return false as const;
              throw error;
            });
            if (batch === false || batch.length === 0) break;
            for (const entry of batch) {
              if (entry.filename === '.' || entry.filename === '..') continue;
              if (entries.length === 10000) { truncated = true; break; }
              entries.push({ name: entry.filename, ...describeFile(entry.attrs) });
            }
            if (truncated) break;
          }
        } finally { await complete((done) => sftp.close(handle, done)); }
        return { path, entries, truncated };
      });
    } catch (error) { throw fileError(error, path); }
  }

  async stat(path: string) {
    try {
      return await this.ssh.withSftp(async (sftp) => ({ path, ...describeFile(await request<Stats>((done) => sftp.lstat(path, done))) }));
    } catch (error) { throw fileError(error, path); }
  }

  writeFile(path: string, content: string, createBackup: boolean) {
    // 本进程的写操作串行化，路径别名也不会绕过锁；排队时间不占 SFTP 操作超时。
    const operation = this.writes.then(() => this.writeOnce(path, content, createBackup));
    this.writes = operation.catch(() => {});
    return operation;
  }

  uploadFile(localPath: string, remotePath: string, createBackup: boolean, timeout: number) {
    // 上传与文本写入共用同一队列，防止两个工具同时替换同一个远端目标。
    const operation = this.writes.then(() => this.uploadOnce(localPath, remotePath, createBackup, timeout));
    this.writes = operation.catch(() => {});
    return operation;
  }

  downloadFile(remotePath: string, localPath: string, overwrite: boolean, timeout: number) {
    // 本进程发起的下载串行化，避免两个调用同时操作相同的本机临时文件或目标文件。
    const operation = this.downloads.then(() => this.downloadOnce(remotePath, localPath, overwrite, timeout));
    this.downloads = operation.catch(() => {});
    return operation;
  }

  private async writeOnce(path: string, content: string, createBackup: boolean) {
    const buffer = Buffer.from(content, 'utf8');
    const result = await this.replaceRemoteFile(path, createBackup, 30, async (sftp, handle) => {
      await this.writeRemoteBuffer(sftp, handle, buffer);
      return buffer.length;
    });
    return { success: true, path: result.path, backupPath: result.backupPath };
  }

  private async uploadOnce(localPath: string, remotePath: string, createBackup: boolean, timeout: number) {
    let source: FileHandle | undefined;
    try {
      const localAttrs = await lstat(localPath).catch((error: unknown) => { throw localFileError(error, localPath); });
      requireLocalRegular(localAttrs, localPath);
      source = await open(localPath, 'r').catch((error: unknown) => { throw localFileError(error, localPath); });
      const openedAttrs = await source.stat().catch((error: unknown) => { throw localFileError(error, localPath); });
      requireLocalRegular(openedAttrs, localPath);
      const result = await this.replaceRemoteFile(remotePath, createBackup, timeout, async (sftp, handle) => {
        const buffer = Buffer.alloc(65536);
        let position = 0;
        for (;;) {
          const { bytesRead } = await source!.read(buffer, 0, buffer.length, position)
            .catch((error: unknown) => { throw localFileError(error, localPath); });
          if (bytesRead === 0) break;
          await complete((done) => sftp.write(handle, buffer, 0, bytesRead, position, done));
          position += bytesRead;
        }
        return position;
      });
      return { success: true, localPath, remotePath, bytesTransferred: result.bytesTransferred, backupPath: result.backupPath };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw localFileError(error, localPath);
    } finally {
      await source?.close().catch(() => {});
    }
  }

  private async replaceRemoteFile(
    path: string,
    createBackup: boolean,
    timeout: number,
    writeContent: (sftp: SFTPWrapper, handle: Buffer) => Promise<number>,
  ) {
    try {
      return await this.ssh.withSftp(async (sftp) => {
        const existing = await maybeStat(sftp, path);
        if (existing) requireRegular(existing);
        const tempPath = posix.join(posix.dirname(path), `.${posix.basename(path)}.tmp-${randomUUID()}`);
        let tempCreated = false;
        let backupPath: string | null = null;
        let bytesTransferred = 0;
        try {
          if (existing && createBackup) backupPath = await this.backup(sftp, path);
          // wx 使用排他创建，防止覆盖同名文件或跟随预先放置的符号链接。
          const handle = await request<Buffer>((done) => sftp.open(tempPath, 'wx', 0o600, done));
          tempCreated = true;
          try {
            bytesTransferred = await writeContent(sftp, handle);
            if (existing) {
              // 先恢复所有者，再恢复权限；chown 可能清除 setuid/setgid 位。
              await complete((done) => sftp.fsetstat(handle, { uid: existing.uid, gid: existing.gid }, done));
              await complete((done) => sftp.fsetstat(handle, { mode: existing.mode & 0o7777 }, done));
            }
          } finally { await complete((done) => sftp.close(handle, done)); }

          if (existing) {
            try { await complete((done) => sftp.ext_openssh_rename(tempPath, path, done)); }
            catch { throw new AppError('atomic_replace_failed', 'Unable to atomically replace the remote file. The original file was retained. The server must support posix-rename@openssh.com.'); }
          } else {
            // 标准 SFTP rename 不覆盖已存在目标，避免覆盖创建期间出现的新文件。
            await complete((done) => sftp.rename(tempPath, path, done));
          }
          tempCreated = false;
          return { path, backupPath, bytesTransferred };
        } catch (error) {
          const safe = fileError(error, path);
          throw new AppError(safe.code, safe.message, { ...safe.details, backupPath });
        } finally {
          // 只删除本次排他创建的临时文件；清理失败不覆盖真正的业务错误。
          if (tempCreated) await complete((done) => sftp.unlink(tempPath, done)).catch(() => {});
        }
      }, timeout);
    } catch (error) { throw fileError(error, path); }
  }

  private async writeRemoteBuffer(sftp: SFTPWrapper, handle: Buffer, buffer: Buffer): Promise<void> {
    for (let offset = 0; offset < buffer.length; offset += 65536) {
      const length = Math.min(65536, buffer.length - offset);
      await complete((done) => sftp.write(handle, buffer, offset, length, offset, done));
    }
  }

  private async downloadOnce(remotePath: string, localPath: string, overwrite: boolean, timeout: number) {
    const localDirectory = dirname(localPath);
    await mkdir(localDirectory, { recursive: true }).catch((error: unknown) => { throw localFileError(error, localDirectory); });
    const existing = await lstat(localPath).catch((error: unknown) => {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw localFileError(error, localPath);
    });
    if (existing) {
      requireLocalRegular(existing, localPath);
      if (!overwrite) throw new AppError('local_file_exists', `Local path already exists: ${localPath}`);
    }

    const tempPath = join(localDirectory, `.${basename(localPath)}.tmp-${randomUUID()}`);
    let target: FileHandle | undefined;
    let tempCreated = false;
    try {
      target = await open(tempPath, 'wx', 0o600).catch((error: unknown) => { throw localFileError(error, tempPath); });
      tempCreated = true;
      const transfer = await this.ssh.withSftp(async (sftp) => {
        requireRegular(await request<Stats>((done) => sftp.stat(remotePath, done)));
        const remoteHandle = await request<Buffer>((done) => sftp.open(remotePath, 'r', done));
        try {
          const attrs = await request<Stats>((done) => sftp.fstat(remoteHandle, done));
          requireRegular(attrs);
          const buffer = Buffer.alloc(65536);
          let position = 0;
          for (;;) {
            const bytesRead = await request<number>((done) => sftp.read(remoteHandle, buffer, 0, buffer.length, position, (error, count) => done(error, count)));
            if (bytesRead === 0) break;
            let written = 0;
            while (written < bytesRead) {
              const result = await target!.write(buffer, written, bytesRead - written, position + written)
                .catch((error: unknown) => { throw localFileError(error, tempPath); });
              written += result.bytesWritten;
            }
            position += bytesRead;
          }
          return { size: attrs.size, bytesTransferred: position };
        } finally {
          await complete((done) => sftp.close(remoteHandle, done));
        }
      }, timeout).catch((error: unknown) => { throw fileError(error, remotePath); });

      // Windows 在仍持有文件句柄时不能可靠地重命名，因此先关闭并清空引用。
      await target.close().catch((error: unknown) => { throw localFileError(error, tempPath); });
      target = undefined;
      if (existing) {
        // 覆盖现有文件时沿用其权限位，避免下载后悄悄改变本机访问权限。
        await chmod(tempPath, existing.mode & 0o7777).catch((error: unknown) => { throw localFileError(error, tempPath); });
        await rename(tempPath, localPath).catch((error: unknown) => { throw localFileError(error, localPath); });
        tempCreated = false;
      } else {
        // 硬链接以排他方式发布新文件：若检查后目标被其它进程创建，不会意外覆盖它。
        await link(tempPath, localPath).catch((error: unknown) => { throw localFileError(error, localPath); });
        await unlink(tempPath).catch((error: unknown) => { throw localFileError(error, tempPath); });
        tempCreated = false;
      }
      return { success: true, remotePath, localPath, size: transfer.size, bytesTransferred: transfer.bytesTransferred, overwritten: Boolean(existing) };
    } finally {
      await target?.close().catch(() => {});
      if (tempCreated) await unlink(tempPath).catch(() => {});
    }
  }

  private async backup(sftp: SFTPWrapper, path: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let backupPath = `${path}.bak-${stamp}`;
    // 同一秒内重复保存时添加随机后缀，永远不覆盖之前的备份。
    if (await maybeStat(sftp, backupPath)) backupPath += `-${randomUUID()}`;
    const source = await request<Buffer>((done) => sftp.open(path, 'r', done));
    let created = false;
    try {
      requireRegular(await request<Stats>((done) => sftp.fstat(source, done)));
      const target = await request<Buffer>((done) => sftp.open(backupPath, 'wx', 0o600, done));
      created = true;
      try {
        // 固定 64 KiB 缓冲区复制，原文件再大也不会被一次性读入本地内存。
        const buffer = Buffer.alloc(65536);
        let offset = 0;
        for (;;) {
          const bytes = await request<number>((done) => sftp.read(source, buffer, 0, buffer.length, offset, (error, count) => done(error, count)));
          if (bytes === 0) break;
          await complete((done) => sftp.write(target, buffer, 0, bytes, offset, done));
          offset += bytes;
        }
      } finally { await complete((done) => sftp.close(target, done)); }
      return backupPath;
    } catch (error) {
      if (created) await complete((done) => sftp.unlink(backupPath, done)).catch(() => {});
      throw error;
    } finally { await complete((done) => sftp.close(source, done)); }
  }
}
