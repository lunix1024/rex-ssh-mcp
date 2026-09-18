import { AppError } from '../errors.js';
import { isDangerousCommand, shellEscape } from '../safety.js';
import type { SSHConnectionManager } from '../ssh.js';

export async function execute(ssh: SSHConnectionManager, command: string, timeout: number) {
  if (isDangerousCommand(command)) {
    throw new AppError('dangerous_command_blocked', 'This command is considered destructive and is blocked by default.');
  }
  return ssh.exec(command, timeout);
}

export async function tailFile(ssh: SSHConnectionManager, path: string, lines: number) {
  // path 无论包含引号、分号或 $(...) 都只作为单个路径传递，绝不拼接进 shell 语法。
  // tail 将单独的 '-' 解释为 stdin，即使存在 --；添加 ./ 后才是同名文件。
  const operand = path === '-' ? './-' : path;
  const result = await ssh.exec(`tail -n ${lines} -- ${shellEscape(operand)}`, 30);
  if (result.exitCode !== 0) {
    throw new AppError('tail_failed', `Unable to read the remote file tail: ${path}`, { ...result });
  }
  return { path, lines, ...result };
}
