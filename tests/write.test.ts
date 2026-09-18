import assert from 'node:assert/strict';
import test from 'node:test';
import type { SFTPWrapper, Stats } from 'ssh2';
import { SSHConnectionManager } from '../src/ssh.js';
import { RemoteFiles } from '../src/tools/files.js';

interface Node { data: Buffer; mode: number; uid: number; gid: number }
type Callback<T = void> = (error: Error | null, value?: T) => void;

/** 可注入失败的 SFTP 替身：补测真实 ssh2 测试服务没有声明的 OpenSSH 原子替换扩展。 */
function writeFixture() {
  const nodes = new Map<string, Node>([['/config', { data: Buffer.from('old'), mode: 0o100640, uid: 1000, gid: 1001 }]]);
  const handles = new Map<string, string>();
  let serial = 0;
  let failWrite = false;
  let failBackup = false;
  const calls: string[] = [];
  const failure = (code = 4) => Object.assign(new Error('test failure'), { code });
  const reply = <T>(callback: Callback<T>, value?: T, error: Error | null = null) => queueMicrotask(() => callback(error, value));
  const stat = (node: Node): Stats => ({ ...node, size: node.data.length, atime: 0, mtime: 0,
    isFile: () => (node.mode & 0o170000) === 0o100000,
    isDirectory: () => false, isSymbolicLink: () => (node.mode & 0o170000) === 0o120000,
  } as Stats);
  const nodeFor = (handle: Buffer) => nodes.get(handles.get(handle.toString()) ?? '')!;
  const fake = {
    lstat(path: string, callback: Callback<Stats>) { const node = nodes.get(path); reply(callback, node ? stat(node) : undefined, node ? null : failure(2)); },
    open(path: string, mode: string, attrsOrCallback: number | Callback<Buffer>, callback?: Callback<Buffer>) {
      const done = typeof attrsOrCallback === 'function' ? attrsOrCallback : callback!;
      calls.push(`open:${path}:${mode}`);
      if ((mode === 'wx' && nodes.has(path)) || (failBackup && path.includes('.bak-'))) { reply(done, undefined, failure()); return; }
      if (!nodes.has(path)) nodes.set(path, { data: Buffer.alloc(0), mode: 0o100600, uid: 1000, gid: 1000 });
      const handle = Buffer.from(String(++serial)); handles.set(handle.toString(), path); reply(done, handle);
    },
    fstat(handle: Buffer, callback: Callback<Stats>) { reply(callback, stat(nodeFor(handle))); },
    read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback<number>) {
      const data = nodeFor(handle).data.subarray(position, position + length); data.copy(buffer, offset); reply(callback, data.length);
    },
    write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback) {
      const path = handles.get(handle.toString())!;
      if (failWrite && path.includes('.tmp-')) { reply(callback, undefined, failure()); return; }
      const node = nodeFor(handle); const updated = Buffer.alloc(Math.max(node.data.length, position + length));
      node.data.copy(updated); buffer.copy(updated, position, offset, offset + length); node.data = updated; reply(callback);
    },
    fsetstat(handle: Buffer, attrs: Partial<Node>, callback: Callback) {
      const node = nodeFor(handle); Object.assign(node, attrs);
      // chmod 只修改权限位，真实文件系统会保留文件类型位。
      if (attrs.mode !== undefined) node.mode = 0o100000 | attrs.mode;
      reply(callback);
    },
    close(handle: Buffer, callback: Callback) { handles.delete(handle.toString()); reply(callback); },
    ext_openssh_rename(from: string, to: string, callback: Callback) { calls.push('replace'); nodes.set(to, nodes.get(from)!); nodes.delete(from); reply(callback); },
    rename(from: string, to: string, callback: Callback) { if (nodes.has(to)) { reply(callback, undefined, failure()); return; } nodes.set(to, nodes.get(from)!); nodes.delete(from); reply(callback); },
    unlink(path: string, callback: Callback) { nodes.delete(path); reply(callback); },
  };
  class FakeManager extends SSHConnectionManager {
    override async withSftp<T>(operation: (sftp: SFTPWrapper) => Promise<T>): Promise<T> { return operation(fake as unknown as SFTPWrapper); }
  }
  return { files: new RemoteFiles(new FakeManager({ host: '', port: 22, username: '', password: '' })), nodes, handles, calls,
    set failWrite(value: boolean) { failWrite = value; }, set failBackup(value: boolean) { failBackup = value; } };
}

test('备份后原子替换，保留所有者/权限，并发保存不覆盖先前备份', async () => {
  const fixture = writeFixture();
  const [first, second] = await Promise.all([
    fixture.files.writeFile('/config', 'first', true), fixture.files.writeFile('/config', 'second', true),
  ]);
  assert.equal(fixture.nodes.get(first.backupPath!)?.data.toString(), 'old');
  assert.equal(fixture.nodes.get(second.backupPath!)?.data.toString(), 'first');
  assert.notEqual(first.backupPath, second.backupPath);
  assert.equal(fixture.nodes.get('/config')?.data.toString(), 'second');
  assert.equal(fixture.nodes.get('/config')?.mode, 0o100640);
  assert.equal(fixture.nodes.get('/config')?.gid, 1001);
  assert.equal(fixture.handles.size, 0);
  assert.equal([...fixture.nodes.keys()].some((path) => path.includes('.tmp-')), false);
});

test('临时写入失败保留原文件和完成的备份，清理临时文件', async () => {
  const fixture = writeFixture(); fixture.failWrite = true;
  await assert.rejects(fixture.files.writeFile('/config', 'bad', true));
  assert.equal(fixture.nodes.get('/config')?.data.toString(), 'old');
  assert.equal([...fixture.nodes.keys()].filter((path) => path.includes('.bak-')).length, 1);
  assert.equal([...fixture.nodes.keys()].some((path) => path.includes('.tmp-')), false);
  assert.equal(fixture.handles.size, 0);
});

test('备份失败时禁止写入原文件或创建临时文件', async () => {
  const fixture = writeFixture(); fixture.failBackup = true;
  await assert.rejects(fixture.files.writeFile('/config', 'bad', true));
  assert.equal(fixture.nodes.get('/config')?.data.toString(), 'old');
  assert.equal(fixture.calls.some((call) => call.includes('.tmp-')), false);
  assert.equal(fixture.handles.size, 0);
});

test('明确关闭备份时仅原子替换，不产生备份文件', async () => {
  const fixture = writeFixture();
  const result = await fixture.files.writeFile('/config', 'new', false);
  assert.equal(result.backupPath, null);
  assert.equal(fixture.nodes.get('/config')?.data.toString(), 'new');
  assert.equal(fixture.nodes.size, 1);
});
