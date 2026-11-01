import { AppError } from './errors.js';
import { pathToFileURL } from 'node:url';
import { loadServersDocument, normalizeAlias, saveServersDocument, SERVERS_CONFIG_PATH, type ServersDocument, type StoredServerProfile } from './config.js';
import { WindowsDpapiProtector } from './dpapi.js';
import { SafeLogger } from './logger.js';
import { SSHConnectionManager } from './ssh.js';
import { cancellableInput, cancellablePassword, numberedSelect, type PromptResult } from './tui-prompts.js';

type Action = 'add' | 'edit' | 'password' | 'test' | 'delete' | 'exit';
type EditableField = 'alias' | 'host' | 'port' | 'username';
type EditMenuAction = EditableField | 'test' | 'save';
type SaveDecision = 'save' | 'edit';
const protector = new WindowsDpapiProtector();

/**
 * 配置流程只依赖这三个提示器。测试可以注入内存中的答案队列，逐步验证 Esc
 * 的返回层级，而不必真的向终端发送按键，也不会接触用户的 servers.json。
 */
export interface ConfigCliPrompter {
  select: typeof numberedSelect;
  input: typeof cancellableInput;
  password: typeof cancellablePassword;
}

/** 配置流程的外部副作用统一集中于此，便于测试写盘次数、冲突和连接测试分支。 */
export interface ConfigCliFlowServices {
  prompts: ConfigCliPrompter;
  encryptPassword: (password: string) => Promise<string>;
  saveDocument: typeof saveServersDocument;
  testConnection: (profile: StoredServerProfile) => Promise<void>;
  info: (message: string) => void;
  error: (message: string) => void;
}

const defaultServices: ConfigCliFlowServices = {
  prompts: { select: numberedSelect, input: cancellableInput, password: cancellablePassword },
  encryptPassword: (password) => protector.encrypt(password),
  saveDocument: saveServersDocument,
  testConnection: testStoredServer,
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new AppError('dpapi_unavailable', '此配置工具只支持 Windows DPAPI。');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AppError('interactive_terminal_required', '配置工具需要在交互式终端中运行。');

  console.log(`\nRex MCP 多服务器配置\n配置文件：${SERVERS_CONFIG_PATH}\n`);
  for (;;) {
    const loaded = loadServersDocument();
    printServers(loaded.document);
    const hasServers = loaded.document.servers.length > 0;
    const action = await numberedSelect<Action>({
      message: '请选择操作',
      escapeLabel: '退出',
      choices: [
        { name: '新增服务器', value: 'add' },
        ...(hasServers ? [
          { name: '编辑服务器信息', value: 'edit' as const },
          { name: '修改服务器密码', value: 'password' as const },
          { name: '测试服务器连接', value: 'test' as const },
          { name: '删除服务器', value: 'delete' as const },
        ] : []),
        { name: '退出', value: 'exit' },
      ],
    });
    if (action.kind === 'back' || action.value === 'exit') return;
    try {
      if (action.value === 'add') await addServer(loaded.document, loaded.revision);
      if (action.value === 'edit') await editServer(loaded.document, loaded.revision);
      if (action.value === 'password') await changePassword(loaded.document, loaded.revision);
      if (action.value === 'test') await testServerFlow(loaded.document);
      if (action.value === 'delete') await deleteServer(loaded.document, loaded.revision);
    } catch (error) {
      const message = error instanceof AppError ? error.message : '操作失败，请重试。';
      console.error(`\n失败：${message}\n`);
    }
  }
}

function printServers(document: ServersDocument): void {
  if (document.servers.length === 0) { console.log('尚未配置服务器。\n'); return; }
  console.table(document.servers.map((profile) => ({
    别名: profile.alias,
    主机: profile.host,
    端口: profile.port,
    登录用户: profile.username,
    主机指纹: profile.hostFingerprint ? '已配置' : '未配置',
  })));
}

