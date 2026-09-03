import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { npmFileAllowlist, packageMetadata, projectRoot } from './release-config.mjs';

const execute = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run the npm pack check through npm run');
const { stdout } = await execute(process.execPath, [npmCli, 'pack', '--dry-run', '--ignore-scripts', '--json'], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
const report = JSON.parse(stdout);
assert.ok(Array.isArray(report) && report.length === 1, 'npm pack must describe exactly one package');
const candidate = report[0];
const manifest = await packageMetadata();
assert.equal(candidate.id, `${manifest.name}@${manifest.version}`);
assert.equal(candidate.filename, `${manifest.name}-${manifest.version}.tgz`);

const actual = candidate.files.map((file) => file.path).sort((a, b) => a.localeCompare(b, 'en'));
const expected = [...npmFileAllowlist].sort((a, b) => a.localeCompare(b, 'en'));
assert.deepEqual(actual, expected, 'npm pack content differs from the fixed release allowlist');
const executable = candidate.files.find((file) => file.path === 'dist/index.js');
assert.ok(executable, 'npm executable is missing');
if (process.platform !== 'win32') {
  assert.ok((executable.mode & 0o111) !== 0, 'npm executable must retain an execute bit on POSIX');
}

process.stdout.write(`npm pack allowlist passed for ${actual.length} files.\n`);
