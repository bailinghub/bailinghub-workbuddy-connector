import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import {
  connectorArtifactPath,
  connectorFileAllowlist,
  projectRoot,
} from './release-config.mjs';

const connectorRoot = join(projectRoot, 'connector');
const output = resolve(process.env.CONNECTOR_OUTPUT ?? await connectorArtifactPath());
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (44 << 9) | (1 << 5) | 1; // 2024-01-01 00:00:00

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Connector package must not contain symlinks: ${path}`);
    if (entry.isDirectory()) result.push(...await collect(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function localHeader(name, data, crc) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, data]);
}

function centralHeader(name, data, crc, offset) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBytes]);
}

const discoveredPaths = await collect(connectorRoot);
const discoveredNames = discoveredPaths
  .map((path) => relative(connectorRoot, path).split(sep).join('/'))
  .sort((a, b) => a.localeCompare(b, 'en'));
const expectedNames = [...connectorFileAllowlist].sort((a, b) => a.localeCompare(b, 'en'));
if (JSON.stringify(discoveredNames) !== JSON.stringify(expectedNames)) {
  const missing = expectedNames.filter((name) => !discoveredNames.includes(name));
  const extra = discoveredNames.filter((name) => !expectedNames.includes(name));
  throw new Error([
    'Connector package does not match the fixed five-file allowlist.',
    missing.length ? `Missing: ${missing.join(', ')}` : '',
    extra.length ? `Extra: ${extra.join(', ')}` : '',
  ].filter(Boolean).join(' '));
}
const paths = expectedNames.map((name) => join(connectorRoot, ...name.split('/')));
const localParts = [];
const centralParts = [];
let offset = 0;
for (const path of paths) {
  const info = await stat(path);
  if (info.size > 5 * 1024 * 1024) throw new Error(`Connector file is unexpectedly large: ${path}`);
  const data = await readFile(path);
  const name = relative(connectorRoot, path).split(sep).join('/');
  const crc = crc32(data);
  const local = localHeader(name, data, crc);
  localParts.push(local);
  centralParts.push(centralHeader(name, data, crc, offset));
  offset += local.length;
}
const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(paths.length, 8);
end.writeUInt16LE(paths.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([...localParts, central, end]));
process.stdout.write(`${output}\n`);
