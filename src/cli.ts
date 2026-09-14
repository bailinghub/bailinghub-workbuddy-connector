import { currentConnection, createWorkBuddyConnectionStore, transportFor } from './connection.js';
import { collectConnectionConfiguration } from './config-page.js';
import { HostPreferencesStore } from './local-state.js';

type JsonOutput = Record<string, unknown>;

const PUBLIC_CLI_ERRORS = new Set([
  'No BailingHub connection is configured.',
  '连接配置已超时。',
  '无法启动本地连接配置页。',
]);

function writeJson(value: JsonOutput): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function publicCliFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (PUBLIC_CLI_ERRORS.has(message) || message.startsWith('Usage: bailinghub-workbuddy ')) {
    return message;
  }
  return 'BailingHub connection operation failed safely. Open the connector settings and retry.';
}

export async function authCommand(): Promise<void> {
  await addConnectionCommand(true);
}

export async function addConnectionCommand(prefillCurrent = false): Promise<void> {
  const preferences = new HostPreferencesStore();
  const discoveryStore = await createWorkBuddyConnectionStore({ preferences });
  const current = await currentConnection(discoveryStore);
  const form = await collectConnectionConfiguration(prefillCurrent && current ? {
    initial: {
      hubUrl: current.baseUrl,
      clientAppId: current.clientAppId,
      workspace: current.workspace,
      connectionName: current.alias ?? 'default',
    },
  } : {});
  if (process.platform === 'linux' && form.linuxFileCredentialStoreConfirmed) {
    await preferences.confirmLinuxFileCredentialStore();
  }
  const store = await createWorkBuddyConnectionStore({ preferences });
  const transport = transportFor(store, {
    baseUrl: form.hubUrl,
    clientAppId: form.clientAppId,
    workspace: form.workspace,
    alias: form.connectionName,
    connectionKey: 'conn_00000000000000000000000000000000',
  });
  const registered = await transport.connectionsAdd({
    hubUrl: form.hubUrl,
    clientAppId: form.clientAppId,
    workspace: form.workspace,
    connectionName: form.connectionName,
  });
  const connection = registered.connection as Record<string, unknown>;
  const login = await transport.login({
    connectionKey: connection.connectionKey,
    deviceLabel: 'WorkBuddy · 百灵中枢',
  });
  writeJson({
    authenticated: true,
    state: 'authorized',
    connectionName: login.connectionName ?? form.connectionName,
    workspace: login.workspace ?? form.workspace,
    identityReconciliation: login.identityReconciliation,
    cleanupRequired: login.cleanupRequired === true,
    ...(typeof login.warning === 'string' ? { warning: login.warning } : {}),
  });
}

export async function listConnectionsCommand(): Promise<void> {
  const store = await createWorkBuddyConnectionStore();
  const profiles = await store.registry.list();
  if (profiles.length === 0) {
    writeJson({ currentConnectionKey: null, connections: [] });
    return;
  }
  const listed = await transportFor(store, profiles[0]!).connectionsList();
  const connections = Array.isArray(listed.connections)
    ? listed.connections.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        connectionName: item.connectionName ?? null,
        hubUrl: item.hubUrl,
        clientAppId: item.clientAppId,
        workspace: item.workspace,
        current: item.current === true,
        state: item.state,
      };
    })
    : [];
  writeJson({ currentConnectionKey: listed.currentConnectionKey ?? null, connections });
}

export async function useConnectionCommand(connectionName: string | undefined): Promise<void> {
  if (!connectionName) throw new Error('Usage: bailinghub-workbuddy connections use <connection-name>');
  const store = await createWorkBuddyConnectionStore();
  const current = await currentConnection(store);
  if (!current) throw new Error('No BailingHub connection is configured.');
  const result = await transportFor(store, current).connectionsUse({ connectionName });
  const connection = result.connection as Record<string, unknown>;
  writeJson({
    state: 'selected',
    connectionName: connection.connectionName ?? connectionName,
    hubUrl: connection.hubUrl,
    clientAppId: connection.clientAppId,
    workspace: connection.workspace,
  });
}

export async function removeConnectionCommand(connectionName: string | undefined): Promise<void> {
  if (!connectionName) throw new Error('Usage: bailinghub-workbuddy connections remove <connection-name>');
  const store = await createWorkBuddyConnectionStore();
  const current = await currentConnection(store);
  if (!current) throw new Error('No BailingHub connection is configured.');
  const result = await transportFor(store, current).connectionsRemove({ connectionName });
  writeJson({
    state: 'removed',
    connectionName: result.connectionName ?? connectionName,
    hadCredentials: result.hadCredentials === true,
    remoteRevoked: result.remoteRevoked === true,
    currentConnectionKey: result.currentConnectionKey ?? null,
  });
}

export async function statusCommand(): Promise<void> {
  try {
    const store = await createWorkBuddyConnectionStore();
    const current = await currentConnection(store);
    if (!current) {
      writeJson({ authenticated: false, state: 'unconfigured' });
      return;
    }
    const result = await transportFor(store, current).status({ connectionKey: current.connectionKey });
    writeJson({
      authenticated: result.state === 'authorized',
      state: result.state,
      connectionName: current.alias ?? null,
      hubUrl: current.baseUrl,
      clientAppId: current.clientAppId,
      workspace: current.workspace,
    });
  } catch (error) {
    writeJson({ authenticated: false, state: 'error', error: publicCliFailure(error) });
  }
}

export async function logoutCommand(): Promise<void> {
  const store = await createWorkBuddyConnectionStore();
  const current = await currentConnection(store);
  if (!current) {
    writeJson({ authenticated: false, state: 'logged_out', hadCredentials: false });
    return;
  }
  const result = await transportFor(store, current).logout({ connectionKey: current.connectionKey });
  writeJson({
    authenticated: false,
    state: 'logged_out',
    connectionName: current.alias ?? null,
    workspace: current.workspace,
    hadCredentials: result.hadCredentials === true,
    remoteRevoked: result.remoteRevoked === true,
  });
}

export async function runCli(args: string[]): Promise<boolean> {
  const [command, subcommand, connectionName] = args;
  if (command === 'auth' || command === 'login') {
    await authCommand();
    return true;
  }
  if (command === 'status') {
    await statusCommand();
    return true;
  }
  if (command === 'logout' || command === 'unauth') {
    await logoutCommand();
    return true;
  }
  if (command === 'connections') {
    if (subcommand === 'list') await listConnectionsCommand();
    else if (subcommand === 'add') await addConnectionCommand(false);
    else if (subcommand === 'use') await useConnectionCommand(connectionName);
    else if (subcommand === 'remove') await removeConnectionCommand(connectionName);
    else throw new Error('Usage: bailinghub-workbuddy connections <list|add|use|remove> [connection-name]');
    return true;
  }
  return false;
}
