# Rex SSH MCP

[English](README.en.md) | 简体中文

[![CI](https://github.com/lunix1024/rex-ssh-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/lunix1024/rex-ssh-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个通过 MCP 操作多台远程 Linux 服务器的本地 stdio 服务。每台服务器使用别名选择，密码由 Windows DPAPI 按当前用户加密保存；MCP 工具和聊天内容不接收密码。

## 环境要求

- Windows 10/11 或 Windows Server
- Node.js 22 或更高版本
- 允许密码认证和 SFTP 的远程 SSH 服务

克隆、安装并编译：

```powershell
git clone https://github.com/lunix1024/rex-ssh-mcp.git
Set-Location rex-ssh-mcp
npm install
npm run build
```

## 配置服务器

运行中文交互式配置界面：

```powershell
npm run config
```

Windows 下也可以直接双击项目根目录的 `config-servers.bat`。脚本会自动切换到项目目录、检查 Node.js/npm/依赖，并打开同一个配置界面；启动失败时窗口会保留错误信息。

TUI 支持查看、新增、编辑、修改密码、测试连接和删除服务器。密码输入会被遮罩，随后使用 Windows DPAPI `CurrentUser` 加密。配置保存在项目根目录的 `servers.json`，结构如下：

菜单中的每个选项都有编号：输入编号会定位并高亮对应项，按 Enter 确认，也可以使用方向键。所有子页面按 Esc 返回上一层，主菜单按 Esc 退出。编辑服务器信息时会先展示各字段当前值，可只选择需要修改的字段；多项修改保存在内存草稿中，选择“保存全部修改”后才会一次性写入配置。

```json
{
  "version": 1,
  "servers": [
    {
      "alias": "生产-148",
      "host": "192.0.2.148",
      "port": 22,
      "username": "operator",
      "encryptedPassword": "dpapi:v1:<由 TUI 生成的密文>",
      "hostFingerprint": "SHA256:可选的OpenSSH主机公钥指纹"
    }
  ]
}
```

不要手工填写或传递明文密码。`servers.json` 已加入 `.gitignore`；它只包含 DPAPI 密文，但仍应限制不受信任用户读取。DPAPI 密文与加密时的 Windows 用户上下文绑定：更换用户、重装系统或迁移机器后，需要重新录入密码。相同 Windows 用户下运行的程序有能力请求 DPAPI 解密，因此这是静态存储保护，不是对已被攻陷账户的隔离。

## 启动 MCP Server

```powershell
npm start
```

开发模式：

```powershell
npm run dev
```

这是 stdio MCP 服务，启动后会等待客户端通过 stdin 发送协议消息，不会打开浏览器，也不会在启动时连接 SSH。日志写入 `logs/rex-ssh-mcp.log`，并同步写到 stderr；stdout 仅用于 MCP 协议。

Codex 的 MCP 配置可指向：

```json
{
  "command": "node",
  "args": ["D:/path/to/rex-ssh-mcp/dist/index.js"]
}
```

请把示例路径替换为本机仓库的绝对路径。首次使用前先运行 `npm run build` 和 `npm run config`。

## 服务器选择规则

所有操作工具都要求 `server` 参数，并且只能使用配置中的准确别名。用户可以自然地说：

> 通过 MCP 检查 148 服务器的磁盘空间

模型应先调用 `ssh_list_servers`，用 `148` 过滤别名、主机/IP 和用户名。如果只有一个结果，就在后续每次工具调用中自动携带该规范别名；没有结果或存在多个结果时必须要求用户确认，不能猜测。服务端没有全局“当前服务器”，因此并发任务不会因切换目标而串到另一台机器。

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `ssh_list_servers` | 查询服务器别名、主机、端口、登录用户、指纹配置状态和连接状态 |
| `ssh_exec` | 执行非交互 shell 命令 |
| `ssh_read_file` | 读取 UTF-8 文本文件 |
| `ssh_write_file` | 原子写入 UTF-8 文本并可备份 |
| `ssh_list_dir` | 列出远程目录 |
| `ssh_stat` | 查看远程路径元数据 |
| `ssh_tail_file` | 读取日志末尾行 |
| `ssh_upload_file` | 上传本机文件 |
| `ssh_download_file` | 下载远程文件 |
| `ssh_reconnect` | 重载并立即验证指定服务器配置 |

除了 `ssh_list_servers` 外，每个工具都必须传入准确的 `server` 别名。配置文件变化会在下一次调用时自动生效：新请求使用新的连接代次，已经在执行的请求结束后旧连接才关闭。不同服务器分别懒连接并独立复用。

## 安全行为

- 密码不会出现在 MCP 参数、服务器列表、正常结果或错误结果中。
- 只有实际连接某台服务器时才解密该服务器密码；解密后立即加入全局日志和返回值脱敏集合。
- 重连或修改密码后，新旧密码都会继续脱敏，保护仍在结束的旧请求。
- DPAPI 调用使用固定 PowerShell 脚本，敏感数据只经过 stdin/stdout 管道，不进入命令行或环境变量。
- 可配置 OpenSSH SHA256 主机公钥指纹；正式环境建议启用。
- 常见的整机删除、格式化磁盘和关机命令会被阻止，但这不是完整 shell 沙箱。应使用权限受限的专用 SSH 账号。
- 命令、路径和非 SSH 密码的业务密钥可能进入运行日志，日志目录应只允许受信任的本机用户读取。

缺少 `servers.json` 或服务器列表为空时，MCP 仍能启动，`ssh_list_servers` 返回空列表；其他工具返回 `server_not_configured`。损坏配置、未知别名和 DPAPI 解密失败分别返回固定错误，不传播第三方错误文本。

## 测试

```powershell
npm test
```

测试使用本机环回 SSH/SFTP 服务，不连接真实服务器，覆盖配置校验、多服务器路由、连接复用与重连、热更新、危险命令、传输、输出限额以及多密码脱敏。DPAPI 往返测试仅在 Windows 运行。

## 参与贡献

欢迎提交 Issue 和 Pull Request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题请按照 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中披露凭据或漏洞细节。

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
