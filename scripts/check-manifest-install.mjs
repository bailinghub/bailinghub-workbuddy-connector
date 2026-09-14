import assert from 'node:assert/strict';
import { exec, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { STATIC_TOOL_NAMES } from '../dist/constants.js';
import { packageMetadata, projectRoot } from './release-config.mjs';

// Exercise the submitted commands, not `node dist/index.js`. This harness models
// a prepared Node runtime. It does not test WorkBuddy's runtime download/resolver.
const execute = promisify(execFile);
const shellExecute = promisify(exec);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run the manifest installation check through npm run');
const manifest = await packageMetadata();
const cli = JSON.parse(await readFile(join(projectRoot, 'connector/cli.json'), 'utf8'));
const mcp = JSON.parse(await readFile(join(projectRoot, 'connector/mcp.json'), 'utf8'));
const shrinkwrap = JSON.parse(await readFile(join(projectRoot, 'npm-shrinkwrap.json'), 'utf8'));
const publicDependencyPaths = new Set();
for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
  if (!path || entry.dev) continue;
  publicDependencyPaths.add(`/${path.split('node_modules/').at(-1)}`);
  const resolved = new URL(entry.resolved);
  assert.equal(resolved.origin, 'https://registry.npmjs.org');
  publicDependencyPaths.add(decodeURIComponent(resolved.pathname));
}
const temporary = await mkdtemp(join(tmpdir(), 'workbuddy manifest '));
const runtime = join(temporary, 'managed node');
const prefix = join(temporary, 'global packages');
const userHome = join(temporary, 'isolated user');
const cache = join(temporary, 'empty npm cache');
const userConfig = join(temporary, 'empty-user.npmrc');
const globalConfig = join(temporary, 'empty-global.npmrc');
const registryRequests = [];
let registry;
let client;
let transport;

