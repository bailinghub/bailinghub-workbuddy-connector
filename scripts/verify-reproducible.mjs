import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-zip-'));
try {
  const outputs = [join(temporary, 'a.zip'), join(temporary, 'b.zip')];
  for (const output of outputs) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-connector.mjs', import.meta.url))], {
      env: { ...process.env, CONNECTOR_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  const hashes = await Promise.all(outputs.map(async (path) =>
    createHash('sha256').update(await readFile(path)).digest('hex'),
  ));
  assert.equal(hashes[0], hashes[1]);
  process.stdout.write(`Reproducible connector ZIP verified: ${hashes[0]}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
