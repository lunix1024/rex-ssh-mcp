import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addServer,
  changePassword,
  deleteServer,
  editServer,
  testServerFlow,
  type ConfigCliFlowServices,
  type ConfigCliPrompter,
} from '../src/config-cli.js';
import type { ServersDocument, StoredServerProfile } from '../src/config.js';
import { AppError } from '../src/errors.js';
import type { PromptResult } from '../src/tui-prompts.js';

type PromptKind = 'select' | 'input' | 'password';
interface PlannedPrompt {
  kind: PromptKind;
  result: PromptResult<unknown>;
}

const original: StoredServerProfile = {
  alias: '生产服务器',
  host: 'old.example.test',
  port: 22,
  username: 'root',
  encryptedPassword: 'dpapi:v1:b2xk',
  hostFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const document: ServersDocument = { version: 1, servers: [original] };

const value = <T>(answer: T): PromptResult<T> => ({ kind: 'value', value: answer });
const back = (): PromptResult<never> => ({ kind: 'back' });

/**
 * 用单一队列模拟用户依次操作各类提示器。每次提示都会校验类型，因此测试既能验证
 * 最终结果，也能验证 Esc 后确实回到了预期的上一步，而不是跳到了别的页面。
 */
function createHarness(plan: PlannedPrompt[], options: {
  testFailure?: boolean;
  saveConflict?: boolean;
} = {}) {
  const remaining = [...plan];
  const saved: ServersDocument[] = [];
  const tested: StoredServerProfile[] = [];
  const encrypted: string[] = [];
  const errors: string[] = [];

  const take = (kind: PromptKind): PromptResult<unknown> => {
    const next = remaining.shift();
    assert.ok(next, `缺少 ${kind} 的模拟输入`);
    assert.equal(next.kind, kind, `期望提示器 ${kind}，实际调用 ${next.kind}`);
    return next.result;
  };
  const prompts: ConfigCliPrompter = {
    select: (async () => take('select')) as ConfigCliPrompter['select'],
    input: (async () => take('input')) as ConfigCliPrompter['input'],
    password: (async () => take('password')) as ConfigCliPrompter['password'],
  };
  const services: ConfigCliFlowServices = {
    prompts,
    encryptPassword: async (password) => {
      encrypted.push(password);
      return `dpapi:v1:${Buffer.from(password).toString('base64')}`;
    },
    saveDocument: ((nextDocument: ServersDocument) => {
      if (options.saveConflict) {
        throw new AppError('server_configuration_conflict', '测试模拟的并发修改');
      }
      saved.push(structuredClone(nextDocument));
      return 'new-revision';
    }) as ConfigCliFlowServices['saveDocument'],
    testConnection: async (profile) => {
      tested.push(structuredClone(profile));
      if (options.testFailure) throw new Error('仅用于模拟连接失败');
    },
    info: () => {},
    error: (message) => errors.push(message),
  };
  return { services, remaining, saved, tested, encrypted, errors };
}

test('字段编辑支持输入 Esc、连续暂存多个字段并且只写盘一次', async () => {
  const harness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'select', result: value('host') },
    { kind: 'input', result: back() },
    { kind: 'select', result: value('host') },
    { kind: 'input', result: value('new.example.test') },
    { kind: 'select', result: value('port') },
    { kind: 'input', result: value('2222') },
    { kind: 'select', result: value('save') },
    { kind: 'select', result: value('direct') },
  ]);

  await editServer(document, 'revision', harness.services);

  assert.equal(harness.remaining.length, 0);
  assert.equal(harness.saved.length, 1);
  const saved = harness.saved[0]!.servers[0]!;
  assert.equal(saved.host, 'new.example.test');
  assert.equal(saved.port, 2222);
  assert.equal(saved.username, original.username);
  assert.equal(saved.encryptedPassword, original.encryptedPassword);
});

test('有未保存草稿时 Esc 进入确认，确认页 Esc 返回编辑，放弃后不写盘', async () => {
  const harness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'select', result: value('username') },
    { kind: 'input', result: value('operator') },
    { kind: 'select', result: back() },
    { kind: 'select', result: back() },
    { kind: 'select', result: back() },
    { kind: 'select', result: value(true) },
    { kind: 'select', result: back() },
  ]);

  await editServer(document, 'revision', harness.services);

  assert.equal(harness.remaining.length, 0);
  assert.equal(harness.saved.length, 0);
});

test('新增向导 Esc 逐字段回退，在首字段 Esc 后不加密也不保存', async () => {
  const harness = createHarness([
    { kind: 'input', result: value('测试服务器') },
    { kind: 'input', result: value('test.example.test') },
    { kind: 'input', result: back() },
    { kind: 'input', result: back() },
    { kind: 'input', result: back() },
  ]);

  await addServer({ version: 1, servers: [] }, 'revision', harness.services);

  assert.equal(harness.remaining.length, 0);
  assert.equal(harness.encrypted.length, 0);
  assert.equal(harness.saved.length, 0);
});

test('修改密码确认页 Esc 返回首次输入，首次输入 Esc 返回服务器选择', async () => {
  const harness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'password', result: value('new-secret') },
    { kind: 'password', result: back() },
    { kind: 'password', result: back() },
    { kind: 'select', result: back() },
  ]);

  await changePassword(document, 'revision', harness.services);

  assert.equal(harness.remaining.length, 0);
  assert.equal(harness.encrypted.length, 0);
  assert.equal(harness.saved.length, 0);
});

test('测试选择页和删除二次确认均可用 Esc 逐级返回且无副作用', async () => {
  const testHarness = createHarness([{ kind: 'select', result: back() }]);
  await testServerFlow(document, testHarness.services);
  assert.equal(testHarness.tested.length, 0);

  const deleteHarness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'select', result: value(true) },
    { kind: 'input', result: back() },
    { kind: 'select', result: back() },
    { kind: 'select', result: back() },
  ]);
  await deleteServer(document, 'revision', deleteHarness.services);
  assert.equal(deleteHarness.remaining.length, 0);
  assert.equal(deleteHarness.saved.length, 0);
});

test('连接测试失败后可返回编辑，草稿及磁盘均保持不变', async () => {
  const harness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'select', result: value('host') },
    { kind: 'input', result: value('failed.example.test') },
    { kind: 'select', result: value('save') },
    { kind: 'select', result: value('test') },
    { kind: 'select', result: value('edit') },
    { kind: 'select', result: back() },
    { kind: 'select', result: value(true) },
    { kind: 'select', result: back() },
  ], { testFailure: true });

  await editServer(document, 'revision', harness.services);

  assert.equal(harness.tested.length, 1);
  assert.equal(harness.saved.length, 0);
  assert.equal(document.servers[0]!.host, 'old.example.test');
});

test('保存时出现并发冲突会停止编辑且不会覆盖配置', async () => {
  const harness = createHarness([
    { kind: 'select', result: value(original.alias) },
    { kind: 'select', result: value('host') },
    { kind: 'input', result: value('conflict.example.test') },
    { kind: 'select', result: value('save') },
    { kind: 'select', result: value('direct') },
  ], { saveConflict: true });

  await editServer(document, 'revision', harness.services);

  assert.equal(harness.saved.length, 0);
  assert.match(harness.errors.join('\n'), /配置文件已被其他进程修改/);
  assert.equal(document.servers[0]!.host, 'old.example.test');
});
