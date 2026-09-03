import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const connectorFileAllowlist = Object.freeze([
  'cli.json',
  'connector-meta.json',
  'icon.svg',
  'mcp.json',
  'skills/bailinghub-agent-client/SKILL.md',
]);

export const npmFileAllowlist = Object.freeze([
  'LICENSE',
  'NOTICE',
  'PRIVACY.md',
  'README.md',
  'README.zh-CN.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'dist/cli.d.ts',
  'dist/cli.js',
  'dist/config-page.d.ts',
  'dist/config-page.js',
  'dist/connection.d.ts',
  'dist/connection.js',
  'dist/constants.d.ts',
  'dist/constants.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/local-state.d.ts',
  'dist/local-state.js',
  'dist/mcp.d.ts',
  'dist/mcp.js',
  'npm-shrinkwrap.json',
  'package.json',
  'sbom.cyclonedx.json',
]);

export async function packageMetadata() {
  return JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
}

export async function connectorArtifactPath() {
  const manifest = await packageMetadata();
  return join(projectRoot, 'artifacts', `${manifest.name}-${manifest.version}.zip`);
}
