import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { packageMetadata, projectRoot } from './release-config.mjs';

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run the installed graph check through npm run');

async function collectPackages(nodeModulesPath, result = new Set()) {
  const entries = await readdir(nodeModulesPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const candidate = join(nodeModulesPath, entry.name);
    if (entry.name.startsWith('@')) {
      await collectPackages(candidate, result);
      continue;
    }
    const manifestPath = join(candidate, 'package.json');
    const metadata = await stat(manifestPath).catch(() => undefined);
    if (!metadata?.isFile()) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
      result.add(`${manifest.name}@${manifest.version}`);
    }
    await collectPackages(join(candidate, 'node_modules'), result);
  }
  return result;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-install-check-'));
try {
  const manifest = await packageMetadata();
  const { stdout: packOutput } = await execute(process.execPath, [
    npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot,
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const pack = JSON.parse(packOutput);
  assert.ok(Array.isArray(pack) && pack.length === 1, 'Expected one npm package archive');
  const archive = join(temporaryRoot, pack[0].filename);
  const installRoot = join(temporaryRoot, 'install');
  await mkdir(installRoot);
  await writeFile(join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'bailinghub-workbuddy-install-check',
    version: '0.0.0',
    private: true,
  }, null, 2)}\n`);
  await execute(process.execPath, [
    npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', installRoot, archive,
  ], {
    cwd: temporaryRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  const installed = await collectPackages(join(installRoot, 'node_modules'));
  installed.delete(`${manifest.name}@${manifest.version}`);
  const sbom = JSON.parse(await readFile(join(projectRoot, 'sbom.cyclonedx.json'), 'utf8'));
  const expected = new Set(sbom.components.map((item) => `${item.name}@${item.version}`));
  assert.deepEqual([...installed].sort(), [...expected].sort(), 'Installed production graph differs from the published SBOM');

  const executable = join(installRoot, 'node_modules', manifest.name, 'dist', 'index.js');
  const { stdout: versionOutput } = await execute(process.execPath, [executable, '--version'], { encoding: 'utf8' });
  assert.equal(versionOutput.trim(), manifest.version, 'Installed CLI version check failed');
  process.stdout.write(`Installed tarball graph matches ${expected.size} SBOM components.\n`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
