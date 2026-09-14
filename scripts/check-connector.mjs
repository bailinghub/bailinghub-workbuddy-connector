import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PACKAGE_NAME, PACKAGE_VERSION } from '../dist/constants.js';

const root = new URL('../connector/', import.meta.url);
const json = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const meta = await json('connector-meta.json');
const mcp = await json('mcp.json');
const cli = await json('cli.json');
const packageSpec = `${packageManifest.name}@${packageManifest.version}`;

assert.equal(PACKAGE_NAME, packageManifest.name);
assert.equal(PACKAGE_VERSION, packageManifest.version);
assert.match(meta.source, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.equal(meta.type, 'mcp');
assert.equal(meta.version, packageManifest.version);
assert.equal(meta.minWorkbuddyVersion, '5.0.0');
assert.equal(meta.name, '百灵中枢');
assert.equal(meta.name_zh, '百灵中枢');
assert.match(meta.name_en, /BailingHub/);
assert.match(meta.description_zh, /BailingHub/);
assert.ok(meta.description && meta.description_en);
assert.ok([...meta.description_en].length <= 100, 'Marketplace English description must be at most 100 characters');
assert.match(meta.description_zh, /最终权限/);
assert.match(meta.description_zh, /系统决定/);
assert.ok(Array.isArray(meta.examples_zh) && meta.examples_zh.length >= 2);
assert.ok(Array.isArray(meta.examples_en) && meta.examples_en.length >= 2);

assert.equal(mcp.preAuth, 'cli');
assert.deepEqual(Object.keys(mcp.mcpServers), ['bailinghub-agent-client']);
const server = mcp.mcpServers['bailinghub-agent-client'];
assert.equal(server.type, 'stdio');
assert.equal(server.command, 'npx');
assert.deepEqual(server.args, ['-y', packageSpec, 'mcp']);
assert.equal(server.runtime.type, 'node');
assert.equal(server.runtime.version, packageManifest.engines.node);
assert.deepEqual(cli.runtime, { type: 'node', version: packageManifest.engines.node });
assert.equal('env' in server, false);
assert.equal('staticEnv' in server, false);

for (const section of ['init', 'auth', 'unAuth', 'status']) {
  assert.deepEqual(Object.keys(cli[section]).sort(), ['darwin', 'linux', 'win32']);
}
for (const platform of ['darwin', 'linux', 'win32']) {
  assert.equal(cli.init[platform], `node --version && npm --version && npm install -g ${packageSpec}`);
}
assert.equal(cli.versionCheck.minVersion, packageManifest.version);
assert.deepEqual(cli.statusMatchJson, { authenticated: 'true' });
assert.equal('statusMatch' in cli, false, 'Use statusMatchJson exclusively');
assert.equal(cli.authWaitForExit, true);
assert.equal(cli.authSuppressBrowser, true);
assert.equal('env' in cli, false, 'Linux file credential fallback must not be enabled by the manifest');

const skill = await readFile(new URL('skills/bailinghub-agent-client/SKILL.md', root), 'utf8');
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');
for (const field of ['name', 'description', 'description_zh', 'description_en', 'version', 'author']) {
  assert.match(frontmatter[1], new RegExp(`^${field}:\\s*\\S.+$`, 'm'), `SKILL.md is missing ${field}`);
}
assert.match(frontmatter[1], new RegExp(`^version:\\s*${packageManifest.version.replaceAll('.', '\\.')}\\s*$`, 'm'));
for (const tool of [
  'start_business_turn',
  'search_business_capabilities',
  'invoke_business_capability',
  'resume_governed_tool_invocation',
  'complete_business_run',
]) assert.match(skill, new RegExp(`\\b${tool}\\b`));
for (const forbidden of ['connections_add', 'connections_use', 'connections_remove', 'BAILINGHUB_CLIENT_TOKEN=']) {
  assert.equal(skill.includes(forbidden), false);
}

process.stdout.write('WorkBuddy connector manifest check passed.\n');
