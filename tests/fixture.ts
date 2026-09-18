import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import ssh2, { type Connection, type SFTPWrapper, type Attributes } from 'ssh2';

export interface MemoryFile { data: Buffer; mode: number; uid: number; gid: number }
const status = ssh2.utils.sftp.STATUS_CODE;
const flags = ssh2.utils.sftp.OPEN_MODE;

/** 只在环回地址运行的测试 SSH/SFTP 服务，不执行真实 shell、不访问真实远端。 */
export async function startFixture(options: { dropFirst?: boolean; password?: string } = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const nodes = new Map<string, MemoryFile>([
    ['/hello.txt', { data: Buffer.from('你好\nsecond line\n'), mode: 0o100640, uid: 1000, gid: 1000 }],
    ['/binary', { data: Buffer.from([0, 1, 255]), mode: 0o100600, uid: 1000, gid: 1000 }],
    ['/link', { data: Buffer.from('/hello.txt'), mode: 0o120777, uid: 1000, gid: 1000 }],
  ]);
  const connections = new Set<Connection>();
  let accepted = 0;
  let executions = 0;
  let lastCommand = '';
  const password = options.password ?? 'test-only-password-!$中文';
  const server = new ssh2.Server({ hostKeys: [privateKey.export({ type: 'pkcs1', format: 'pem' })] }, (client) => {
    accepted++;
    connections.add(client);
    client.on('error', () => {});
    client.on('close', () => connections.delete(client));
    if (options.dropFirst && accepted === 1) { client.end(); return; }
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === 'test-user' && context.password === password) context.accept();
      else context.reject();
    });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        executions++;
        lastCommand = info.command;
        stream.on('error', () => {});
        // 配合客户端 stdin EOF；服务端仍须继续发送 stdout，保持半开状态。
        stream.resume();
        if (info.command === 'hang') return;
        if (info.command === 'slow') {
          // 用短延迟模拟配置切换时仍在执行的请求，验证旧连接代次会等待租约释放。
          setTimeout(() => { stream.write('slow complete\n'); stream.exit(0); stream.end(); }, 250);
          return;
        }
        if (info.command === 'disconnect') { client.end(); return; }
        if (info.command === 'large') {
          // 等待两条输出流写完，避免测试服务自身提前关闭而丢失尾部数据。
          stream.write(Buffer.alloc(1024 * 1024 + 32, 65), () => {
            stream.stderr.write(Buffer.alloc(1024 * 1024 + 32, 66), () => {
              stream.exit(0); stream.end();
            });
          });
          return;
        }
        if (info.command === 'secret') {
          // 分块输出密码，验证脱敏发生在组装完整输出之后。
          stream.write(password.slice(0, 8)); stream.write(password.slice(8));
          stream.stderr.write(password);
          stream.exit(0); stream.end(); return;
        }
        stream.write('stdout 测试\n'); stream.stderr.write('stderr 测试\n');
        stream.exit(info.command === 'fail' ? 7 : 0); stream.end();
      });
      session.on('sftp', (acceptSftp) => serveFiles(acceptSftp(), nodes));
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('Expected TCP test listener');
  return {
    config: { host: '127.0.0.1', port: address.port, username: 'test-user', password },
    nodes,
    get accepted() { return accepted; },
    get executions() { return executions; },
    get lastCommand() { return lastCommand; },
    drop: () => { for (const connection of connections) connection.end(); },
    close: async () => { for (const connection of connections) connection.end(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/** 最小内存文件系统用于真实 SFTP 报文测试；刻意不声明 OpenSSH 扩展以验证安全拒绝替换。 */
function serveFiles(sftp: SFTPWrapper, nodes: Map<string, MemoryFile>) {
  const handles = new Map<string, { path: string; directory?: boolean; listed?: boolean }>();
  let serial = 0;
  sftp.on('error', () => {});
  const attrs = (node: MemoryFile): Attributes => ({ ...node, size: node.data.length, atime: 1700000000, mtime: 1700000000 });
  const getPath = (handle: Buffer) => handles.get(handle.toString())?.path ?? '';
  const sendStat = (id: number, path: string) => {
    const node = nodes.get(path);
    if (!node) sftp.status(id, status.NO_SUCH_FILE); else sftp.attrs(id, attrs(node));
  };
  sftp.on('STAT', sendStat).on('LSTAT', sendStat);
  sftp.on('FSTAT', (id, handle) => sendStat(id, getPath(handle)));
  sftp.on('OPEN', (id, path, openFlags, attributes) => {
    if (path.startsWith('/denied')) { sftp.status(id, status.PERMISSION_DENIED); return; }
    let node = nodes.get(path);
    if (node && (openFlags & flags.EXCL)) { sftp.status(id, status.FAILURE); return; }
    if (!node && !(openFlags & flags.CREAT)) { sftp.status(id, status.NO_SUCH_FILE); return; }
    if (!node) { node = { data: Buffer.alloc(0), mode: 0o100000 | (attributes.mode ?? 0o600), uid: 1000, gid: 1000 }; nodes.set(path, node); }
    const handle = Buffer.from(String(++serial));
    handles.set(handle.toString(), { path }); sftp.handle(id, handle);
  });
  sftp.on('READ', (id, handle, offset, length) => {
    const node = nodes.get(getPath(handle));
    if (!node) sftp.status(id, status.FAILURE);
    else if (offset >= node.data.length) sftp.status(id, status.EOF);
    else sftp.data(id, node.data.subarray(offset, offset + length));
  });
  sftp.on('WRITE', (id, handle, offset, data) => {
    const node = nodes.get(getPath(handle));
    if (!node) { sftp.status(id, status.FAILURE); return; }
    const updated = Buffer.alloc(Math.max(node.data.length, offset + data.length));
    node.data.copy(updated); data.copy(updated, offset); node.data = updated;
    sftp.status(id, status.OK);
  });
  sftp.on('FSETSTAT', (id, handle, attributes) => {
    const node = nodes.get(getPath(handle));
    if (!node) { sftp.status(id, status.FAILURE); return; }
    if (attributes.mode !== undefined) node.mode = 0o100000 | attributes.mode;
    if (attributes.uid !== undefined) node.uid = attributes.uid;
    if (attributes.gid !== undefined) node.gid = attributes.gid;
    sftp.status(id, status.OK);
  });
  sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); sftp.status(id, status.OK); });
  sftp.on('REMOVE', (id, path) => { nodes.delete(path); sftp.status(id, status.OK); });
  sftp.on('RENAME', (id, from, to) => {
    const node = nodes.get(from);
    if (!node || nodes.has(to)) { sftp.status(id, status.FAILURE); return; }
    nodes.set(to, node); nodes.delete(from); sftp.status(id, status.OK);
  });
  sftp.on('OPENDIR', (id, path) => {
    if (path !== '/') { sftp.status(id, status.NO_SUCH_FILE); return; }
    const handle = Buffer.from(String(++serial)); handles.set(handle.toString(), { path, directory: true }); sftp.handle(id, handle);
  });
  sftp.on('READDIR', (id, handle) => {
    const entry = handles.get(handle.toString());
    if (!entry || entry.listed) { sftp.status(id, status.EOF); return; }
    entry.listed = true;
    sftp.name(id, [...nodes].map(([path, node]) => ({ filename: path.slice(1), longname: path.slice(1), attrs: attrs(node) })));
  });
}
