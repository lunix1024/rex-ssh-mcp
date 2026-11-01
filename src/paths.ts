import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 仓库入口继续使用项目目录，兼容已有的 servers.json 和客户端配置。
 * npm 命令入口会在动态加载业务模块前设置 REX_SSH_MCP_HOME，使配置和日志
 * 固定保存在用户目录，避免 npx 缓存清理、升级或工作目录变化导致数据丢失。
 * 自定义目录统一转成绝对路径，确保本次运行中的配置和日志使用同一位置。
 */
export const DATA_DIRECTORY = resolve(
  process.env.REX_SSH_MCP_HOME?.trim() || fileURLToPath(new URL('..', import.meta.url)),
);
