# Rex SSH MCP

English | [简体中文](README.md)

[![CI](https://github.com/lunix1024/rex-ssh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/lunix1024/rex-ssh-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A local stdio MCP server for operating multiple remote Linux hosts over SSH. Hosts are selected by alias, while passwords are encrypted for the current Windows user with DPAPI and never accepted through MCP tool arguments or chat.

## Features

- Execute non-interactive commands on explicitly selected hosts.
- Read, write, inspect, upload, and download files through SFTP.
- Manage multiple server profiles through a Chinese interactive terminal UI.
- Reuse connections independently per host and reload changed configuration safely.
- Redact configured passwords from normal results, errors, and logs.
- Optionally verify OpenSSH SHA256 host-key fingerprints.
- Block a small set of common catastrophic commands as a last line of defense.

## Requirements

- Windows 10/11 or Windows Server
- Node.js 22 or newer
- Remote SSH servers with password authentication and SFTP enabled

Windows is required because stored credentials use DPAPI `CurrentUser` protection.

## Quick start

The repository is ready to package for npm. Registry commands below require the maintainer to publish the corresponding version first.

Configure hosts in an interactive Windows terminal, then configure your MCP client:

```powershell
npx -y rex-ssh-mcp config
```

```json
{
  "command": "npx",
  "args": ["-y", "rex-ssh-mcp"]
}
```

If a Windows client cannot launch `npx` directly, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "rex-ssh-mcp"]`. Use `rex-ssh-mcp@2.0.0` to pin the version. Global installation with `npm install -g rex-ssh-mcp` is also supported.

The npm CLI stores `servers.json` and `logs/rex-ssh-mcp.log` under `~/.rex-ssh-mcp`, independently of the npm cache and working directory. Use `--help` to see the actual paths or `--version` to check the version. Set `REX_SSH_MCP_HOME` to override the data directory in both the configuration terminal and the MCP client's `env`.

For existing users, point that variable to the repository directory or copy the existing `servers.json` into the user directory under the same Windows account. Credentials must be re-entered when changing machines or Windows accounts.

## Run from source

```powershell
git clone https://github.com/lunix1024/rex-ssh-mcp.git
Set-Location rex-ssh-mcp
npm install
npm run build
npm run config
```

You can also double-click `config-servers.bat` to open the same configuration UI. Source entry points use the repository directory by default, preserving existing setups; `REX_SSH_MCP_HOME` overrides this location too. The local `servers.json` is ignored by Git. Do not edit passwords into that file manually.

Adding a host asks for its alias, hostname/IP, port, username, and password once. Password changes also require a single entry. The UI no longer asks for host-key fingerprints; existing `hostFingerprint` values remain enforced and can be configured manually in `servers.json`.

Start the stdio server with:

```powershell
npm start
```

Example MCP client configuration:

```json
{
  "command": "node",
  "args": ["D:/path/to/rex-ssh-mcp/dist/index.js"]
}
```

Replace the example with the absolute path on your computer. Build and configure the project before connecting an MCP client.

## Tools

| Tool | Purpose |
| --- | --- |
| `ssh_list_servers` | Find configured hosts without returning secrets |
| `ssh_exec` | Execute a non-interactive shell command |
| `ssh_read_file` | Read a UTF-8 text file |
| `ssh_write_file` | Atomically write UTF-8 text with optional backup |
| `ssh_list_dir` | List a remote directory |
| `ssh_stat` | Inspect remote path metadata |
| `ssh_tail_file` | Read the end of a remote log file |
| `ssh_upload_file` | Upload a local file through SFTP |
| `ssh_download_file` | Download a remote file through SFTP |
| `ssh_reconnect` | Reload and validate one host profile |

Every operation except `ssh_list_servers` requires an exact configured server alias.

## Security notes

DPAPI protects credentials at rest but does not isolate them from software already running as the same compromised Windows user. The dangerous-command check is deliberately limited and is not a shell sandbox. Use a dedicated, least-privileged SSH account, configure host-key fingerprints for production hosts, and restrict access to the local log directory.

Commands, paths, and non-SSH secrets printed by remote programs may be written to `logs/rex-ssh-mcp.log`. Review the log before sharing it.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting.

## Development

```powershell
npm test
```

The test suite uses an in-process loopback SSH/SFTP server and does not connect to configured production hosts. DPAPI round-trip coverage runs only on Windows.

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

[MIT](LICENSE)
