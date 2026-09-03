import { lstat, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { projectRoot } from './release-config.mjs';

const dist = join(projectRoot, 'dist');
if (relative(projectRoot, dist) !== 'dist') {
  throw new Error('Refusing to clean an unexpected path.');
}
const existing = await lstat(dist).catch((error) => {
  if (error?.code === 'ENOENT') return undefined;
  throw error;
});
if (existing?.isSymbolicLink()) throw new Error('Refusing to clean a symlinked dist directory.');
await rm(dist, { recursive: true, force: true });
