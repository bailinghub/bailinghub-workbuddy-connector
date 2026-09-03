import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BailingHubClientError } from 'bailinghub-mcp-server/sdk';

import { RuntimeBindingStore } from '../dist/local-state.js';
import { createWorkBuddyMcpServer } from '../dist/mcp.js';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);
const PRIVATE_LOCAL_ROOT = ['', 'Users', 'private-user'].join('/');
const profile = {
  connectionKey: `conn_${'c'.repeat(32)}`,
  connectionInstanceId: `instance_${'d'.repeat(32)}`,
  baseUrl: 'https://hub.example.com',
  clientAppId: 'merchant-agent',
  workspace: 'orders',
  alias: 'shop-a',
  allowInsecureHttp: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-mcp-'));
  const statePath = join(directory, 'runtime.json');
  const bindingStore = options.bindingStoreFactory
    ? options.bindingStoreFactory(statePath)
    : new RuntimeBindingStore(statePath);
  const calls = { start: [], search: [], invoke: [], resume: [], complete: [] };
  const transport = {
    async startTurn(input) {
      calls.start.push(input);
      return {
        schema: 'bailing.agent-turn-context.v1',
        run_id: RUN_ID,
        profile_revision: 'f'.repeat(64),
        capability_revision: REVISION_A,
        context: { instructions: 'Use governed tools.', page_context: {}, renderers: [], memory: {}, memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} },
        active_tools: [{
          name: options.activeToolName ?? 'staff_edit', description: 'Edit staff', scope: 'staff', risk: 'medium',
          approval_required: false, readonly: false, idempotent: true,
          input_schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: false },
        }],
      };
    },
    async searchCapabilities(input) {
      calls.search.push(input);
      return {
        schema: 'bailing.agent-capability-search.v1', capability_revision: REVISION_B,
        tools: [{
          name: 'order_refund', description: 'Refund order', scope: 'orders', risk: 'high',
          approval_required: true, readonly: false, idempotent: true,
          input_schema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'string' } }, additionalProperties: false },
        }],
      };
    },
    async invoke(input) {
      calls.invoke.push(input);
      return {
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocation_id,
        route: 'orders', tool: input.tool, state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'Done',
      };
    },
    async resume(invocationId) {
      calls.resume.push(invocationId);
      throw new Error('not used');
    },
    async completeRun(runId, input) {
      calls.complete.push({ runId, input });
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status };
    },
  };
  options.configureTransport?.(transport, calls);
  const connectionStore = {
    registry: {
      async current() { return profile; },
      async get(key) { return key === profile.connectionKey ? profile : undefined; },
    },
  };
  const server = createWorkBuddyMcpServer({
    connectionStore,
    bindingStore,
    transportFactory: () => transport,
  });
  const client = new Client({ name: 'workbuddy-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { client, calls, bindingStore };
}

test('only five static runtime tools are model-visible and connection lifecycle stays hidden', async (t) => {
  const { client } = await fixture(t);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
    'complete_business_run',
    'invoke_business_capability',
    'resume_governed_tool_invocation',
    'search_business_capabilities',
    'start_business_turn',
  ]);
  const schemas = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.inputSchema.properties]));
  assert.deepEqual(Object.keys(schemas.start_business_turn).sort(), ['page_context', 'renderers', 'user_input']);
  assert.deepEqual(Object.keys(schemas.invoke_business_capability).sort(), ['arguments', 'run_id', 'tool']);
  assert.deepEqual(Object.keys(schemas.complete_business_run).sort(), ['model', 'run_id', 'runtime', 'status', 'usage', 'visible_text']);
  const serialized = JSON.stringify(listed.tools);
  for (const forbidden of ['hubUrl', 'clientAppId', 'connectionName', 'capability_revision', 'assistant_message_id']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into model tools`);
  }
});

test('adapter derives stable ids, pins revisions, replaces active tools, and completes visible text', async (t) => {
  const { client, calls } = await fixture(t);
  const started = await client.callTool({
    name: 'start_business_turn',
    arguments: { user_input: 'Update the employee' },
  });
  assert.equal(started.isError, undefined);
  assert.match(calls.start[0].client_conversation_id, /^wb_conversation:[a-f0-9]{64}$/);
  assert.match(calls.start[0].client_turn_id, /^wb_turn:[a-f0-9]{64}$/);
  assert.match(calls.start[0].user_message_id, /^wb_user:[a-f0-9]{64}$/);

  const invoked = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(invoked.isError, undefined);
  assert.equal(calls.invoke[0].capability_revision, REVISION_A);
  assert.match(calls.invoke[0].invocation_id, /^[a-f0-9]{64}$/);

  await client.callTool({
    name: 'search_business_capabilities',
    arguments: { run_id: RUN_ID, query: 'refund', limit: 12 },
  });
  const stale = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /not in this run's current active set/);

  await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'order_refund', arguments: { order_id: 'SO-1' } },
  });
  assert.equal(calls.invoke.at(-1).capability_revision, REVISION_B);

  const visible = 'Refund request submitted for approval.';
  await client.callTool({
    name: 'complete_business_run',
    arguments: { run_id: RUN_ID, status: 'completed', visible_text: visible, usage: { total_tokens: 10, tool_calls: 2 } },
  });
  assert.equal(calls.complete[0].input.content, visible);
  assert.match(calls.complete[0].input.assistant_message_id, /^wb_assistant:[a-f0-9]{64}$/);
});

test('separate visible turns use separate fail-safe Core conversation ids', async (t) => {
  const { client, calls } = await fixture(t);
  for (const userInput of ['Inspect shop A', 'Inspect shop B']) {
    const started = await client.callTool({
      name: 'start_business_turn',
      arguments: { user_input: userInput },
    });
    assert.equal(started.isError, undefined);
  }
  assert.equal(calls.start.length, 2);
  assert.notEqual(calls.start[0].client_conversation_id, calls.start[1].client_conversation_id);
});

test('a lost stdio response retries the same semantic write with the same invocation id', async (t) => {
  let attempt = 0;
  const { client, calls } = await fixture(t, {
    configureTransport(transport, recorded) {
      transport.invoke = async (input) => {
        recorded.invoke.push(input);
        attempt += 1;
        if (attempt === 1) throw new Error('stdio response was lost');
        return {
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocation_id,
          route: 'orders', tool: input.tool, state: 'executed', ok: true,
          auto_retry_allowed: false, text: 'Done',
        };
      };
    },
  });
  await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Update staff' } });

  const first = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(first.isError, true);

  const retried = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(retried.isError, undefined);
  assert.equal(calls.invoke.length, 2);
  assert.equal(calls.invoke[0].invocation_id, calls.invoke[1].invocation_id);

  await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '43' } },
  });
  assert.notEqual(calls.invoke[1].invocation_id, calls.invoke[2].invocation_id);
});

test('retryable rejection before dispatch retains the exact invocation for resume', async (t) => {
  const { client, calls, bindingStore } = await fixture(t, {
    configureTransport(transport, recorded) {
      transport.invoke = async (input) => {
        recorded.invoke.push(input);
        return {
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocation_id,
          route: 'orders', tool: input.tool, state: 'rejected_before_dispatch', ok: false,
          auto_retry_allowed: true, text: 'Retry through resume',
        };
      };
      transport.resume = async (invocationId) => {
        recorded.resume.push(invocationId);
        return {
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocationId,
          route: 'orders', tool: 'staff_edit', state: 'executed', ok: true,
          auto_retry_allowed: false, text: 'Done',
        };
      };
    },
  });
  await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Update staff' } });
  const invoked = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(invoked.structuredContent.state, 'rejected_before_dispatch');
  const invocationId = invoked.structuredContent.invocation_id;
  assert.equal((await bindingStore.getInvocation(invocationId)).state, 'rejected_before_dispatch');

  const resumed = await client.callTool({
    name: 'resume_governed_tool_invocation',
    arguments: { invocation_id: invocationId },
  });
  assert.equal(resumed.structuredContent.state, 'executed');
  assert.deepEqual(calls.resume, [invocationId]);
  await assert.rejects(() => bindingStore.getInvocation(invocationId), /no longer bound/);
});

test('confirmed remote result survives local recovery write failure without inducing retry', async (t) => {
  class FailPendingRefreshStore extends RuntimeBindingStore {
    invocationWrites = 0;

    async putInvocation(...args) {
      this.invocationWrites += 1;
      if (this.invocationWrites === 2) {
        throw new Error(`${PRIVATE_LOCAL_ROOT}/recovery-state.json EACCES`);
      }
      return super.putInvocation(...args);
    }
  }
  const { client, calls, bindingStore } = await fixture(t, {
    bindingStoreFactory: (path) => new FailPendingRefreshStore(path),
    configureTransport(transport, recorded) {
      transport.invoke = async (input) => {
        recorded.invoke.push(input);
        return {
          schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocation_id,
          route: 'orders', tool: input.tool, state: 'awaiting_approval', ok: false,
          auto_retry_allowed: false, text: 'Approval required',
        };
      };
    },
  });
  await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Update staff' } });
  const invoked = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(invoked.isError, undefined);
  assert.equal(invoked.structuredContent.state, 'awaiting_approval');
  assert.match(invoked.structuredContent.localRecoveryWarning, /remote result.*authoritative|confirmed the remote result/i);
  assert.equal(JSON.stringify(invoked).includes(PRIVATE_LOCAL_ROOT), false);
  assert.equal((await bindingStore.getInvocation(calls.invoke[0].invocation_id)).state, 'dispatching');
});

test('accepted-unknown prefers the validated SDK invocation id and unknown errors hide local paths', async (t) => {
  const sdkInvocationId = 'e'.repeat(64);
  let mode = 'accepted-unknown';
  const { client, calls, bindingStore } = await fixture(t, {
    configureTransport(transport, recorded) {
      transport.invoke = async (input) => {
        recorded.invoke.push(input);
        if (mode === 'accepted-unknown') {
          throw new BailingHubClientError(
            'BailingHub did not confirm the invocation outcome.',
            undefined,
            true,
            undefined,
            'accepted_unknown',
            sdkInvocationId,
          );
        }
        throw new Error(`${PRIVATE_LOCAL_ROOT}/credentials.json EACCES`);
      };
    },
  });
  await client.callTool({ name: 'start_business_turn', arguments: { user_input: 'Update staff' } });
  const acceptedUnknown = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '42' } },
  });
  assert.equal(acceptedUnknown.isError, true);
  assert.match(acceptedUnknown.content[0].text, new RegExp(`invocation_id=${sdkInvocationId}`));
  assert.equal((await bindingStore.getInvocation(sdkInvocationId)).state, 'accepted_unknown');
  assert.notEqual(calls.invoke[0].invocation_id, sdkInvocationId);
  await assert.rejects(() => bindingStore.getInvocation(calls.invoke[0].invocation_id), /no longer bound/);

  mode = 'unknown-error';
  const unknown = await client.callTool({
    name: 'invoke_business_capability',
    arguments: { run_id: RUN_ID, tool: 'staff_edit', arguments: { id: '43' } },
  });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.content[0].text.includes(PRIVATE_LOCAL_ROOT), false);
  assert.match(unknown.content[0].text, /outcome could not be confirmed/i);
  const unknownInvocationId = calls.invoke.at(-1).invocation_id;
  assert.equal((await bindingStore.getInvocation(unknownInvocationId)).state, 'dispatching');
});

test('active catalogs reject prototype-polluting tool names before persistence', async (t) => {
  const { client } = await fixture(t, { activeToolName: '__proto__' });
  const started = await client.callTool({
    name: 'start_business_turn',
    arguments: { user_input: 'Inspect the available tools' },
  });
  assert.equal(started.isError, true);
  assert.match(started.content[0].text, /invalid active tool schema/);
  assert.equal(Object.prototype.polluted, undefined);
});

test('pending approval survives visible completion and process restart until resume is terminal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bailinghub-workbuddy-resume-'));
  const path = join(directory, 'runtime.json');
  const calls = { invoke: [], resume: [], complete: [] };
  const transport = {
    async startTurn() {
      return {
        schema: 'bailing.agent-turn-context.v1',
        run_id: RUN_ID,
        profile_revision: 'f'.repeat(64),
        capability_revision: REVISION_A,
        context: { instructions: 'Use governed tools.', page_context: {}, renderers: [], memory: {}, memory_refs: [], knowledge: [], knowledge_refs: [], governance: {} },
        active_tools: [{
          name: 'order_refund', description: 'Refund order', scope: 'orders', risk: 'high',
          approval_required: true, readonly: false, idempotent: true,
          input_schema: { type: 'object', required: ['order_id'], properties: { order_id: { type: 'string' } }, additionalProperties: false },
        }],
      };
    },
    async searchCapabilities() { throw new Error('not used'); },
    async invoke(input) {
      calls.invoke.push(input);
      return {
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: input.invocation_id,
        route: 'orders', tool: input.tool, state: 'awaiting_approval', ok: false,
        auto_retry_allowed: false, text: 'Approval required',
      };
    },
    async resume(invocationId) {
      calls.resume.push(invocationId);
      return {
        schema_version: 'bailing.agent-tool-invocation.v1', invocation_id: invocationId,
        route: 'orders', tool: 'order_refund', state: 'executed', ok: true,
        auto_retry_allowed: false, text: 'Refunded',
      };
    },
    async completeRun(runId, input) {
      calls.complete.push({ runId, input });
      return { schema: 'bailing.agent-run-completion.v1', run_id: runId, status: input.status };
    },
  };
  const connectionStore = {
    registry: {
      async current() { return profile; },
      async get(key) { return key === profile.connectionKey ? profile : undefined; },
    },
  };
  const connect = async (bindingStore) => {
    const server = createWorkBuddyMcpServer({
      connectionStore,
      bindingStore,
      transportFactory: () => transport,
    });
    const client = new Client({ name: 'workbuddy-restart-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  };
  let first;
  let second;
  try {
    const firstStore = new RuntimeBindingStore(path);
    first = await connect(firstStore);
    await first.client.callTool({
      name: 'start_business_turn',
      arguments: { user_input: 'Refund order SO-1' },
    });
    const invoked = await first.client.callTool({
      name: 'invoke_business_capability',
      arguments: { run_id: RUN_ID, tool: 'order_refund', arguments: { order_id: 'SO-1' } },
    });
    assert.equal(invoked.structuredContent.state, 'awaiting_approval');
    const invocationId = invoked.structuredContent.invocation_id;
    await first.client.callTool({
      name: 'complete_business_run',
      arguments: {
        run_id: RUN_ID,
        status: 'completed',
        visible_text: 'The refund is awaiting approval. I will not retry or poll it.',
      },
    });
    await first.client.close();
    await first.server.close();
    first = undefined;

    const restartedStore = new RuntimeBindingStore(path);
    assert.equal((await restartedStore.getInvocation(invocationId)).state, 'awaiting_approval');
    await assert.rejects(() => restartedStore.getRun(RUN_ID), /no longer bound/);
    second = await connect(restartedStore);
    const resumed = await second.client.callTool({
      name: 'resume_governed_tool_invocation',
      arguments: { invocation_id: invocationId },
    });
    assert.equal(resumed.structuredContent.state, 'executed');
    assert.deepEqual(calls.resume, [invocationId]);
    await assert.rejects(() => restartedStore.getInvocation(invocationId), /no longer bound/);
  } finally {
    if (first) {
      await first.client.close().catch(() => undefined);
      await first.server.close().catch(() => undefined);
    }
    if (second) {
      await second.client.close().catch(() => undefined);
      await second.server.close().catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
