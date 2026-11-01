import { join } from 'node:path';
import { loadServersDocument } from './config.js';
import { AppError, redactText } from './errors.js';
import { createFileLogSink, SafeLogger } from './logger.js';
import { ServerConnectionPool } from './pool.js';
import { createServer } from './server.js';
import { SafeStdioTransport } from './transport.js';
import { DATA_DIRECTORY } from './paths.js';

async function main(): Promise<void> {
  // 启动时先验证文件结构；缺少文件被视为空配置，损坏文件则立即给出固定安全错误。
  loadServersDocument();
  // 日志与服务器配置使用同一数据目录，npm/npx 入口不会向安装缓存写入用户数据。
  const logPath = join(DATA_DIRECTORY, 'logs', 'rex-ssh-mcp.log');
  const logger = new SafeLogger('', createFileLogSink(logPath));
  const pool = new ServerConnectionPool(logger);
  const { server } = createServer(pool, logger);
  let stopping = false;
  const stop = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('SSH MCP Server 正在停止', { exitCode: code });
    pool.disconnect();
    await server.close().catch(() => {});
    process.exit(code);
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  process.stdin.once('end', () => { void stop(); });
  process.stdin.once('close', () => { void stop(); });
  process.once('exit', () => pool.disconnect());
  // 兜底处理只输出固定消息，不输出错误对象、输入参数或未经清洗的堆栈。
  const fatal = (): void => {
    logger.error('MCP server encountered an unexpected error and is shutting down.');
    void stop(1);
  };
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
  await server.connect(new SafeStdioTransport(logger));
  logger.info('SSH MCP Server 已启动，正在等待 MCP 请求', { logPath });
}

void main().catch((error: unknown) => {
  const message = error instanceof AppError ? error.message : 'Unable to start the SSH MCP server.';
  console.error(redactText(message, ''));
  process.exit(1);
});
