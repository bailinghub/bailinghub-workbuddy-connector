import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { defaultConnectionRegistryPath } from 'bailinghub-mcp-server/sdk';

import { STORAGE_NAMESPACE } from './constants.js';

const RUN_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const CONNECTION_KEY_PATTERN = /^conn_[a-f0-9]{32}$/;
const INVOCATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_TOOL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RUNS = 512;
const MAX_INVOCATIONS = 1_024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MUTATION_LOCK_WAIT_MS = 5_000;
const MUTATION_LOCK_POLL_MS = 25;
const MUTATION_LOCK_STALE_MS = 30_000;

export type RunBinding = {
  connectionKey: string;
  workspace: string;
  capabilityRevision: string;
  activeTools: Record<string, Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
};

export type InvocationBinding = Pick<RunBinding, 'connectionKey' | 'workspace'> & {
  runId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
};

type RuntimeDocument = {
  schema_version: 1;
  runs: Record<string, RunBinding>;
  invocations: Record<string, InvocationBinding>;
};

type PreferencesDocument = {
  schema_version: 1;
  linux_file_credential_store_confirmed: boolean;
};

function hostStorageRoot(): string {
  return dirname(defaultConnectionRegistryPath(STORAGE_NAMESPACE));
}

export function defaultRuntimeStatePath(): string {
  return join(hostStorageRoot(), 'workbuddy-runtime-bindings.json');
}

export function defaultPreferencesPath(): string {
  return join(hostStorageRoot(), 'workbuddy-preferences.json');
}

function emptyRuntimeDocument(): RuntimeDocument {
  return { schema_version: 1, runs: {}, invocations: {} };
}

function safeWorkspace(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new Error('Stored WorkBuddy workspace is invalid.');
  }
  return value;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Stored WorkBuddy timestamp is invalid.');
  }
  return value;
}

function safeConnectionBinding(value: Record<string, unknown>): Pick<RunBinding, 'connectionKey' | 'workspace'> {
  if (typeof value.connectionKey !== 'string' || !CONNECTION_KEY_PATTERN.test(value.connectionKey)) {
    throw new Error('Stored WorkBuddy connection binding is invalid.');
  }
  return { connectionKey: value.connectionKey, workspace: safeWorkspace(value.workspace) };
}

function safeActiveTools(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored WorkBuddy active tool set is invalid.');
  }
  const tools = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const [name, schema] of Object.entries(value)) {
    if (
      !TOOL_NAME_PATTERN.test(name) || FORBIDDEN_TOOL_NAMES.has(name) ||
      !schema || typeof schema !== 'object' || Array.isArray(schema)
    ) {
      throw new Error('Stored WorkBuddy active tool set is invalid.');
    }
    if ((schema as Record<string, unknown>).type !== 'object') {
      throw new Error('Stored WorkBuddy tool schema is invalid.');
    }
    tools[name] = schema as Record<string, unknown>;
  }
  if (Object.keys(tools).length > 12) throw new Error('Stored WorkBuddy active tool set is too large.');
  return tools;
}

function safeRunBinding(value: unknown): RunBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored WorkBuddy run binding is invalid.');
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => ![
      'connectionKey', 'workspace', 'capabilityRevision', 'activeTools', 'createdAt', 'updatedAt',
    ].includes(key)) ||
    typeof item.capabilityRevision !== 'string' || !REVISION_PATTERN.test(item.capabilityRevision)
  ) {
    throw new Error('Stored WorkBuddy run binding is invalid.');
  }
  return {
    ...safeConnectionBinding(item),
    capabilityRevision: item.capabilityRevision,
    activeTools: safeActiveTools(item.activeTools),
    createdAt: safeTimestamp(item.createdAt),
    updatedAt: safeTimestamp(item.updatedAt),
  };
}

