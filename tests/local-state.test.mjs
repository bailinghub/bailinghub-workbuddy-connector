import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HostPreferencesStore, RuntimeBindingStore } from '../dist/local-state.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const INVOCATION_ID = 'a'.repeat(64);
const CONNECTION_KEY = `conn_${'b'.repeat(32)}`;

const timestamp = new Date().toISOString();
const runId = (index) => `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`;
const invocationId = (index) => index.toString(16).padStart(64, '0');
const runBinding = () => ({
  connectionKey: CONNECTION_KEY,
  workspace: 'orders',
  capabilityRevision: 'c'.repeat(64),
  activeTools: {},
});

test('runtime bindings persist only routing ids and active capability schemas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-state-'));
  const path = join(directory, 'runtime.json');
  try {
    const store = new RuntimeBindingStore(path);
    await store.putRun(RUN_ID, {
      connectionKey: CONNECTION_KEY,
      workspace: 'orders',
      capabilityRevision: 'c'.repeat(64),
      activeTools: {
        order_update: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
          additionalProperties: false,
        },
      },
    });
    await store.putInvocation(INVOCATION_ID, {
      connectionKey: CONNECTION_KEY,
      workspace: 'orders',
      runId: RUN_ID,
      state: 'awaiting_approval',
    });
    const raw = await readFile(path, 'utf8');
    assert.equal(raw.includes('customer@example.com'), false);
    assert.equal(raw.includes('user_input'), false);
    assert.equal(raw.includes('arguments'), false);
    assert.equal(raw.includes('business_response'), false);
    assert.equal((await store.getRun(RUN_ID)).capabilityRevision, 'c'.repeat(64));
    assert.equal((await store.getInvocation(INVOCATION_ID)).runId, RUN_ID);

    await store.replaceCapabilities(RUN_ID, 'd'.repeat(64), {
      order_refund: { type: 'object', properties: {}, additionalProperties: false },
    });
    const replaced = await store.getRun(RUN_ID);
    assert.deepEqual(Object.keys(replaced.activeTools), ['order_refund']);
    await store.completeRun(RUN_ID);
    await assert.rejects(() => store.getRun(RUN_ID), /no longer bound/);
    assert.equal((await new RuntimeBindingStore(path).getInvocation(INVOCATION_ID)).state, 'awaiting_approval');
    await store.removeInvocation(INVOCATION_ID);
    await assert.rejects(() => store.getInvocation(INVOCATION_ID), /no longer bound/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('active tool catalogs reject prototype-polluting names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-prototype-'));
  try {
    const store = new RuntimeBindingStore(join(directory, 'runtime.json'));
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const activeTools = JSON.parse(`{"${name}":{"type":"object","properties":{}}}`);
      await assert.rejects(() => store.putRun(RUN_ID, {
        connectionKey: CONNECTION_KEY,
        workspace: 'orders',
        capabilityRevision: 'c'.repeat(64),
        activeTools,
      }), /active tool set is invalid/);
    }
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('two independent stores serialize cross-process-style mutations without losing runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-concurrent-'));
  const path = join(directory, 'runtime.json');
  try {
    const stores = [new RuntimeBindingStore(path), new RuntimeBindingStore(path)];
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      stores[index % stores.length].putRun(runId(index + 1), runBinding()),
    ));
    const document = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(Object.keys(document.runs).length, 40);
    for (let index = 1; index <= 40; index += 1) {
      assert.ok(document.runs[runId(index)], `missing run ${index}`);
    }
    await assert.rejects(() => readFile(`${path}.lock`, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale mutation locks from dead processes are explicitly reclaimed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-stale-lock-'));
  const path = join(directory, 'runtime.json');
  const lockPath = `${path}.lock`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({
      schema_version: 1,
      pid: 2_147_483_647,
      token: 'd'.repeat(32),
      created_at: '2020-01-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 });
    await utimes(lockPath, new Date('2020-01-01T00:00:00.000Z'), new Date('2020-01-01T00:00:00.000Z'));
    const store = new RuntimeBindingStore(path);
    await store.putRun(runId(1), runBinding());
    assert.equal((await store.getRun(runId(1))).workspace, 'orders');
    await assert.rejects(() => readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime state fails closed at run and pending invocation limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-limits-'));
  try {
    const runsPath = join(directory, 'runs.json');
    const runs = {};
    for (let index = 1; index <= 512; index += 1) {
      runs[runId(index)] = { ...runBinding(), createdAt: timestamp, updatedAt: timestamp };
    }
    await writeFile(runsPath, `${JSON.stringify({ schema_version: 1, runs, invocations: {} })}\n`, { mode: 0o600 });
    await assert.rejects(
      () => new RuntimeBindingStore(runsPath).putRun(runId(513), runBinding()),
      /run limit reached/,
    );
    assert.equal(Object.keys(JSON.parse(await readFile(runsPath, 'utf8')).runs).length, 512);

    const invocationsPath = join(directory, 'invocations.json');
    const invocations = {};
    for (let index = 1; index <= 1_024; index += 1) {
      invocations[invocationId(index)] = {
        connectionKey: CONNECTION_KEY,
        workspace: 'orders',
        runId: RUN_ID,
        state: 'awaiting_approval',
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    }
    await writeFile(invocationsPath, `${JSON.stringify({ schema_version: 1, runs: {}, invocations })}\n`, { mode: 0o600 });
    await assert.rejects(
      () => new RuntimeBindingStore(invocationsPath).putInvocation('f'.repeat(64), {
        connectionKey: CONNECTION_KEY,
        workspace: 'orders',
        runId: RUN_ID,
        state: 'awaiting_approval',
      }),
      /pending invocation limit reached/,
    );
    assert.equal(Object.keys(JSON.parse(await readFile(invocationsPath, 'utf8')).invocations).length, 1_024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('POSIX state and preference files reject group or other permissions', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-permissions-'));
  try {
    const statePath = join(directory, 'runtime.json');
    const store = new RuntimeBindingStore(statePath);
    await store.putRun(RUN_ID, runBinding());
    await chmod(statePath, 0o640);
    await assert.rejects(() => new RuntimeBindingStore(statePath).getRun(RUN_ID), /group or other permissions/);

    const preferencesPath = join(directory, 'preferences.json');
    const preferences = new HostPreferencesStore(preferencesPath);
    await preferences.confirmLinuxFileCredentialStore();
    await chmod(preferencesPath, 0o604);
    await assert.rejects(() => preferences.linuxFileCredentialStoreConfirmed(), /group or other permissions/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