try {
  for (const directory of [runtime, prefix, userHome, cache]) await mkdir(directory);
  await writeFile(userConfig, '');
  await writeFile(globalConfig, '');
  const { stdout } = await execute(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: projectRoot, maxBuffer: 10 * 1024 * 1024,
  });
  const packed = JSON.parse(stdout)[0];
  const archive = await readFile(join(temporary, packed.filename));
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  assert.equal(packed.integrity, integrity);

  // Stage the trusted local runtime/npm, but exclude setup-node/Homebrew and user
  // directories from PATH. Spaces cover a common Windows installation failure.
  const npmRoot = dirname(dirname(await realpath(npmCli)));
  const isolatedNpm = join(runtime, 'node_modules', 'npm');
  await cp(npmRoot, isolatedNpm, { recursive: true });
  if (process.platform === 'win32') await copyFile(process.execPath, join(runtime, 'node.exe'));
  else await symlink(process.execPath, join(runtime, 'node'));
  if (process.platform === 'win32') {
    for (const name of ['npm.cmd', 'npx.cmd']) await copyFile(join(npmRoot, 'bin', name), join(runtime, name));
  } else {
    for (const name of ['npm', 'npx']) await symlink(join(isolatedNpm, 'bin', `${name}-cli.js`), join(runtime, name));
    // npm exec launches a shell by name; expose only the OS shell, not /usr/bin
    // (which may contain an unrelated system Node/npm).
    await symlink('/bin/sh', join(runtime, 'sh'));
  }
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const systemPath = process.platform === 'win32' ? join(systemRoot, 'System32') : '';
  const globalBin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const env = {
    HOME: userHome, USERPROFILE: userHome,
    APPDATA: join(userHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(userHome, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(userHome, '.config'),
    TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    PATH: [globalBin, runtime, systemPath].filter(Boolean).join(delimiter),
    npm_config_prefix: prefix, npm_config_cache: cache,
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  };
  if (process.platform === 'win32') {
    env.SystemRoot = systemRoot;
    env.ComSpec = join(systemRoot, 'System32', 'cmd.exe');
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }
  const commandOptions = {
    cwd: userHome, env, shell: process.platform === 'win32' ? env.ComSpec : '/bin/sh',
    timeout: 180_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  };
  for (const command of ['node --version', 'npm --version']) {
    await assert.rejects(shellExecute(command, {
      ...commandOptions, env: { ...env, PATH: systemPath || join(temporary, 'no-runtime') },
    }), 'The negative control must not find a host Node/npm');
  }
  // Only candidate content is synthesized. Allow-listed public dependency
  // metadata/tarballs are proxied from npmjs; shrinkwrap governs integrity.
  registry = createServer(async (request, response) => {
    registryRequests.push(request.url);
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === `/${manifest.name}`) {
      const address = registry.address();
      // npm adds this flag when publishing a package containing shrinkwrap.
      // Without it a fixture would incorrectly model an unlocked registry pack.
      const candidate = { ...manifest, _hasShrinkwrap: true, dist: {
        tarball: `http://127.0.0.1:${address.port}/${manifest.name}/-/candidate.tgz`, integrity,
      } };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name: manifest.name, 'dist-tags': { latest: manifest.version },
        versions: { [manifest.version]: candidate },
      }));
    } else if (url.pathname === `/${manifest.name}/-/candidate.tgz`) {
      response.setHeader('content-type', 'application/octet-stream');
      response.end(archive);
    } else if (request.method === 'GET' && publicDependencyPaths.has(decodeURIComponent(url.pathname))) {
      // npm may request metadata before unpacking shrinkwrap or rewrite the
      // default registry tarball host. Proxy only these declared public paths,
      // with no inherited authentication/configuration or forwarded headers.
      try {
        const upstream = await fetch(new URL(url.pathname, 'https://registry.npmjs.org'), {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
          signal: AbortSignal.timeout(30_000),
        });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502).end('Public dependency fetch failed');
      }
    } else {
      response.writeHead(404).end(JSON.stringify({ error: 'Unexpected fixture registry request' }));
    }
  });
  await new Promise((resolve, reject) => {
    registry.once('error', reject);
    registry.listen(0, '127.0.0.1', resolve);
  });
  env.npm_config_registry = `http://127.0.0.1:${registry.address().port}`;
  const install = await shellExecute(cli.init[process.platform], commandOptions);
  assert.match(install.stdout, /v\d+\.\d+\.\d+/);
  const version = await shellExecute(cli.versionCheck.command[process.platform], commandOptions);
  assert.equal(version.stdout.trim(), manifest.version);
  const status = await shellExecute(cli.status[process.platform], commandOptions);
  assert.deepEqual(JSON.parse(status.stdout), { authenticated: false, state: 'unconfigured' });
  const installedPackage = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', manifest.name);
  const installed = JSON.parse(await readFile(join(installedPackage, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version);
  assert.equal(installed.dependencies['bailinghub-mcp-server'], '0.5.0');
  const installedSdk = JSON.parse(await readFile(join(installedPackage, 'node_modules/bailinghub-mcp-server/package.json'), 'utf8'));
  assert.equal(installedSdk.version, '0.5.0');

  // Use the submitted npx command/args and an actual MCP handshake. No account,
  // authorization page, Hub request or business invocation is needed to list tools.
  const server = mcp.mcpServers['bailinghub-agent-client'];
  transport = new StdioClientTransport({ command: server.command, args: server.args, env, cwd: userHome, stderr: 'pipe' });
  let startupError = '';
  transport.stderr?.on('data', (chunk) => { startupError = (startupError + chunk.toString()).slice(-4096); });
  client = new Client({ name: 'connector-install-check', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 30_000 });
  } catch (error) {
    throw new Error(`Manifest MCP startup failed: ${startupError}`, { cause: error });
  }
  assert.equal(client.getServerVersion().version, manifest.version);
  const listed = await client.listTools({}, { timeout: 10_000 });
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...STATIC_TOOL_NAMES].sort());
  assert.ok(registryRequests.includes(`/${manifest.name}/-/candidate.tgz`));
  process.stdout.write(`${JSON.stringify({
    platform: process.platform, node: process.version, package: packed.id,
    archiveIntegrity: integrity, isolatedPath: true, emptyCache: true,
    negativeMissingRuntime: 'passed', manifestInit: 'passed', manifestVersion: 'passed',
    unconfiguredStatus: 'passed', mcpStdio: 'passed', tools: listed.tools.length,
    scope: 'prepared-runtime harness; WorkBuddy runtime provisioning and marketplace review are separate',
  }, null, 2)}\n`);
} finally {
  if (client) await client.close();
  if (transport) await transport.close();
  if (registry?.listening) await new Promise((resolve) => {
    registry.close(resolve);
    registry.closeAllConnections();
  });
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