function parseRuntimeDocument(value: unknown): RuntimeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored WorkBuddy runtime state is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== 1 ||
    !record.runs || typeof record.runs !== 'object' || Array.isArray(record.runs) ||
    !record.invocations || typeof record.invocations !== 'object' || Array.isArray(record.invocations)
  ) {
    throw new Error('Stored WorkBuddy runtime state is invalid.');
  }
  const runs: Record<string, RunBinding> = {};
  for (const [runId, raw] of Object.entries(record.runs)) {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('Stored WorkBuddy run id is invalid.');
    runs[runId] = safeRunBinding(raw);
  }
  const invocations: Record<string, InvocationBinding> = {};
  for (const [invocationId, raw] of Object.entries(record.invocations)) {
    if (!INVOCATION_ID_PATTERN.test(invocationId) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Stored WorkBuddy invocation binding is invalid.');
    }
    const item = raw as Record<string, unknown>;
    if (
      Object.keys(item).some((key) => ![
        'connectionKey', 'workspace', 'createdAt', 'updatedAt', 'runId', 'state',
      ].includes(key)) ||
      typeof item.runId !== 'string' || !RUN_ID_PATTERN.test(item.runId) ||
      typeof item.state !== 'string' || !item.state || item.state.length > 64
    ) {
      throw new Error('Stored WorkBuddy invocation binding is invalid.');
    }
    invocations[invocationId] = {
      ...safeConnectionBinding(item),
      runId: item.runId,
      state: item.state,
      createdAt: safeTimestamp(item.createdAt),
      updatedAt: safeTimestamp(item.updatedAt),
    };
  }
  if (Object.keys(runs).length > MAX_RUNS || Object.keys(invocations).length > MAX_INVOCATIONS) {
    throw new Error('Stored WorkBuddy runtime state exceeds its safety limit.');
  }
  return { schema_version: 1, runs, invocations };
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
      throw new Error('WorkBuddy local state file is unsafe.');
    }
    assertPrivatePosixFile(stat, 'WorkBuddy local state file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertPrivatePosixFile(
  stat: Awaited<ReturnType<typeof lstat>>,
  label: string,
): void {
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && Number(stat.uid) !== uid) {
    throw new Error(`${label} must be owned by the current user.`);
  }
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw new Error(`${label} must not grant group or other permissions.`);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type MutationLockDocument = {
  schema_version: 1;
  pid: number;
  token: string;
  created_at: string;
};

function parseMutationLock(value: unknown): MutationLockDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WorkBuddy runtime mutation lock is invalid.');
  }
  const item = value as Record<string, unknown>;
  if (
    item.schema_version !== 1 ||
    typeof item.pid !== 'number' || !Number.isSafeInteger(item.pid) || item.pid < 1 ||
    typeof item.token !== 'string' || !/^[a-f0-9]{32}$/.test(item.token) ||
    typeof item.created_at !== 'string' || !Number.isFinite(Date.parse(item.created_at))
  ) {
    throw new Error('WorkBuddy runtime mutation lock is invalid.');
  }
  return item as MutationLockDocument;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function reclaimStaleMutationLock(path: string, now = Date.now()): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > 4_096) {
    throw new Error('WorkBuddy runtime mutation lock is unsafe.');
  }
  assertPrivatePosixFile(before, 'WorkBuddy runtime mutation lock');
  if (now - before.mtimeMs <= MUTATION_LOCK_STALE_MS) return false;
  const candidate = parseMutationLock(JSON.parse(await readFile(path, 'utf8')));
  if (processIsAlive(candidate.pid)) return false;
  const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!current) return true;
  if (
    current.dev !== before.dev || current.ino !== before.ino ||
    current.size !== before.size || current.mtimeMs !== before.mtimeMs
  ) return false;
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

