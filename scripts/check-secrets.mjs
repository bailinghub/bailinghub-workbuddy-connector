import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';

import { connectorArtifactPath, projectRoot } from './release-config.mjs';

const ignoredDirectories = new Set(['node_modules', 'artifacts', '.git']);
const textExtensions = new Set(['.json', '.md', '.ts', '.mjs', '.js', '.svg', '.txt', '']);
const MAX_DENYLIST_BYTES = 1024 * 1024;
const genericRules = [
  { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Tencent Cloud access key', pattern: /\bAKID[A-Za-z0-9]{28,40}\b/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/ },
  { name: 'URL credentials', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: 'authorization code in URL', pattern: /[?&](?:code|auth_code|authorization_code|authorization_id)=[A-Za-z0-9._~-]{8,}/i },
  { name: 'embedded bearer token', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/i },
  { name: 'embedded secret assignment', pattern: /["'](?:client[_-]?token|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token)["']\s*[:=]\s*["'][^${}\s][^"']{7,}["']/i },
  { name: 'macOS user path', pattern: /(?:^|[\s("'`=])\/Users\/[A-Za-z0-9._-]+\/[^\s"'`<>]+/m },
  { name: 'Linux user path', pattern: /(?:^|[\s("'`=])\/home\/[A-Za-z0-9._-]+\/[^\s"'`<>]+/m },
  { name: 'Windows user path', pattern: /(?:^|[\s("'`=])[A-Za-z]:\\Users\\[^\\\s"'`<>]+\\[^\s"'`<>]+/m },
];

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // In a linked worktree .git is a metadata pointer file, never a release file.
    if (entry.name === '.git') continue;
    if (ignoredDirectories.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`Secret scan refuses a symbolic link: ${relative(projectRoot, join(directory, entry.name))}`);
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name))) result.push(path);
  }
  return result;
}

async function externalExactRules() {
  const configuredPath = process.env.BAILING_PUBLIC_DENYLIST_FILE?.trim();
  if (!configuredPath) return [];
  const resolvedPath = resolve(configuredPath);
  const fileLabel = basename(resolvedPath);
  try {
    const location = relative(projectRoot, resolvedPath);
    if (location === '' || (location !== '..' && !location.startsWith(`..${sep}`))) {
      throw new Error('denylist must remain outside the repository');
    }
    const info = await lstat(resolvedPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_DENYLIST_BYTES) {
      throw new Error('unsafe denylist');
    }
    const parsed = JSON.parse(await readFile(resolvedPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid shape');
    const rules = [];
    for (const [name, rawValues] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/.test(name)) throw new Error('invalid rule name');
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      if (values.length === 0 || values.some((value) => typeof value !== 'string' || !value || value.length > 4096)) {
        throw new Error('invalid exact value');
      }
      rules.push({ name: `exact denylist: ${name}`, values });
    }
    return rules;
  } catch {
    throw new Error(`Unable to read a valid external exact denylist file: ${fileLabel}`);
  }
}

function zipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50 || offset + 30 > buffer.length) {
      throw new Error('Connector ZIP has an invalid local file header.');
    }
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if ((flags & 0x0008) !== 0 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('Connector ZIP must use deterministic stored entries without data descriptors.');
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error('Connector ZIP entry exceeds the archive boundary.');
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    if (!name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') || name.includes('\0')) {
      throw new Error('Connector ZIP contains an unsafe entry name.');
    }
    entries.push({ name, content: buffer.subarray(dataStart, dataEnd).toString('utf8') });
    offset = dataEnd;
  }
  if (entries.length === 0) throw new Error('Connector ZIP does not contain any files.');
  return entries;
}

const exactRules = await externalExactRules();
const failures = new Set();
function scan(label, content) {
  for (const rule of genericRules) {
    if (rule.pattern.test(content)) failures.add(`${label}: ${rule.name}`);
  }
  for (const rule of exactRules) {
    if (rule.values.some((value) => content.includes(value))) failures.add(`${label}: ${rule.name}`);
  }
}

const files = (await sourceFiles(projectRoot)).sort((a, b) => a.localeCompare(b, 'en'));
for (const path of files) scan(relative(projectRoot, path), await readFile(path, 'utf8'));

const artifactPath = await connectorArtifactPath();
let archive;
try {
  archive = await readFile(artifactPath);
} catch {
  throw new Error(`Final connector ZIP is missing: ${basename(artifactPath)}`);
}
const entries = zipEntries(archive);
for (const entry of entries) scan(`${basename(artifactPath)}!/${entry.name}`, entry.content);

if (failures.size > 0) {
  process.stderr.write(`Secret scan failed:\n${[...failures].sort().map((item) => `- ${item}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed across ${files.length} source/compiled files and ${entries.length} ZIP entries.\n`);