/** 新增流程使用显式步骤游标，使 Esc 能回到上一个字段而不是丢弃整份输入。 */
export async function addServer(document: ServersDocument, revision: string, services: ConfigCliFlowServices = defaultServices): Promise<void> {
  // 录入向导只收集基本连接信息；已有配置中的可选主机指纹仍由连接层兼容读取。
  const draft: Partial<Omit<StoredServerProfile, 'encryptedPassword'>> = { port: 22 };
  let step = 0;
  for (;;) {
    if (step === 0) {
      const result = await promptAlias(draft.alias, document, undefined, services.prompts);
      if (result.kind === 'back') return;
      draft.alias = result.value; step += 1; continue;
    }
    if (step === 1) {
      const result = await promptHost(draft.host, services.prompts);
      if (result.kind === 'back') { step -= 1; continue; }
      draft.host = result.value; step += 1; continue;
    }
    if (step === 2) {
      const result = await promptPort(draft.port, services.prompts);
      if (result.kind === 'back') { step -= 1; continue; }
      draft.port = result.value; step += 1; continue;
    }
    if (step === 3) {
      const result = await promptUsername(draft.username, services.prompts);
      if (result.kind === 'back') { step -= 1; continue; }
      draft.username = result.value; step += 1; continue;
    }
    if (step === 4) {
      const result = await promptPassword('SSH 密码', services.prompts);
      if (result.kind === 'back') { step -= 1; continue; }
      // 密码只输入一次即加密；保存页返回时重新进入密码输入，Esc 可继续回退到登录用户。
      const encryptedPassword = await services.encryptPassword(result.value);
      const profile = profileFromDraft(draft, encryptedPassword);
      const decision = await decideSave(profile, services);
      if (decision === 'edit') continue;
      services.saveDocument({ version: 1, servers: [...document.servers, profile] }, revision);
      services.info('\n服务器已保存。\n');
      return;
    }
  }
}

/** 编辑器维护内存草稿，只有选择保存后才执行一次配置文件写入。 */
export async function editServer(document: ServersDocument, revision: string, services: ConfigCliFlowServices = defaultServices): Promise<void> {
  for (;;) {
    const original = await chooseServer(document, '选择要编辑的服务器', services.prompts);
    if (!original) return;
    let draft: StoredServerProfile = { ...original };
    for (;;) {
      const dirty = !sameProfile(draft, original);
      const selection = await services.prompts.select<EditMenuAction>({
        message: `编辑“${original.alias}”${dirty ? '（有未保存修改）' : ''}`,
        choices: [
          fieldChoice('alias', '服务器别名', draft.alias, draft.alias !== original.alias),
          fieldChoice('host', '主机名/IP', draft.host, draft.host !== original.host),
          fieldChoice('port', 'SSH 端口', String(draft.port), draft.port !== original.port),
          fieldChoice('username', '登录用户', draft.username, draft.username !== original.username),
          { name: '测试当前草稿连接', value: 'test' },
          { name: dirty ? '保存全部修改' : '保存修改（当前无变更）', value: 'save' },
        ],
      });
      if (selection.kind === 'back') {
        if (!dirty || await confirmDiscard(services.prompts)) break;
        continue;
      }
      if (selection.value === 'test') {
        await reportConnectionTest(draft, services);
        continue;
      }
      if (selection.value === 'save') {
        if (!dirty) { services.info('\n当前没有需要保存的修改。\n'); continue; }
        if (await decideSave(draft, services) === 'edit') continue;
        try { services.saveDocument({ version: 1, servers: document.servers.map((item) => item === original ? draft : item) }, revision); }
        catch (error) {
          if (error instanceof AppError && error.code === 'server_configuration_conflict') {
            services.error('\n配置文件已被其他进程修改，未覆盖磁盘内容；请重新进入编辑。\n');
            return;
          }
          throw error;
        }
        services.info('\n服务器信息已更新。\n');
        return;
      }
      const updated = await editField(selection.value, draft, original, document, services.prompts);
      if (updated) draft = updated;
    }
  }
}

async function editField(field: EditableField, draft: StoredServerProfile, original: StoredServerProfile, document: ServersDocument, prompts: ConfigCliPrompter): Promise<StoredServerProfile | undefined> {
  if (field === 'alias') {
    const result = await promptAlias(draft.alias, document, original, prompts);
    return result.kind === 'back' ? undefined : { ...draft, alias: result.value };
  }
  if (field === 'host') {
    const result = await promptHost(draft.host, prompts);
    return result.kind === 'back' ? undefined : { ...draft, host: result.value };
  }
  if (field === 'port') {
    const result = await promptPort(draft.port, prompts);
    return result.kind === 'back' ? undefined : { ...draft, port: result.value };
  }
  // 只更新用户选择的基本字段，保留旧配置已有的主机指纹等连接约束。
  const result = await promptUsername(draft.username, prompts);
  return result.kind === 'back' ? undefined : { ...draft, username: result.value };
}

