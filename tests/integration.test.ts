import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ServersDocument, SSHConfig, StoredServerProfile } from '../src/config.js';
import { WindowsDpapiProtector, type SecretProtector } from '../src/dpapi.js';
import { SafeLogger } from '../src/logger.js';
import { ServerConnectionPool } from '../src/pool.js';
import { createServer } from '../src/server.js';
import { SSHConnectionManager } from '../src/ssh.js';
import { RemoteFiles } from '../src/tools/files.js';
import { startFixture } from './fixture.js';

const testProtector: SecretProtector = {
  encrypt: async (plaintext) => `dpapi:v1:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
  decrypt: async (ciphertext) => Buffer.from(ciphertext.slice('dpapi:v1:'.length), 'base64').toString('utf8'),
};

function stored(alias: string, config: SSHConfig): StoredServerProfile {
  return {
    alias, host: config.host, port: config.port, username: config.username,
    encryptedPassword: `dpapi:v1:${Buffer.from(config.password, 'utf8').toString('base64')}`,
    ...(config.hostFingerprint ? { hostFingerprint: config.hostFingerprint } : {}),
  };
}

function createCatalog(initial: StoredServerProfile[], logger = new SafeLogger('', () => {})) {
  const state: { document: ServersDocument } = { document: { version: 1, servers: initial } };
  const pool = new ServerConnectionPool(logger, testProtector, () => ({ document: state.document, revision: 'test' }));
  return { state, pool, logger, ...createServer(pool, logger) };
}

async function connectInMemory(catalog: ReturnType<typeof createCatalog>) {
  const client = new Client({ name: 'tests', version: '1.0.0' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await catalog.server.connect(remote);
  await client.connect(local);
  return client;
}

test('真实 SSH 握手、并发连接复用、输出限额、超时和断线恢复', { timeout: 30000 }, async (t) => {
  const fixture = await startFixture();
  const ssh = new SSHConnectionManager(fixture.config);
  t.after(async () => { ssh.disconnect(); await fixture.close(); });
  const connections = await Promise.all(Array.from({ length: 8 }, () => ssh.getConnection()));
  assert.ok(connections.every((connection) => connection === connections[0]));
  assert.equal(fixture.accepted, 1);
  const outputs = await Promise.all([ssh.exec('ok'), ssh.exec('fail')]);
  assert.equal(outputs[0].stdout, 'stdout 测试\n');
  assert.equal(outputs[1].exitCode, 7);
  const large = await ssh.exec('large');
  assert.equal(Buffer.byteLength(large.stdout), 1024 * 1024);
  assert.deepEqual(large.truncated, { stdout: true, stderr: true });
  await assert.rejects(ssh.exec('hang', 1), { code: 'command_timeout' });
  const before = fixture.executions;
  await assert.rejects(ssh.exec('disconnect'), { code: 'ssh_connection_lost' });
  assert.equal(fixture.executions, before + 1);
  assert.equal((await ssh.exec('ok')).exitCode, 0);
});

test('认证错误不泄露密码且主机指纹不符时拒绝连接', { timeout: 15000 }, async (t) => {
  const fixture = await startFixture();
  const ssh = new SSHConnectionManager({ ...fixture.config, password: 'wrong-secret' });
  const pinned = new SSHConnectionManager({ ...fixture.config, hostFingerprint: `SHA256:${'A'.repeat(43)}` });
  t.after(async () => { ssh.disconnect(); pinned.disconnect(); await fixture.close(); });
  await assert.rejects(ssh.connect(), (error: Error & { code: string }) => error.code === 'ssh_authentication_failed' && !error.message.includes('wrong-secret'));
  await assert.rejects(pinned.connect(), { code: 'ssh_host_key_mismatch' });
});

test('真实 SFTP 读写、二进制保护、列表和备份', { timeout: 30000 }, async (t) => {
  const fixture = await startFixture();
  const ssh = new SSHConnectionManager(fixture.config);
  const files = new RemoteFiles(ssh);
  t.after(async () => { ssh.disconnect(); await fixture.close(); });
  assert.equal((await files.readFile('/hello.txt', 1024)).content, '你好\nsecond line\n');
  await assert.rejects(files.readFile('/binary', 1024), { code: 'binary_file' });
  assert.equal((await files.stat('/link')).type, 'symlink');
  assert.ok((await files.listDir('/')).entries.some((entry) => entry.name === 'hello.txt'));
  assert.equal((await files.writeFile('/new.txt', '新内容', true)).backupPath, null);
  assert.equal((await files.readFile('/new.txt', 1024)).content, '新内容');
});

test('十个 MCP 工具注册、服务器发现、必填别名与未知目标保护', async (t) => {
  const catalog = createCatalog([{ alias: '生产-148', host: '192.0.2.148', port: 22, username: 'operator', encryptedPassword: 'dpapi:v1:c2VjcmV0' }]);
  const client = await connectInMemory(catalog);
  t.after(async () => { catalog.pool.disconnect(); await client.close(); await catalog.server.close(); });
  const listing = await client.listTools();
  assert.equal(listing.tools.length, 10);
  assert.ok(listing.tools.some((tool) => tool.name === 'ssh_list_servers'));
  for (const tool of listing.tools) {
    const properties = tool.inputSchema.properties ?? {};
    for (const field of ['password', 'privateKey']) assert.equal(field in properties, false);
    if (tool.name !== 'ssh_list_servers') assert.equal('server' in properties, true);
    assert.match(tool.description ?? '', /Never ask the user for a password/);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const found = await client.callTool({ name: 'ssh_list_servers', arguments: { query: '148' } });
  const foundText = JSON.stringify(found);
  assert.match(foundText, /生产-148/);
  assert.match(foundText, /192\.0\.2\.148/);
  assert.equal(foundText.includes('encryptedPassword'), false);
  const missingAlias = await client.callTool({ name: 'ssh_exec', arguments: { command: 'pwd' } });
  assert.equal(missingAlias.isError, true);
  const unknown = await client.callTool({ name: 'ssh_exec', arguments: { server: '不存在', command: 'pwd' } });
  assert.equal(unknown.isError, true);
  assert.match(JSON.stringify(unknown), /unknown_server/);
  const blocked = await client.callTool({ name: 'ssh_exec', arguments: { server: '生产-148', command: 'rm -rf /' } });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked), /dangerous_command_blocked/);
});

test('两台服务器并发路由、独立复用连接并统一脱敏密码', { timeout: 20000 }, async (t) => {
  const first = await startFixture({ password: 'first-multi-secret' });
  const second = await startFixture({ password: 'second-multi-secret' });
  const lines: string[] = [];
  const logger = new SafeLogger('', (line) => lines.push(line));
  const catalog = createCatalog([stored('生产-148', first.config), stored('测试-123', second.config)], logger);
  const client = await connectInMemory(catalog);
  t.after(async () => { catalog.pool.disconnect(); await client.close(); await catalog.server.close(); await first.close(); await second.close(); });
  const [a, b] = await Promise.all([
    client.callTool({ name: 'ssh_exec', arguments: { server: '生产-148', command: 'secret' } }),
    client.callTool({ name: 'ssh_exec', arguments: { server: '测试-123', command: 'secret' } }),
  ]);
  assert.equal(a.isError, undefined);
  assert.equal(b.isError, undefined);
  for (const output of [JSON.stringify(a), JSON.stringify(b), lines.join('\n')]) {
    assert.equal(output.includes(first.config.password), false);
    assert.equal(output.includes(second.config.password), false);
  }
  await client.callTool({ name: 'ssh_exec', arguments: { server: '生产-148', command: 'ok' } });
  await client.callTool({ name: 'ssh_exec', arguments: { server: '测试-123', command: 'ok' } });
  assert.equal(first.accepted, 1);
  assert.equal(second.accepted, 1);
  assert.deepEqual(catalog.pool.list().map((item) => item.status), ['connected', 'connected']);
});

test('配置热更新切换连接代次且不打断旧代次在途操作', { timeout: 20000 }, async (t) => {
  const oldFixture = await startFixture({ password: 'old-generation-secret' });
  const newFixture = await startFixture({ password: 'new-generation-secret' });
  const catalog = createCatalog([stored('目标', oldFixture.config)]);
  t.after(async () => { catalog.pool.disconnect(); await oldFixture.close(); await newFixture.close(); });

  const slow = catalog.pool.withServer('目标', (ssh) => ssh.exec('slow'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  catalog.state.document = { version: 1, servers: [stored('目标', newFixture.config)] };
  const next = await catalog.pool.withServer('目标', (ssh) => ssh.exec('ok'));
  assert.equal(next.exitCode, 0);
  assert.equal(newFixture.accepted, 1);
  assert.equal((await slow).exitCode, 0);
  await catalog.pool.reconnect('目标');
  assert.equal(newFixture.accepted, 2, '强制重连应立即建立并验证新连接');
  catalog.state.document = { version: 1, servers: [] };
  await assert.rejects(catalog.pool.withServer('目标', (ssh) => ssh.exec('ok')), { code: 'server_not_configured' });
});

test('编译后的 stdio 进程读取 DPAPI 多服务器配置并保持密码脱敏', { timeout: 30000, skip: process.platform !== 'win32' }, async (t) => {
  const fixture = await startFixture();
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, 'stdio-'));
  const protector = new WindowsDpapiProtector();
  const encryptedPassword = await protector.encrypt(fixture.config.password);
  await cp(fileURLToPath(new URL('../dist', import.meta.url)), join(sandbox, 'dist'), { recursive: true });
  await writeFile(join(sandbox, 'servers.json'), `${JSON.stringify({ version: 1, servers: [{ ...stored('stdio-148', fixture.config), encryptedPassword }] }, null, 2)}\n`, 'utf8');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(sandbox, 'dist', 'index.js')], cwd: tmpdir(), stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-smoke', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  t.after(async () => {
    await client.close().catch(() => {});
    await fixture.close();
    assert.ok(resolve(sandbox).startsWith(root + sep));
    await rm(sandbox, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const servers = await client.callTool({ name: 'ssh_list_servers', arguments: { query: '148' } });
  assert.match(JSON.stringify(servers), /stdio-148/);
  const result = await client.callTool({ name: 'ssh_exec', arguments: { server: 'stdio-148', command: 'secret' } });
  assert.equal(result.isError, undefined);
  assert.equal(JSON.stringify(result).includes(fixture.config.password), false);
  assert.match(JSON.stringify(result), /REDACTED/);
  assert.equal(stderr.includes(fixture.config.password), false);
  await client.close();
});

test('TUI 在非交互终端安全退出，不输出凭据或第三方错误', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/config-cli.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end();
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /交互式终端/);
});

test('文件工具日志记录摘要但不记录正文', { timeout: 20000 }, async (t) => {
  const fixture = await startFixture();
  const directory = await mkdtemp(join(tmpdir(), 'rex-ssh-mcp-transfer-log-'));
  const uploadPath = join(directory, 'upload.bin');
  const downloadPath = join(directory, 'download.bin');
  const binary = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
  await writeFile(uploadPath, binary);
  const lines: string[] = [];
  const logger = new SafeLogger('', (line) => lines.push(line));
  const catalog = createCatalog([stored('files', fixture.config)], logger);
  const client = await connectInMemory(catalog);
  t.after(async () => {
    catalog.pool.disconnect(); await client.close(); await catalog.server.close(); await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.callTool({ name: 'ssh_read_file', arguments: { server: 'files', path: '/hello.txt' } });
  await client.callTool({ name: 'ssh_write_file', arguments: { server: 'files', path: '/logged-new.txt', content: '只写入远端，不进入日志的正文' } });
  await client.callTool({ name: 'ssh_upload_file', arguments: { server: 'files', localPath: uploadPath, remotePath: '/uploaded.bin' } });
  await client.callTool({ name: 'ssh_download_file', arguments: { server: 'files', remotePath: '/binary', localPath: downloadPath } });
  assert.deepEqual(await readFile(downloadPath), fixture.nodes.get('/binary')?.data);
  const output = lines.join('\n');
  assert.match(output, /"server": "files"/);
  assert.match(output, /"bytesTransferred": 7/);
  assert.equal(output.includes('你好\nsecond line'), false);
  assert.equal(output.includes('只写入远端，不进入日志的正文'), false);
});
