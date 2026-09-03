import {
  AgentConnectionStore,
  createAgentClientTransport,
  type AgentClientHostTransport,
  type AgentConnectionProfile,
} from 'bailinghub-mcp-server/sdk';

import { STORAGE_NAMESPACE } from './constants.js';
import { HostPreferencesStore } from './local-state.js';

export type ConnectionStoreOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  preferences?: HostPreferencesStore;
};

export async function createWorkBuddyConnectionStore(
  options: ConnectionStoreOptions = {},
): Promise<AgentConnectionStore> {
  const platform = options.platform ?? process.platform;
  const environment = { ...(options.environment ?? process.env) };
  if (platform === 'linux') {
    const confirmed = await (options.preferences ?? new HostPreferencesStore())
      .linuxFileCredentialStoreConfirmed();
    if (confirmed) environment.BAILINGHUB_ALLOW_FILE_CREDENTIAL_STORE = 'true';
  }
  return new AgentConnectionStore({
    storageNamespace: STORAGE_NAMESPACE,
    platform,
    environment,
  });
}

export async function currentConnection(
  store: AgentConnectionStore,
): Promise<AgentConnectionProfile | undefined> {
  return store.registry.current();
}

export function transportFor(
  store: AgentConnectionStore,
  profile: Pick<AgentConnectionProfile, 'baseUrl' | 'clientAppId' | 'workspace' | 'alias' | 'connectionKey'>,
): AgentClientHostTransport {
  return createAgentClientTransport({
    hubUrl: profile.baseUrl,
    clientAppId: profile.clientAppId,
    workspace: profile.workspace,
    connectionName: profile.alias ?? profile.connectionKey,
  }, {
    storageNamespace: STORAGE_NAMESPACE,
    connectionStore: store,
  });
}