async function acquireMutationLock(statePath: string): Promise<() => Promise<void>> {
  const lockPath = `${statePath}.lock`;
  const token = randomBytes(16).toString('hex');
  const deadline = Date.now() + MUTATION_LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      let writeError: unknown;
      try {
        await handle.writeFile(`${JSON.stringify({
          schema_version: 1,
          pid: process.pid,
          token,
          created_at: new Date().toISOString(),
        } satisfies MutationLockDocument)}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        writeError = error;
      } finally {
        await handle.close();
      }
      if (writeError) {
        await unlink(lockPath).catch(() => undefined);
        throw writeError;
      }
      return async () => {
        try {
          const current = parseMutationLock(JSON.parse(await readFile(lockPath, 'utf8')));
          if (current.token !== token || current.pid !== process.pid) {
            throw new Error('WorkBuddy runtime mutation lock ownership was lost.');
          }
          await unlink(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimStaleMutationLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for another WorkBuddy process to update runtime state.');
      }
      await sleep(MUTATION_LOCK_POLL_MS);
    }
  }
}

function enforceDocumentLimits(document: RuntimeDocument): void {
  if (Object.keys(document.runs).length > MAX_RUNS) {
    throw new Error('WorkBuddy runtime run limit reached; refusing to discard existing runs.');
  }
  if (Object.keys(document.invocations).length > MAX_INVOCATIONS) {
    throw new Error('WorkBuddy pending invocation limit reached; refusing to discard pending work.');
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_STATE_BYTES) {
    throw new Error('WorkBuddy local state exceeds its safety limit.');
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function prune(document: RuntimeDocument, now = Date.now()): RuntimeDocument {
  const activeRuns = Object.fromEntries(Object.entries(document.runs).filter(([, item]) =>
    now - Date.parse(item.updatedAt) <= MAX_AGE_MS,
  ));
  const activeInvocations = Object.fromEntries(Object.entries(document.invocations).filter(([, item]) =>
    now - Date.parse(item.updatedAt) <= MAX_AGE_MS,
  ));
  return { schema_version: 1, runs: activeRuns, invocations: activeInvocations };
}

export class RuntimeBindingStore {
  private mutation = Promise.resolve();

  constructor(private readonly path = defaultRuntimeStatePath()) {}

  private async read(): Promise<RuntimeDocument> {
    const value = await readJson(this.path);
    return prune(value === undefined ? emptyRuntimeDocument() : parseRuntimeDocument(value));
  }

  private async mutate(change: (document: RuntimeDocument) => void): Promise<void> {
    const next = this.mutation.then(async () => {
      const release = await acquireMutationLock(this.path);
      try {
        const document = await this.read();
        change(document);
        const nextDocument = prune(document);
        enforceDocumentLimits(nextDocument);
        await atomicWriteJson(this.path, nextDocument);
      } finally {
        await release();
      }
    });
    this.mutation = next.catch(() => undefined);
    return next;
  }

  async putRun(runId: string, binding: Omit<RunBinding, 'createdAt' | 'updatedAt'>): Promise<void> {
    if (!RUN_ID_PATTERN.test(runId) || !CONNECTION_KEY_PATTERN.test(binding.connectionKey)) {
      throw new Error('Cannot store an invalid WorkBuddy run binding.');
    }
    safeWorkspace(binding.workspace);
    if (!REVISION_PATTERN.test(binding.capabilityRevision)) {
      throw new Error('Cannot store an invalid capability revision.');
    }
    const activeTools = safeActiveTools(binding.activeTools);
    await this.mutate((document) => {
      const now = new Date().toISOString();
      document.runs[runId] = {
        ...binding,
        activeTools,
        createdAt: document.runs[runId]?.createdAt ?? now,
        updatedAt: now,
      };
    });
  }

  async getRun(runId: string): Promise<RunBinding> {
    if (!RUN_ID_PATTERN.test(runId)) throw new Error('The BailingHub run id is invalid.');
    const binding = (await this.read()).runs[runId];
    if (!binding) throw new Error('This run is no longer bound locally. Start a new business turn.');
    return binding;
  }

  async replaceCapabilities(
    runId: string,
    capabilityRevision: string,
    activeTools: Record<string, Record<string, unknown>>,
  ): Promise<RunBinding> {
    if (!REVISION_PATTERN.test(capabilityRevision)) throw new Error('The capability revision is invalid.');
    const safeTools = safeActiveTools(activeTools);
    let updated: RunBinding | undefined;
    await this.mutate((document) => {
      const existing = document.runs[runId];
      if (!existing) throw new Error('This run is no longer bound locally. Start a new business turn.');
      updated = {
        ...existing,
        capabilityRevision,
        activeTools: safeTools,
        updatedAt: new Date().toISOString(),
      };
      document.runs[runId] = updated;
    });
    return updated as RunBinding;
  }

  async putInvocation(
    invocationId: string,
    binding: Omit<InvocationBinding, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    if (!INVOCATION_ID_PATTERN.test(invocationId) || !RUN_ID_PATTERN.test(binding.runId)) {
      throw new Error('Cannot store an invalid WorkBuddy invocation binding.');
    }
    await this.mutate((document) => {
      const now = new Date().toISOString();
      document.invocations[invocationId] = {
        ...binding,
        createdAt: document.invocations[invocationId]?.createdAt ?? now,
        updatedAt: now,
      };
    });
  }

  async getInvocation(invocationId: string): Promise<InvocationBinding> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      throw new Error('The BailingHub invocation id is invalid.');
    }
    const binding = (await this.read()).invocations[invocationId];
    if (!binding) {
      throw new Error('This pending invocation is no longer bound locally. Do not create a replacement write.');
    }
    return binding;
  }

  async removeInvocation(invocationId: string): Promise<void> {
    await this.mutate((document) => { delete document.invocations[invocationId]; });
  }

  async completeRun(runId: string): Promise<void> {
    await this.mutate((document) => {
      delete document.runs[runId];
    });
  }
}

export class HostPreferencesStore {
  constructor(private readonly path = defaultPreferencesPath()) {}

  async linuxFileCredentialStoreConfirmed(): Promise<boolean> {
    const value = await readJson(this.path);
    if (value === undefined) return false;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<PreferencesDocument>;
    return record.schema_version === 1 && record.linux_file_credential_store_confirmed === true;
  }

  async confirmLinuxFileCredentialStore(): Promise<void> {
    await atomicWriteJson(this.path, {
      schema_version: 1,
      linux_file_credential_store_confirmed: true,
    } satisfies PreferencesDocument);
  }
}
