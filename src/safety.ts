/**
 * 有意采用集中、保守的启发式检查，而非尝试解析完整 shell 语法。
 * 可以覆盖常见绝对路径、sudo、引号和换行写法，但不构成安全沙箱。
 */
export function isDangerousCommand(command: string): boolean {
  const normalized = command.replace(/\\\r?\n/g, '').replace(/["'\\]/g, '').toLowerCase();
  if (/(?:^|[\s/;|&()`])(?:mkfs(?:\.[a-z0-9_]+)?|wipefs|shutdown|poweroff|reboot|halt)(?=$|[\s;|&()`])/.test(normalized)) return true;
  if (/(?:^|[\s/;|&()`])dd\s+[^;|&\n]*\bif\s*=/.test(normalized)) return true;
  // systemctl 的电源操作与独立 reboot/shutdown 命令同样危险。
  if (/\bsystemctl\s+(?:[^;|&\n]*\s)?(?:reboot|poweroff|halt|kexec|soft-reboot)\b/.test(normalized)) return true;
  for (const segment of normalized.split(/[;|&\n]/)) {
    if (!/(?:^|[\s/])rm\s/.test(segment)) continue;
    const tokens = segment.trim().split(/\s+/);
    const recursive = tokens.some((token) => token === '--recursive' || /^-[a-z]*r[a-z]*$/.test(token));
    const rootTarget = tokens.some((token) => /^\/+(?:[.*]|\.\.)?\/*$/.test(token));
    if (recursive && rootTarget) return true;
  }
  return false;
}

/** POSIX shell 单引号转义；调用方同时使用 -- 防止文件名被解释为选项。 */
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
