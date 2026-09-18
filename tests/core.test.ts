import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseServersDocument } from '../src/config.js';
import { redactValue } from '../src/errors.js';
import { BoundedOutput } from '../src/output.js';
import { createFileLogSink, SafeLogger } from '../src/logger.js';
import { isDangerousCommand, shellEscape } from '../src/safety.js';
import { downloadFileSchema, execSchema, listServersSchema, pathSchema, readFileSchema, reconnectSchema, tailFileSchema, uploadFileSchema, writeFileSchema } from '../src/schemas.js';
import { decodeText } from '../src/tools/files.js';
import { resolveNumberedIndex } from '../src/tui-prompts.js';

const encryptedPassword = `dpapi:v1:${Buffer.from('secret').toString('base64')}`;

test('多服务器配置校验、Unicode 别名规范化与重复检测', () => {
  const parsed = parseServersDocument({ version: 1, servers: [
    { alias: ' 生产-148 ', host: 'server.test', port: 22, username: 'operator', encryptedPassword },
  ] });
  assert.equal(parsed.servers[0]?.alias, '生产-148');
  for (const port of [0, 65536, 22.5, '22']) assert.throws(() => parseServersDocument({ version: 1, servers: [{ ...parsed.servers[0], port }] }));
  assert.throws(() => parseServersDocument({ version: 2, servers: [] }), /invalid/i);
  assert.throws(() => parseServersDocument({ version: 1, servers: [parsed.servers[0], { ...parsed.servers[0], alias: '生产-148' }] }), /duplicate/i);
  assert.throws(() => parseServersDocument({ version: 1, servers: [{ ...parsed.servers[0], encryptedPassword: 'plain-secret' }] }), /invalid/i);
});

test('集中阻止常见危险命令及常见变体', () => {
  for (const command of ['rm -rf /', 'rm -rf /*', 'sudo /bin/rm -fr -- /', 'rm --recursive --force /', 'rm -r -f /', 'rm -rf "/"', 'rm -rf /./', 'mkfs.ext4 /dev/sda', '/sbin/wipefs -a /dev/sdb', 'sudo shutdown -h now', 'poweroff', 'reboot', 'halt', 'dd if=/dev/zero of=/dev/sda', 'echo ok; reboot', 'systemctl poweroff', 'r\\\neboot']) assert.equal(isDangerousCommand(command), true, command);
});

test('允许运维命令以及普通目录清理，不采用命令白名单', () => {
  for (const command of ['df -h', 'docker ps -a', 'systemctl restart nginx', 'journalctl -u nginx', 'rm -rf /tmp/cache', 'cat /etc/nginx/nginx.conf', 'ss -lntp', 'printf hello']) assert.equal(isDangerousCommand(command), false, command);
});

test('tail 路径 shell 转义处理单引号与命令替换', () => {
  assert.equal(shellEscape("/tmp/a'b;$(touch /tmp/pwn)"), "'/tmp/a'\"'\"'b;$(touch /tmp/pwn)'");
});

test('输出按字节限额、持续丢弃超限数据、保留 UTF-8 字符边界', () => {
  const output = new BoundedOutput(6);
  output.append(Buffer.from('中文'));
  output.append(Buffer.alloc(2 * 1024 * 1024, 65));
  assert.equal(output.text(), '中文');
  assert.equal(output.truncated, true);
  const partial = new BoundedOutput(4);
  partial.append('中文');
  assert.equal(partial.text(), '中');
});

