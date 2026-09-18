import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { loadServersDocument, MISSING_CONFIG_REVISION, saveServersDocument } from '../src/config.js';
import { WindowsDpapiProtector } from '../src/dpapi.js';

test('servers.json 缺失为空配置，保存使用版本摘要并拒绝覆盖并发修改', async (t) => {
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, 'config-'));
  t.after(async () => {
    assert.ok(resolve(sandbox).startsWith(root + sep));
    await rm(sandbox, { recursive: true, force: true });
  });
  const path = join(sandbox, 'servers.json');
  const missing = loadServersDocument(path);
  assert.equal(missing.revision, MISSING_CONFIG_REVISION);
  const profile = { alias: '测试-148', host: '192.0.2.148', port: 22, username: 'tester', encryptedPassword: `dpapi:v1:${Buffer.from('cipher').toString('base64')}` };
  const revision = saveServersDocument({ version: 1, servers: [profile] }, missing.revision, path);
  assert.notEqual(revision, MISSING_CONFIG_REVISION);
  assert.deepEqual(loadServersDocument(path).document.servers, [profile]);
  const updated = { ...profile, port: 2222 };
  const updatedRevision = saveServersDocument({ version: 1, servers: [updated] }, revision, path);
  assert.equal(loadServersDocument(path).document.servers[0]?.port, 2222, '已有配置必须能原子替换');
  await writeFile(path, '{"version":1,"servers":[]}\n', 'utf8');
  assert.throws(() => saveServersDocument({ version: 1, servers: [profile] }, updatedRevision, path), /changed/i);
  assert.equal((await readFile(path, 'utf8')).includes('测试-148'), false);
});

test('损坏 JSON 与非法密文返回固定配置错误', async (t) => {
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, 'invalid-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const path = join(sandbox, 'servers.json');
  await writeFile(path, '{bad json', 'utf8');
  assert.throws(() => loadServersDocument(path), { code: 'invalid_server_configuration' });
  await writeFile(path, JSON.stringify({ version: 1, servers: [{ alias: 'x', host: 'x', port: 22, username: 'u', encryptedPassword: 'plaintext' }] }), 'utf8');
  assert.throws(() => loadServersDocument(path), { code: 'invalid_server_configuration' });
});

test('Windows DPAPI 当前用户加解密往返且密文不包含明文', { skip: process.platform !== 'win32' }, async () => {
  const protector = new WindowsDpapiProtector();
  const secret = `dpapi-test-${Date.now()}-中文`;
  const encrypted = await protector.encrypt(secret);
  assert.match(encrypted, /^dpapi:v1:/);
  assert.equal(encrypted.includes(secret), false);
  assert.equal(await protector.decrypt(encrypted), secret);
  await assert.rejects(protector.decrypt(`${encrypted.slice(0, -2)}AA`), { code: 'credential_decryption_failed' });
});
