import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export interface SecretProtector {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

const PREFIX = 'dpapi:v1:';
const ENTROPY_TEXT = 'rex-mcp:ssh-password:v1';
const POWERSHELL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputBase64 = [Console]::In.ReadToEnd().Trim()
  $plain = [Convert]::FromBase64String($inputBase64)
  $entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY_TEXT}')
  $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($cipher))
  [Array]::Clear($plain, 0, $plain.Length)
} catch { exit 1 }
`;

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $inputBase64 = [Console]::In.ReadToEnd().Trim()
  $cipher = [Convert]::FromBase64String($inputBase64)
  $entropy = [Text.Encoding]::UTF8.GetBytes('${ENTROPY_TEXT}')
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($plain))
  [Array]::Clear($plain, 0, $plain.Length)
} catch { exit 1 }
`;

/** Windows DPAPI CurrentUser 适配器；敏感内容只经 stdin/stdout 管道传递，不进入参数和环境。 */
export class WindowsDpapiProtector implements SecretProtector {
  async encrypt(plaintext: string): Promise<string> {
    if (!plaintext) throw new AppError('invalid_password', 'The SSH password must not be empty.');
    const input = Buffer.from(plaintext, 'utf8');
    try {
      const encrypted = await runPowerShell(protectScript, input.toString('base64'), 'credential_encryption_failed');
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new AppError('credential_encryption_failed', 'Unable to encrypt the SSH password.');
      return `${PREFIX}${encrypted}`;
    } finally { input.fill(0); }
  }

  async decrypt(ciphertext: string): Promise<string> {
    if (!ciphertext.startsWith(PREFIX)) throw new AppError('credential_decryption_failed', 'Unable to decrypt the configured SSH password.');
    const encoded = ciphertext.slice(PREFIX.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new AppError('credential_decryption_failed', 'Unable to decrypt the configured SSH password.');
    const plainBase64 = await runPowerShell(unprotectScript, encoded, 'credential_decryption_failed');
    const plain = Buffer.from(plainBase64, 'base64');
    try {
      const password = new TextDecoder('utf-8', { fatal: true }).decode(plain);
      if (!password) throw new AppError('credential_decryption_failed', 'Unable to decrypt the configured SSH password.');
      return password;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('credential_decryption_failed', 'Unable to decrypt the configured SSH password.');
    } finally { plain.fill(0); }
  }
}

function runPowerShell(script: string, stdin: string, code: string): Promise<string> {
  if (process.platform !== 'win32') return Promise.reject(new AppError('dpapi_unavailable', 'Windows DPAPI is only available on Windows.'));
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = Buffer.alloc(0);
    let exceeded = false;
    const timer = setTimeout(() => child.kill(), POWERSHELL_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) { exceeded = true; child.kill(); return; }
      stdout = Buffer.concat([stdout, chunk]);
    });
    // 第三方错误文本不传播；监听并丢弃可避免管道阻塞。
    child.stderr.resume();
    child.once('error', () => { clearTimeout(timer); reject(new AppError(code, fixedMessage(code))); });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0 || exceeded) { reject(new AppError(code, fixedMessage(code))); return; }
      const result = stdout.toString('utf8').trim();
      stdout.fill(0);
      resolve(result);
    });
    child.stdin.end(stdin, 'utf8');
  });
}

function fixedMessage(code: string): string {
  return code === 'credential_encryption_failed' ? 'Unable to encrypt the SSH password.' : 'Unable to decrypt the configured SSH password.';
}
