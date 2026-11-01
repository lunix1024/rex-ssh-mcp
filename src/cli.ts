#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * npm/npx 的唯一命令入口。这里不静态导入业务模块，因为业务模块在加载时
 * 就会确定配置路径；必须先设置稳定的数据目录，再启动 MCP 或交互配置器。
 * 默认启动分支不向 stdout 输出提示，保持 stdio MCP 协议通道干净。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (args.length > 1 || (command !== undefined && !['config', '--help', '-h', '--version', '-v'].includes(command))) {
    console.error('用法：rex-ssh-mcp [config | --help | --version]');
    process.exitCode = 1;
    return;
  }
  if (command === '--version' || command === '-v') {
    // 从随包发布的元数据读取版本，避免 CLI 与 package.json 的版本号不一致。
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(pkg.version);
    return;
  }
  const dataDirectory = resolve(process.env.REX_SSH_MCP_HOME?.trim() || join(homedir(), '.rex-ssh-mcp'));
  if (command === '--help' || command === '-h') {
    console.log(`Rex SSH MCP

用法：
  rex-ssh-mcp             启动 stdio MCP 服务
  rex-ssh-mcp config      打开服务器配置界面（Windows 交互终端）
  rex-ssh-mcp --version   显示版本

配置文件：${join(dataDirectory, 'servers.json')}
日志文件：${join(dataDirectory, 'logs', 'rex-ssh-mcp.log')}
可使用环境变量 REX_SSH_MCP_HOME 指定数据目录。`);
    return;
  }
  process.env.REX_SSH_MCP_HOME = dataDirectory;
  if (command === 'config') {
    const { runConfigCli } = await import('./config-cli.js');
    await runConfigCli();
  } else {
    await import('./index.js');
  }
}

// 启动失败时不输出未经清洗的第三方异常或堆栈，沿用现有入口的安全错误策略。
void main().catch(() => {
  console.error('无法启动 Rex SSH MCP，请检查安装及数据目录权限。');
  process.exitCode = 1;
});