export async function changePassword(document: ServersDocument, revision: string, services: ConfigCliFlowServices = defaultServices): Promise<void> {
  for (;;) {
    const original = await chooseServer(document, '选择要修改密码的服务器', services.prompts);
    if (!original) return;
    for (;;) {
      // 修改密码与新增保持一致：输入一次后进入保存流程，返回编辑则允许重新输入。
      const result = await promptPassword('新的 SSH 密码', services.prompts);
      if (result.kind === 'back') break;
      const updated = { ...original, encryptedPassword: await services.encryptPassword(result.value) };
      if (await decideSave(updated, services) === 'edit') continue;
      try { services.saveDocument({ version: 1, servers: document.servers.map((item) => item === original ? updated : item) }, revision); }
      catch (error) {
        if (error instanceof AppError && error.code === 'server_configuration_conflict') {
          services.error('\n配置文件已变化，密码未保存；请重新选择服务器。\n');
          break;
        }
        throw error;
      }
      services.info('\n密码已加密更新。\n');
      return;
    }
  }
}

export async function testServerFlow(document: ServersDocument, services: ConfigCliFlowServices = defaultServices): Promise<void> {
  const selected = await chooseServer(document, '选择要测试的服务器', services.prompts);
  if (selected) await reportConnectionTest(selected, services);
}

export async function deleteServer(document: ServersDocument, revision: string, services: ConfigCliFlowServices = defaultServices): Promise<void> {
  for (;;) {
    const selected = await chooseServer(document, '选择要删除的服务器', services.prompts);
    if (!selected) return;
    for (;;) {
      const approved = await askBoolean(`确定删除服务器“${selected.alias}”吗？`, false, services.prompts);
      if (approved.kind === 'back' || !approved.value) break;
      for (;;) {
        const exact = await services.prompts.input({ message: `请输入别名 ${selected.alias} 进行确认` });
        if (exact.kind === 'back') break;
        if (exact.value !== selected.alias) { services.error('\n别名不一致，请重新输入或按 Esc 返回。\n'); continue; }
        try { services.saveDocument({ version: 1, servers: document.servers.filter((profile) => profile !== selected) }, revision); }
        catch (error) {
          if (error instanceof AppError && error.code === 'server_configuration_conflict') {
            services.error('\n配置文件已变化，未执行删除；请重新选择服务器。\n');
            return;
          }
          throw error;
        }
        services.info('\n服务器已删除。\n');
        return;
      }
    }
  }
}

async function chooseServer(document: ServersDocument, message: string, prompts: ConfigCliPrompter): Promise<StoredServerProfile | undefined> {
  const result = await prompts.select<string>({
    message,
    choices: document.servers.map((profile) => ({ name: `${profile.alias}  (${profile.username}@${profile.host}:${profile.port})`, value: profile.alias })),
  });
  return result.kind === 'back' ? undefined : document.servers.find((profile) => profile.alias === result.value);
}

async function decideSave(profile: StoredServerProfile, services: ConfigCliFlowServices): Promise<SaveDecision> {
  for (;;) {
    const choice = await services.prompts.select<'test' | 'direct'>({
      message: '请选择保存方式',
      choices: [
        { name: '测试连接成功后保存', value: 'test' },
        { name: '不测试，直接保存', value: 'direct' },
      ],
    });
    if (choice.kind === 'back') return 'edit';
    if (choice.value === 'direct') return 'save';
    try { await services.testConnection(profile); return 'save'; }
    catch {
      services.error('\n连接测试失败，未输出底层错误或凭据。\n');
      const failed = await services.prompts.select<'save' | 'edit'>({
        message: '连接失败后如何处理',
        choices: [
          { name: '仍然保存当前配置', value: 'save' },
          { name: '返回继续编辑', value: 'edit' },
        ],
      });
      if (failed.kind === 'back') continue;
      return failed.value;
    }
  }
}

async function confirmDiscard(prompts: ConfigCliPrompter): Promise<boolean> {
  const result = await prompts.select<boolean>({
    message: '存在未保存修改，是否放弃？',
    choices: [
      { name: '放弃修改并返回服务器选择', value: true },
      { name: '继续编辑', value: false },
    ],
    defaultIndex: 1,
  });
  return result.kind === 'value' && result.value;
}

