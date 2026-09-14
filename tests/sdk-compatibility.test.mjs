import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  AgentConnectionRegistry,
  AgentConnectionStore,
  agentConnectionInstanceKey,
  MemoryCredentialStore,
} from 'bailinghub-mcp-server/sdk';

import { transportFor } from '../dist/connection.js';
import { STORAGE_NAMESPACE } from '../dist/constants.js';
import { RuntimeBindingStore } from '../dist/local-state.js';
import { createWorkBuddyMcpServer } from '../dist/mcp.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);

function capability(name) {
  return {
    name, description: 'Synthetic test capability', scope: 'orders', risk: 'high',
    approval_required: true, readonly: false, idempotent: true,
    input_schema: {
      type: 'object', required: ['order_id'],
      properties: { order_id: { type: 'string' } }, additionalProperties: false,
    },
  };
}

async function fixture(t, mode = 'approval') {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-sdk-'));
  const registryPath = join(directory, 'connections.json');
  const credentialsPath = join(directory, 'synthetic-sessions.json');
  const runtimePath = join(directory, 'runtime.json');
  const requests = [];
  const serverErrors = [];
  const handles = [];
  let profiles;
  let credentials;
  let subjectDisplay;
  const http = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      requests.push({ path: request.url, method: request.method, body, authorization: request.headers.authorization });
      const json = (value) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      const session = credentials.find((item) => request.headers.authorization === `Bearer ${item.access_token}`);
      assert.ok(session, 'Every SDK request must use one synthetic fixture authorization');
      const agentName = request.url.startsWith('/agent-auth/') ? 'bailinghub-mcp-server' : 'bailinghub-agent-client';
      assert.equal(request.headers['user-agent'], `${agentName}/0.5.0`);
      if (request.method === 'GET' && request.url === '/agent-auth/v1/session') {
        json({
          session_id: session.session_id, client_app_id: session.client_app_id,
          device_label: 'WorkBuddy test', principal: { user_id: 'fixture-user' },
          on_behalf_of: 'fixture-subject', allowed_routes: [session.route],
          created_at: profiles[0].createdAt, expires_at: session.access_expires_at,
          refresh_expires_at: session.refresh_expires_at,
          ...(subjectDisplay === undefined ? {} : {
            subject_display: subjectDisplay, subject_display_status: 'provided',
          }),
        });
      } else if (request.method === 'POST' && request.url === '/agent-api/v1/workspaces/orders/turns') {
        json({
          schema: 'bailing.agent-turn-context.v1', run_id: RUN_ID,
          profile_revision: 'f'.repeat(64), capability_revision: REVISION_A,
          context: { instructions: 'Use the synthetic authorized catalog.' },
          active_tools: [capability('order_inspect')],
        });
      } else if (request.method === 'POST' && request.url === '/agent-api/v1/workspaces/orders/capabilities/search') {
        json({ schema: 'bailing.agent-capability-search.v1', capability_revision: REVISION_B, tools: [capability('order_refund')] });
      } else if (request.method === 'POST' && request.url === '/agent-api/v1/tool-invocations') {
        // The HTTP server received the write, but the caller cannot know its outcome.
        if (mode === 'lost-response') {
          response.destroy();
          return;
        }
        json({
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: body.invocation_id,
          route: 'orders', tool: body.tool, state: 'awaiting_approval', ok: false,
          auto_retry_allowed: false, text: 'Synthetic approval pending', approval_id: 1,
        });
      } else if (request.method === 'POST' && /^\/agent-api\/v1\/tool-invocations\/[a-f0-9]{64}\/resume$/.test(request.url)) {
        json({
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: request.url.split('/')[4],
          route: 'orders', tool: 'order_refund', state: 'executed', ok: true,
          auto_retry_allowed: false, text: 'Synthetic invocation completed',
        });
      } else if (request.method === 'POST' && request.url === `/agent-api/v1/runs/${RUN_ID}/complete`) {
        json({ schema: 'bailing.agent-run-completion.v1', run_id: RUN_ID, status: body.status });
      } else {
        throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
      }
    })().catch((error) => {
      serverErrors.push(error);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'fixture_request_failed' }));
    });
  });
  t.after(async () => {
    for (const handle of handles) await handle.close();
    await new Promise((resolve, reject) => {
      http.close((error) => error ? reject(error) : resolve());
      http.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(serverErrors, []);
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${http.address().port}`;
  const now = new Date().toISOString();
  profiles = ['a', 'b'].map((letter) => {
    const descriptor = { baseUrl, clientAppId: 'fixture-agent', workspace: 'orders', allowInsecureHttp: false };
    const connectionInstanceId = `instance_${letter.repeat(32)}`;
    return {
      ...descriptor, connectionInstanceId,
      connectionKey: agentConnectionInstanceKey(descriptor, connectionInstanceId),
      alias: `fixture-${letter}`, createdAt: now, updatedAt: now,
    };
  });
  credentials = profiles.map((profile, index) => ({
    schema_version: 1, base_url: baseUrl, client_app_id: profile.clientAppId, route: profile.workspace,
    session_id: `${index + 3}`.repeat(8) + '-3333-4333-8333-333333333333',
    access_token: `fixture-access-${index}`, refresh_token: `fixture-refresh-${index}`,
    access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  }));
  // These persisted registry-v2 and credential-v1 shapes predate SDK 0.5.0.
  await writeFile(registryPath, JSON.stringify({
    schema_version: 2, current_connection_key: profiles[0].connectionKey,
    connections: profiles.map((profile) => ({
      connection_key: profile.connectionKey, connection_instance_id: profile.connectionInstanceId,
      base_url: profile.baseUrl, client_app_id: profile.clientAppId, workspace: profile.workspace,
      alias: profile.alias, created_at: profile.createdAt, updated_at: profile.updatedAt,
    })),
  }), { mode: 0o600 });
  await writeFile(credentialsPath, JSON.stringify(credentials), { mode: 0o600 });

  async function connectionStore() {
    const saved = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const stores = new Map(profiles.map((profile, index) => [profile.connectionKey, new MemoryCredentialStore(saved[index])]));
    // Use the SDK's memory credential backend on every OS. Registry, bindings,
    // HTTP transport, DTO validation and display cache are real SDK/adapter code;
    // no native Keychain/DPAPI command or default user state is accessed.
    const store = new AgentConnectionStore({
      registry: new AgentConnectionRegistry(registryPath), storageNamespace: STORAGE_NAMESPACE,
      environment: {}, commandRunner: async () => { throw new Error('Native credential access is forbidden in this fixture'); },
    });
    store.credentialStore = (key) => {
      assert.ok(stores.has(key), 'Credential lookup must stay inside the fixture registry');
      return stores.get(key);
    };
    return store;
  }
  async function connect() {
    const store = await connectionStore();
    const bindingStore = new RuntimeBindingStore(runtimePath);
    // Keep the production transportFor path: never substitute an SDK transport mock.
    const server = createWorkBuddyMcpServer({ connectionStore: store, bindingStore });
    const client = new Client({ name: 'sdk-compatibility-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    let closed = false;
    const handle = {
      client, store, bindingStore,
      async close() {
        if (closed) return;
        closed = true;
        await client.close();
        await server.close();
      },
    };
    handles.push(handle);
    return handle;
  }
  return {
    connect, connectionStore, profiles, credentials, requests, runtimePath, registryPath,
    setSubjectDisplay(value) { subjectDisplay = value; },
  };
}

for (const mode of ['approval', 'lost-response']) {
  test(`SDK 0.5.0 preserves the original connection and invocation after ${mode} and adapter restart`, async (t) => {
    const f = await fixture(t, mode);
    const first = await f.connect();
    const call = async (name, args) => first.client.callTool({ name, arguments: args });
    const started = await call('start_business_turn', { user_input: 'Refund synthetic order SO-1' });
    assert.equal(started.isError, undefined);
    assert.equal(started.structuredContent.run_id, RUN_ID);
    const searched = await call('search_business_capabilities', { run_id: RUN_ID, query: 'refund', limit: 8 });
    assert.equal(searched.isError, undefined);
    assert.equal(searched.structuredContent.capability_revision, REVISION_B);
    const invoked = await call('invoke_business_capability', { run_id: RUN_ID, tool: 'order_refund', arguments: { order_id: 'SO-1' } });
    const writeRequests = () => f.requests.filter((item) => item.path === '/agent-api/v1/tool-invocations');
    assert.equal(writeRequests().length, 1);
    const invocation = writeRequests()[0].body;
    assert.equal(invocation.agent_run_id, RUN_ID);
    assert.equal(invocation.capability_revision, REVISION_B);
    assert.deepEqual(invocation.arguments, { order_id: 'SO-1' });
    const expectedState = mode === 'approval' ? 'awaiting_approval' : 'accepted_unknown';
    if (mode === 'approval') assert.equal(invoked.structuredContent.state, expectedState);
    else {
      assert.equal(invoked.isError, true);
      assert.match(invoked.content[0].text, new RegExp(`invocation_id=${invocation.invocation_id}`));
    }
    assert.equal((await first.bindingStore.getInvocation(invocation.invocation_id)).state, expectedState);
    const visibleText = 'The synthetic request needs later recovery; no replacement action was sent.';
    const completed = await call('complete_business_run', {
      run_id: RUN_ID, status: 'completed', visible_text: visibleText,
      usage: { total_tokens: 12, tool_calls: 1 },
    });
    assert.equal(completed.isError, undefined);
    const completion = f.requests.find((item) => item.path.endsWith('/complete')).body;
    assert.equal(completion.content, visibleText);
    assert.match(completion.assistant_message_id, /^wb_assistant:[a-f0-9]{64}$/);
    assert.deepEqual(completion.usage, { total_tokens: 12, tool_calls: 1 });
    const startRequest = f.requests.find((item) => item.path.endsWith('/turns')).body;
    assert.match(startRequest.client_conversation_id, /^wb_conversation:[a-f0-9]{64}$/);
    assert.equal(f.requests.find((item) => item.path.endsWith('/search')).body.run_id, RUN_ID);
    await first.close();

    const restored = await f.connect();
    assert.equal((await restored.store.registry.current()).connectionKey, f.profiles[0].connectionKey);
    assert.equal((await restored.bindingStore.getInvocation(invocation.invocation_id)).state, expectedState);
    await assert.rejects(() => restored.bindingStore.getRun(RUN_ID), /no longer bound/);
    await transportFor(restored.store, f.profiles[0]).connectionsUse({ connectionName: f.profiles[1].alias });
    assert.equal((await restored.store.registry.current()).connectionKey, f.profiles[1].connectionKey);
    const resumed = await restored.client.callTool({ name: 'resume_governed_tool_invocation', arguments: { invocation_id: invocation.invocation_id } });
    assert.equal(resumed.isError, undefined);
    assert.equal(resumed.structuredContent.state, 'executed');
    const resumes = f.requests.filter((item) => item.path.endsWith('/resume'));
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].path, `/agent-api/v1/tool-invocations/${invocation.invocation_id}/resume`);
    assert.equal(resumes[0].authorization, `Bearer ${f.credentials[0].access_token}`);
    assert.equal(writeRequests().length, 1, 'Recovery must not create another business invocation');
    await assert.rejects(() => restored.bindingStore.getInvocation(invocation.invocation_id), /no longer bound/);
    const replay = await restored.client.callTool({ name: 'resume_governed_tool_invocation', arguments: { invocation_id: invocation.invocation_id } });
    assert.equal(replay.isError, true);
    assert.equal(f.requests.filter((item) => item.path.endsWith('/resume')).length, 1);
    const localState = await readFile(f.runtimePath, 'utf8');
    assert.equal(localState.includes(visibleText), false);
    assert.equal(localState.includes(f.credentials[0].access_token), false);
  });
}

test('SDK 0.5.0 status accepts old Session responses and lists cached subject names without HTTP', async (t) => {
  const f = await fixture(t);
  const store = await f.connectionStore();
  const transport = transportFor(store, f.profiles[0]);
  const legacy = await transport.status({ connectionKey: f.profiles[0].connectionKey });
  assert.equal(legacy.state, 'authorized');
  assert.equal(legacy.subjectDisplayStatus, 'unsupported');
  assert.equal(legacy.subjectDisplay, null);
  f.setSubjectDisplay({ name: 'Example Team' });
  const current = await transport.status({ connectionKey: f.profiles[0].connectionKey });
  assert.equal(current.state, 'authorized');
  assert.deepEqual(current.subjectDisplay, { name: 'Example Team' });
  assert.equal(current.subjectDisplaySource, 'verified');
  const beforeList = f.requests.length;
  const restarted = await f.connectionStore();
  const listed = await transportFor(restarted, f.profiles[0]).connectionsList();
  assert.equal(f.requests.length, beforeList, 'Listing must read only local cached data');
  const row = listed.connections.find((item) => item.connectionKey === f.profiles[0].connectionKey);
  assert.equal(row.state, 'authorized');
  assert.deepEqual(row.subjectDisplay, { name: 'Example Team' });
  assert.equal(row.subjectDisplaySource, 'cache');
  const registry = JSON.parse(await readFile(f.registryPath, 'utf8'));
  assert.equal(registry.schema_version, 2);
  assert.equal(JSON.stringify(registry).includes('Example Team'), false, 'Display data must stay outside identity metadata');
  assert.equal(JSON.stringify(listed).includes(f.credentials[0].access_token), false);
});