test('所有操作 schema 必须提供服务器别名并拒绝连接凭据', () => {
  assert.equal(execSchema.parse({ server: '生产-148', command: 'pwd' }).timeout, 30);
  assert.equal(readFileSchema.parse({ server: 's', path: '/x' }).maxBytes, 1024 * 1024);
  assert.equal(writeFileSchema.parse({ server: 's', path: '/x', content: '' }).createBackup, true);
  assert.equal(tailFileSchema.parse({ server: 's', path: '/x' }).lines, 100);
  for (const schema of [execSchema, readFileSchema, writeFileSchema, pathSchema, tailFileSchema, uploadFileSchema, downloadFileSchema, reconnectSchema]) assert.equal(schema.safeParse({}).success, false);
  const localPath = resolve('local.bin');
  assert.deepEqual(uploadFileSchema.parse({ server: 's', localPath, remotePath: '/remote.bin' }), { server: 's', localPath, remotePath: '/remote.bin', createBackup: true, timeout: 300 });
  assert.deepEqual(downloadFileSchema.parse({ server: 's', remotePath: '/remote.bin', localPath }), { server: 's', remotePath: '/remote.bin', localPath, overwrite: false, timeout: 300 });
  assert.equal(reconnectSchema.safeParse({ server: 's' }).success, true);
  assert.deepEqual(listServersSchema.parse({ query: '148' }), { query: '148' });
  for (const key of ['host', 'ip', 'username', 'password', 'port', 'privateKey']) assert.equal(execSchema.safeParse({ server: 's', command: 'pwd', [key]: 'forbidden' }).success, false);
});

test('TUI 编号解析支持多位编号并拒绝越界或非数字输入', () => {
  assert.equal(resolveNumberedIndex('1', 12), 0);
  assert.equal(resolveNumberedIndex('10', 12), 9);
  assert.equal(resolveNumberedIndex('12', 12), 11);
  assert.equal(resolveNumberedIndex('0', 12), undefined);
  assert.equal(resolveNumberedIndex('13', 12), undefined);
  assert.equal(resolveNumberedIndex('q', 12), undefined);
  assert.equal(resolveNumberedIndex('', 12), undefined);
});

test('文件二进制/非 UTF-8 检测与合法 UTF-8 截断', () => {
  assert.equal(decodeText(Buffer.from('配置\nhello\tworld')), '配置\nhello\tworld');
  assert.throws(() => decodeText(Buffer.from([0, 1, 2])), /binary/);
  assert.throws(() => decodeText(Buffer.from([255, 254, 128])), /UTF-8/);
  assert.equal(decodeText(Buffer.from('中文').subarray(0, 4), true), '中');
});

test('成功内容、错误、路径和数组均统一脱敏', () => {
  const result = redactValue({ stdout: 'before sensitive after', entries: [{ name: 'sensitive' }], content: 'sensitive\nsensitive' }, 'sensitive');
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
  assert.match(JSON.stringify(result), /REDACTED/);
});

test('多行运行日志脱敏多个新旧密码、JSON 键名和转义字符', () => {
  const lines: string[] = [];
  const secret = 'pa"ss\\word';
  const logger = new SafeLogger(secret, (line) => lines.push(line));
  logger.info(`command ${secret}`, { output: secret, [secret]: `again ${secret}` });
  const refreshedSecret = 'new-pa"ss\\word';
  logger.addSecret(refreshedSecret);
  logger.info(`new command ${refreshedSecret}`, { output: refreshedSecret });
  const output = lines.join('\n');
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(refreshedSecret), false);
  assert.match(output, /\[REDACTED\]/);
});

test('运行日志追加、轮转且不泄露密码', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'rex-ssh-mcp-log-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const logPath = join(directory, 'rex-ssh-mcp.log');
  const secret = 'file-log-secret';
  const stderrLines: string[] = [];
  const logger = new SafeLogger(secret, createFileLogSink(logPath, { maxBytes: 180, backupCount: 2, consoleSink: (line) => stderrLines.push(line) }));
  for (let index = 0; index < 8; index += 1) logger.info('完成', { stdout: `result-${index}-${secret}` });
  const files = readdirSync(directory).sort();
  assert.ok(files.includes('rex-ssh-mcp.log'));
  assert.ok(files.includes('rex-ssh-mcp.log.1'));
  const persisted = files.map((name) => readFileSync(join(directory, name), 'utf8')).join('\n');
  assert.equal(persisted.includes(secret), false);
  assert.equal(stderrLines.join('\n').includes(secret), false);
});
