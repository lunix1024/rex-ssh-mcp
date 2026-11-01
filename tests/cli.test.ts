import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MISSING_CONFIG_REVISION, saveServersDocument } from '../src/config.js';

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('npm 命令提供帮助、版本与固定用法错误，默认目录不依赖工作目录', async () => {
  // 显式清除可能继承的覆盖值，验证真正的用户目录默认值，不读取真实服务器配置。
  const env = { ...process.env, REX_SSH_MCP_HOME: '' };
  const help = await execute(process.execPath, [cliPath, '--help'], { env });
  assert.match(help.stdout, /rex-ssh-mcp config/);
  assert.ok(help.stdout.includes(join(homedir(), '.rex-ssh-mcp', 'servers.json')));
  assert.equal(help.stderr, '');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const version = await execute(process.execPath, [cliPath, '--version'], { env });
  assert.equal(version.stdout.trim(), pkg.version);
  await assert.rejects(execute(process.execPath, [cliPath, 'unknown-sensitive-argument'], { env }), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /用法/);
    assert.equal(result.stderr.includes('unknown-sensitive-argument'), false);
    return true;
  });
});

test('npm 入口从指定数据目录读取配置，保持 stdio 协议并在该目录写日志', { timeout: 15000 }, async (t) => {
  const root = resolve('.test-tmp');
  await mkdir(root, { recursive: true });
  const sandbox = await mkdtemp(join(root, 'npm-cli-'));
  const dataDirectory = join(sandbox, '中文 数据目录');
  // 使用嵌套的新目录验证首次保存自动创建父目录；列表调用不会解密或连接服务器。
  const profile = { alias: 'npm-测试', host: '192.0.2.1', port: 22, username: 'tester', encryptedPassword: 'dpapi:v1:Y2lwaGVy' };
  saveServersDocument({ version: 1, servers: [profile] }, MISSING_CONFIG_REVISION, join(dataDirectory, 'servers.json'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: sandbox,
    env: { REX_SSH_MCP_HOME: dataDirectory },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'npm-cli-test', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    // 删除范围仅限本次测试创建且已验证位于 .test-tmp 下的目录。
    assert.ok(resolve(sandbox).startsWith(root + sep));
    await rm(sandbox, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const result = await client.callTool({ name: 'ssh_list_servers', arguments: {} });
  assert.match(JSON.stringify(result), /npm-测试/);
  assert.equal(JSON.stringify(result).includes(profile.encryptedPassword), false);
  const log = await readFile(join(dataDirectory, 'logs', 'rex-ssh-mcp.log'), 'utf8');
  assert.match(log, /SSH MCP Server 已启动/);
});

test('npm config 子命令进入配置器并在非交互终端安全退出', async () => {
  await assert.rejects(execute(process.execPath, [cliPath, 'config']), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string };
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, process.platform === 'win32' ? /交互式终端/ : /Windows DPAPI/);
    return true;
  });
});
