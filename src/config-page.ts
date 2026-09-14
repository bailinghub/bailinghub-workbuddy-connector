import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { openSystemBrowser } from 'bailinghub-mcp-server/sdk';

const MAX_FORM_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BRAND_MARK = `<svg class="mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="百灵中枢">
  <rect width="1024" height="1024" fill="#0d1117"/>
  <g transform="translate(60 32) scale(4)">
    <path fill="#3fb950" fill-rule="evenodd" d="M42 44h34v152H54l-12-12zM76 44h58v34H76zM76 103h22v34H76zM76 162h58v34H76zM150 44h22l12 12v8h-34zM150 86h34v110h-34z"/>
    <path fill="#56d364" fill-rule="evenodd" d="M116 103h68v34h-68zM76 162h58v34H76z"/>
  </g>
</svg>`;

export type ConnectionForm = {
  hubUrl: string;
  clientAppId: string;
  workspace: string;
  connectionName: string;
  linuxFileCredentialStoreConfirmed: boolean;
};

export type ConfigurationPageOptions = {
  platform?: NodeJS.Platform;
  initial?: Partial<ConnectionForm>;
  timeoutMs?: number;
  openBrowser?: (url: string) => Promise<void>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function page(body: string, title = '连接百灵中枢'): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:dark;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;background:#07100b;color:#f4fff7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:32px;background:radial-gradient(circle at 80% 10%,#123321 0,transparent 36%),linear-gradient(145deg,#050806,#0b1710)}
.card{width:min(720px,100%);border:1px solid #28593a;border-radius:24px;padding:clamp(24px,5vw,48px);background:rgba(10,22,14,.94);box-shadow:0 30px 90px rgba(0,0,0,.45)}
.brand{display:flex;align-items:center;gap:12px;color:#56d364;font-weight:800;letter-spacing:.04em}.mark{width:36px;height:36px;display:block;flex:0 0 auto}
h1{margin:28px 0 10px;font-size:clamp(30px,6vw,52px);line-height:1.05}p{color:#b8c9bd;line-height:1.7}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:28px}.wide{grid-column:1/-1}
label{display:grid;gap:8px;color:#dce8df;font-size:14px;font-weight:700}input{width:100%;border:1px solid #345540;border-radius:12px;background:#09120d;color:#fff;padding:14px 16px;font:inherit;outline:none}input:focus{border-color:#56d364;box-shadow:0 0 0 3px rgba(86,211,100,.12)}
.check{display:flex;align-items:flex-start;gap:12px;font-weight:500;line-height:1.55}.check input{width:18px;height:18px;margin-top:3px}.note{border:1px solid #57491c;background:#211d0d;color:#f4dfa1;border-radius:12px;padding:14px 16px}
button{width:100%;border:0;border-radius:14px;padding:16px 20px;background:#56d364;color:#061008;font:inherit;font-weight:900;cursor:pointer}small{color:#8da095}@media(max-width:620px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function configurationHtml(
  csrf: string,
  platform: NodeJS.Platform,
  initial: Partial<ConnectionForm>,
): string {
  const linuxNotice = platform === 'linux'
    ? `<div class="wide note"><label class="check"><input type="checkbox" name="linux_file_store" value="yes" required>
       <span>我确认在 Linux 上使用仅当前系统用户可读的 mode-0600 本地凭据文件。连接器不会把凭据写入 ZIP、Skill 或普通配置文件。</span></label></div>`
    : '';
  return page(`<div class="brand">${BRAND_MARK}<span>百灵中枢 · WorkBuddy</span></div>
    <h1>连接你的百灵中枢</h1>
    <p>这里只收集公开连接信息。提交后会打开业务系统自己的授权页；业务账号、密码、Token 和 Key 都不在本页填写。</p>
    <form method="post" action="/configure"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="grid">
        <label class="wide">百灵中枢地址<input name="hub_url" type="url" required maxlength="2048" placeholder="https://hub.example.com" value="${escapeHtml(initial.hubUrl ?? '')}"><small>你使用的百灵中枢（BailingHub）HTTPS 地址；本机调试可用 127.0.0.1。</small></label>
        <label>Client App ID<input name="client_app_id" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{1,63}" placeholder="merchant-agent" value="${escapeHtml(initial.clientAppId ?? '')}"></label>
        <label>Workspace<input name="workspace" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" placeholder="order-assistant" value="${escapeHtml(initial.workspace ?? '')}"></label>
        <label class="wide">连接名称<input name="connection_name" required maxlength="128" placeholder="my-business" value="${escapeHtml(initial.connectionName ?? 'default')}"><small>只是本机显示名称，不是业务身份。</small></label>
        ${linuxNotice}
        <div class="wide"><button type="submit">继续到业务授权</button></div>
      </div>
    </form>`);
}

function completedHtml(): string {
  return page(`<div class="brand">${BRAND_MARK}<span>百灵中枢 · WorkBuddy</span></div>
    <h1>连接信息已确认</h1><p>业务授权页将在新标签页打开。请在那里登录、选择业务身份并确认授权。</p>`, '连接信息已确认');
}

function formTooLargeHtml(): string {
  return page('<h1>无法保存配置</h1><p>提交的配置超过大小限制，未被保存。</p><p>请返回连接设置页并重试。</p>', '配置过大');
}

function normalizedHubUrl(value: string): string {
  if (!URL.canParse(value)) throw new Error('百灵中枢地址必须是完整 URL。');
  const url = new URL(value);
  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('百灵中枢必须使用 HTTPS，仅本机回环地址允许 HTTP。');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('百灵中枢地址不能包含凭据、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function parseConnectionForm(
  body: string,
  csrf: string,
  platform: NodeJS.Platform = process.platform,
): ConnectionForm {
  const input = new URLSearchParams(body);
  if (input.get('csrf') !== csrf) throw new Error('配置请求已失效，请重新发起连接。');
  const clientAppId = (input.get('client_app_id') ?? '').trim();
  const workspace = (input.get('workspace') ?? '').trim();
  const connectionName = (input.get('connection_name') ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(clientAppId)) throw new Error('Client App ID 格式不正确。');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(workspace)) throw new Error('Workspace 格式不正确。');
  if (!connectionName || connectionName.length > 128 || /[\u0000-\u001f\u007f]/.test(connectionName)) {
    throw new Error('连接名称格式不正确。');
  }
  const linuxConfirmed = input.get('linux_file_store') === 'yes';
  if (platform === 'linux' && !linuxConfirmed) {
    throw new Error('Linux 需要明确确认 mode-0600 本地凭据存储。');
  }
  return {
    hubUrl: normalizedHubUrl((input.get('hub_url') ?? '').trim()),
    clientAppId,
    workspace,
    connectionName,
    linuxFileCredentialStoreConfirmed: linuxConfirmed,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

export async function collectConnectionConfiguration(
  options: ConfigurationPageOptions = {},
): Promise<ConnectionForm> {
  const platform = options.platform ?? process.platform;
  const csrf = randomBytes(32).toString('base64url');
  let settle: { resolve(value: ConnectionForm): void; reject(error: Error): void } | undefined;
  let settled = false;
  const result = new Promise<ConnectionForm>((resolve, reject) => { settle = { resolve, reject }; });
  const server = createServer((request, response) => {
    response.setHeader('Connection', 'close');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.socket.remoteAddress && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(configurationHtml(csrf, platform, options.initial ?? {}));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/configure') {
      response.writeHead(404).end();
      return;
    }
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
      response.writeHead(415).end();
      return;
    }
    const rejectOversizedForm = () => {
      if (response.writableEnded) return;
      response.writeHead(413, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(formTooLargeHtml());
    };
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
      request.resume();
      rejectOversizedForm();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_FORM_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        rejectOversizedForm();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      if (settled) { response.writeHead(409).end(); return; }
      try {
        const form = parseConnectionForm(Buffer.concat(chunks).toString('utf8'), csrf, platform);
        settled = true;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(completedHtml(), () => settle?.resolve(form));
      } catch (error) {
        const message = error instanceof Error ? error.message : '配置无效。';
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page(`<h1>无法保存配置</h1><p>${escapeHtml(message)}</p><p>请关闭此页并重新发起连接。</p>`, '配置无效'));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('无法启动本地连接配置页。');
  }
  const url = `http://127.0.0.1:${address.port}/`;
  process.stderr.write(`BailingHub local configuration: ${url}\n`);
  try {
    await (options.openBrowser ?? openSystemBrowser)(url);
    let timeout: NodeJS.Timeout | undefined;
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('连接配置已超时。')), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
  } finally {
    await closeServer(server);
  }
}