async function askBoolean(message: string, defaultValue: boolean, prompts: ConfigCliPrompter): Promise<PromptResult<boolean>> {
  return prompts.select({
    message,
    choices: [{ name: '是', value: true }, { name: '否', value: false }],
    defaultIndex: defaultValue ? 0 : 1,
  });
}

function fieldChoice(value: EditableField, label: string, current: string, changed: boolean) {
  return { name: `${changed ? '* ' : ''}${label}：${current}`, value };
}

function sameProfile(left: StoredServerProfile, right: StoredServerProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function profileFromDraft(
  draft: Partial<Omit<StoredServerProfile, 'encryptedPassword'>>,
  encryptedPassword: string,
): StoredServerProfile {
  return {
    alias: draft.alias!, host: draft.host!, port: draft.port!, username: draft.username!, encryptedPassword,
    ...(draft.hostFingerprint ? { hostFingerprint: draft.hostFingerprint } : {}),
  };
}

function promptAlias(current: string | undefined, document: ServersDocument, editing: StoredServerProfile | undefined, prompts: ConfigCliPrompter) {
  return prompts.input({
    message: '服务器别名', default: current,
    validate: (value) => {
      const trimmed = value.trim().normalize('NFC');
      if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f]/u.test(trimmed)) return '别名必须为 1–64 个非控制字符。';
      const duplicate = document.servers.some((profile) => profile !== editing && normalizeAlias(profile.alias) === normalizeAlias(trimmed));
      return duplicate ? '该别名已经存在。' : true;
    },
  }).then((result) => result.kind === 'back' ? result : { kind: 'value' as const, value: result.value.trim().normalize('NFC') });
}

function promptHost(current: string | undefined, prompts: ConfigCliPrompter) {
  return prompts.input({
    message: '主机名或 IP', default: current,
    validate: (value) => value.trim() && value.trim().length <= 253 && !/[\u0000-\u0020\u007f]/u.test(value.trim()) ? true : '请输入有效的主机名或 IP。',
  }).then((result) => result.kind === 'back' ? result : { kind: 'value' as const, value: result.value.trim() });
}

function promptPort(current: number = 22, prompts: ConfigCliPrompter): Promise<PromptResult<number>> {
  return prompts.input({
    message: 'SSH 端口', default: String(current),
    validate: (value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? true : '端口必须是 1–65535 的整数。',
  }).then((result) => result.kind === 'back' ? result : { kind: 'value' as const, value: Number(result.value) });
}

function promptUsername(current: string | undefined, prompts: ConfigCliPrompter) {
  return prompts.input({
    message: '登录用户', default: current,
    validate: (value) => value.trim() && value.trim().length <= 128 && !/[\u0000\r\n]/u.test(value) ? true : '请输入有效的登录用户。',
  }).then((result) => result.kind === 'back' ? result : { kind: 'value' as const, value: result.value.trim() });
}

function promptPassword(message: string, prompts: ConfigCliPrompter) {
  return prompts.password({ message, validate: (value) => value ? true : '密码不能为空。' });
}

async function reportConnectionTest(profile: StoredServerProfile, services: ConfigCliFlowServices): Promise<void> {
  try { await services.testConnection(profile); }
  catch { services.error(`\n连接“${profile.alias}”失败，未输出底层错误或凭据。\n`); }
}

async function testStoredServer(profile: StoredServerProfile): Promise<void> {
  const plaintext = await protector.decrypt(profile.encryptedPassword);
  const logger = new SafeLogger(plaintext, () => {});
  const manager = new SSHConnectionManager({
    host: profile.host, port: profile.port, username: profile.username, password: plaintext,
    ...(profile.hostFingerprint ? { hostFingerprint: profile.hostFingerprint } : {}),
  }, logger);
  try { await manager.connect(); console.log(`\n连接“${profile.alias}”成功。\n`); }
  finally { manager.disconnect(); }
}

/** 仓库入口和 npm 命令共用错误处理，导入工作流函数本身不会打开 TUI。 */
export async function runConfigCli(): Promise<void> {
  await main().catch((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'ExitPromptError') process.exit(0);
    const message = error instanceof AppError ? error.message : '配置工具意外退出。';
    console.error(message);
    process.exit(1);
  });
}

// 保留 node dist/config-cli.js 与 npm run config 的原有启动行为。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runConfigCli();
}
