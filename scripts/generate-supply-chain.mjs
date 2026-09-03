import assert from 'node:assert/strict';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { packageMetadata, projectRoot } from './release-config.mjs';

const APPROVED_LICENSES = new Set(['Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT']);
const noticesPath = join(projectRoot, 'THIRD_PARTY_NOTICES.md');
const sbomPath = join(projectRoot, 'sbom.cyclonedx.json');
const checkOnly = process.argv.includes('--check');

function dependencyName(lockPath) {
  const marker = 'node_modules/';
  const offset = lockPath.lastIndexOf(marker);
  assert.ok(offset >= 0, `Unexpected npm-shrinkwrap path: ${lockPath}`);
  return lockPath.slice(offset + marker.length);
}

function packageUrl(name, version) {
  if (name.startsWith('@')) {
    const [scope, packageName] = name.slice(1).split('/');
    return `pkg:npm/%40${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function cyclonedxHash(integrity) {
  const separator = integrity.indexOf('-');
  assert.ok(separator > 0, 'Production dependency integrity is invalid');
  const algorithm = integrity.slice(0, separator).toLowerCase();
  const names = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' };
  assert.ok(names[algorithm], `Unsupported dependency integrity algorithm: ${algorithm}`);
  return {
    alg: names[algorithm],
    content: Buffer.from(integrity.slice(separator + 1), 'base64').toString('hex'),
  };
}

const manifest = await packageMetadata();
const lock = JSON.parse(await readFile(join(projectRoot, 'npm-shrinkwrap.json'), 'utf8'));
assert.equal(lock.lockfileVersion, 3, 'Release inventory requires npm-shrinkwrap v3');
assert.equal(lock.packages?.['']?.name, manifest.name);
assert.equal(lock.packages?.['']?.version, manifest.version);

const byPurl = new Map();
for (const [lockPath, item] of Object.entries(lock.packages ?? {})) {
  if (!lockPath || item.dev === true) continue;
  const name = dependencyName(lockPath);
  assert.ok(typeof item.version === 'string' && item.version, `Production dependency ${name} has no version`);
  assert.ok(typeof item.license === 'string' && APPROVED_LICENSES.has(item.license), `Production dependency ${name} requires license review`);
  assert.ok(typeof item.integrity === 'string' && item.integrity, `Production dependency ${name} has no integrity`);
  const purl = packageUrl(name, item.version);
  const candidate = {
    name,
    version: item.version,
    license: item.license,
    purl,
    integrity: item.integrity,
  };
  const existing = byPurl.get(purl);
  if (existing) assert.deepEqual(existing, candidate, `Conflicting lock entries for ${name}@${item.version}`);
  else byPurl.set(purl, candidate);
}
const dependencies = [...byPurl.values()].sort((a, b) =>
  a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
);
assert.ok(dependencies.length > 0, 'Production dependency inventory is empty');

const notices = [
  '# Third-party notices',
  '',
  'Generated deterministically from the production entries in the published `npm-shrinkwrap.json`. Do not edit by hand.',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...dependencies.map((item) => `| \`${item.name}\` | \`${item.version}\` | ${item.license} |`),
  '',
  'Each dependency remains subject to its own license terms. The exact archive integrity is recorded in `sbom.cyclonedx.json` and the published `npm-shrinkwrap.json`.',
  '',
].join('\n');

const sbom = `${JSON.stringify({
  $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    tools: [{ vendor: 'BailingHub', name: 'generate-supply-chain.mjs' }],
    component: {
      type: 'application',
      name: manifest.name,
      version: manifest.version,
      licenses: [{ license: { id: manifest.license } }],
      purl: packageUrl(manifest.name, manifest.version),
    },
    properties: [{ name: 'bailinghub:npm-shrinkwrap-version', value: String(lock.lockfileVersion) }],
  },
  components: dependencies.map((item) => ({
    type: 'library',
    'bom-ref': item.purl,
    name: item.name,
    version: item.version,
    scope: 'required',
    hashes: [cyclonedxHash(item.integrity)],
    licenses: [{ license: { id: item.license } }],
    purl: item.purl,
  })),
}, null, 2)}\n`;

async function updateOrCheck(path, expected) {
  if (checkOnly) {
    const current = await readFile(path, 'utf8').catch(() => undefined);
    assert.equal(current, expected, `${path.split('/').at(-1)} is missing or stale; run npm run supply-chain:generate`);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, expected, { encoding: 'utf8', mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

await updateOrCheck(noticesPath, notices);
await updateOrCheck(sbomPath, sbom);
process.stdout.write(`${checkOnly ? 'Verified' : 'Generated'} ${dependencies.length} production dependency notices and CycloneDX components.\n`);
