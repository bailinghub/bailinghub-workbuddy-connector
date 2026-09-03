import { createHash, randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BailingHubClientError,
  type AgentClientHostTransport,
  type AgentConnectionProfile,
  type AgentConnectionStore,
} from 'bailinghub-mcp-server/sdk';
import { z } from 'zod';

import { currentConnection, transportFor } from './connection.js';
import {
  MCP_SERVER_NAME,
  PACKAGE_VERSION,
  shouldRetainInvocation,
} from './constants.js';
import {
  RuntimeBindingStore,
  type InvocationBinding,
  type RunBinding,
} from './local-state.js';

const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INVOCATION_ID_PATTERN = /^[a-f0-9]{64}$/;
const FORBIDDEN_TOOL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const LOCAL_RECOVERY_WARNING =
  'BailingHub confirmed the remote result, but the connector could not update local recovery metadata. Preserve invocation_id and do not repeat the business action because of this warning.';

class PublicConnectorError extends Error {}

const PUBLIC_LOCAL_STATE_ERRORS = new Set([
  'The BailingHub run id is invalid.',
  'The BailingHub invocation id is invalid.',
  'This run is no longer bound locally. Start a new business turn.',
  'This pending invocation is no longer bound locally. Do not create a replacement write.',
]);

type TransportFactory = (
  store: AgentConnectionStore,
  profile: AgentConnectionProfile,
) => AgentClientHostTransport;

export type WorkBuddyMcpDependencies = {
  connectionStore: AgentConnectionStore;
  bindingStore?: RuntimeBindingStore;
  transportFactory?: TransportFactory;
};

function success(value: Record<string, unknown>, localRecoveryWarning?: string) {
  const response = localRecoveryWarning
    ? { ...value, localRecoveryWarning }
    : value;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    structuredContent: response,
  };
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof BailingHubClientError || error instanceof PublicConnectorError) {
    return error.message;
  }
  if (error instanceof Error && PUBLIC_LOCAL_STATE_ERRORS.has(error.message)) {
    return error.message;
  }
  return 'The BailingHub connector could not complete this operation safely.';
}

function failure(error: unknown, recovery?: string) {
  const message = publicErrorMessage(error);
  return {
    isError: true,
    content: [{
      type: 'text' as const,
      text: recovery ? `${message} ${recovery}` : message,
    }],
  };
}

function stableJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requestIdentity(value: unknown): string {
  if (typeof value === 'string' && value && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) {
    return `s:${value}`;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return `n:${value}`;
  throw new PublicConnectorError('WorkBuddy supplied an invalid MCP request id.');
}

function stableId(prefix: string, ...values: string[]): string {
  const hash = createHash('sha256').update(`bailinghub.workbuddy.${prefix}.v1\0`);
  for (const value of values) hash.update(value).update('\0');
  return `wb_${prefix}:${hash.digest('hex')}`;
}

function stableInvocationId(
  runId: string,
  toolName: string,
  args: Record<string, unknown>,
): string {
  const hash = createHash('sha256').update('bailinghub.workbuddy.invocation.v1\0');
  // A JSON-RPC request id identifies a transport attempt, not the business
  // operation. WorkBuddy may allocate a new one when retrying after a lost
  // stdio response, so it must not change Core idempotency identity.
  for (const value of [runId, toolName, stableJson(args)]) {
    hash.update(value).update('\0');
  }
  return hash.digest('hex');
}

function acceptedUnknownInvocationId(
  error: BailingHubClientError,
  fallback: string,
): string {
  return typeof error.invocationId === 'string' && INVOCATION_ID_PATTERN.test(error.invocationId)
    ? error.invocationId
    : fallback;
}

function activeToolSchemas(tools: unknown): Record<string, Record<string, unknown>> {
  if (!Array.isArray(tools) || tools.length > 12) throw new PublicConnectorError('BailingHub returned an invalid active tool set.');
  const schemas = Object.create(null) as Record<string, Record<string, unknown>>;
  for (const raw of tools) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PublicConnectorError('BailingHub returned an invalid active tool.');
    const tool = raw as Record<string, unknown>;
    if (
      typeof tool.name !== 'string' || !TOOL_NAME_PATTERN.test(tool.name) ||
      FORBIDDEN_TOOL_NAMES.has(tool.name) || Object.hasOwn(schemas, tool.name) ||
      !tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema) ||
      (tool.input_schema as Record<string, unknown>).type !== 'object'
    ) {
      throw new PublicConnectorError('BailingHub returned an invalid active tool schema.');
    }
    schemas[tool.name] = tool.input_schema as Record<string, unknown>;
  }
  return schemas;
}

async function profileFor(
  store: AgentConnectionStore,
  binding: Pick<RunBinding, 'connectionKey' | 'workspace'>,
): Promise<AgentConnectionProfile> {
  const profile = await store.registry.get(binding.connectionKey);
  if (!profile || profile.workspace !== binding.workspace) {
    throw new PublicConnectorError('The connection pinned to this run is no longer available. Do not switch this run to another business identity.');
  }
  return profile;
}

function bindingForInvocation(
  binding: Pick<RunBinding, 'connectionKey' | 'workspace'>,
  runId: string,
  state: string,
): Omit<InvocationBinding, 'createdAt' | 'updatedAt'> {
  return {
    connectionKey: binding.connectionKey,
    workspace: binding.workspace,
    runId,
    state,
  };
}

export function createWorkBuddyMcpServer(
  dependencies: WorkBuddyMcpDependencies,
): McpServer {
  const bindings = dependencies.bindingStore ?? new RuntimeBindingStore();
  const makeTransport = dependencies.transportFactory ?? transportFor;
  // WorkBuddy does not currently expose a trustworthy host conversation id to stdio
  // tools/call. Isolate every visible turn instead of merging unrelated chats into
  // one Core conversation. A future host conversation id can replace this nonce.
  const processNonce = randomUUID();
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: PACKAGE_VERSION,
  }, {
    instructions:
      'Use start_business_turn once for each visible user turn. Search capabilities only when the active set is insufficient. ' +
      'Never invent a business tool, write argument, approval result, identity, Hub URL, route, or connection. Never approve on the user\'s behalf. ' +
      'Preserve invocation_id when awaiting approval, in progress, or outcome is unknown; report the state and end the turn instead of hot-polling. ' +
      'Finish every started run with complete_business_run using only the visible final response and public usage totals.',
  });

  server.registerTool('start_business_turn', {
    title: 'Start a governed BailingHub business turn',
    description:
      'Starts one visible WorkBuddy turn in the currently user-selected BailingHub connection. Returns route instructions, context, capability revision, and an initial bounded business-tool catalog.',
    inputSchema: {
      user_input: z.string().min(1).max(64_000),
      page_context: z.record(z.string(), z.unknown()).optional(),
      renderers: z.array(z.string().min(1).max(64)).max(20).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (input, extra) => {
    try {
      const profile = await currentConnection(dependencies.connectionStore);
      if (!profile) throw new PublicConnectorError('BailingHub is not connected. Open the connector settings and complete browser authorization.');
      const requestId = requestIdentity(extra.requestId);
      const visibleInput = stableJson({
        user_input: input.user_input,
        page_context: input.page_context ?? null,
        renderers: input.renderers ?? [],
      });
      const clientConversationId = stableId('conversation', processNonce, requestId);
      const result = await makeTransport(dependencies.connectionStore, profile).startTurn({
        user_input: input.user_input,
        ...(input.page_context ? { page_context: input.page_context } : {}),
        ...(input.renderers ? { renderers: input.renderers } : {}),
        client_conversation_id: clientConversationId,
        client_turn_id: stableId('turn', clientConversationId, requestId, visibleInput),
        user_message_id: stableId('user', clientConversationId, requestId, visibleInput),
      }, {
        connectionKey: profile.connectionKey,
        workspace: profile.workspace,
      });
      await bindings.putRun(result.run_id, {
        connectionKey: profile.connectionKey,
        workspace: profile.workspace,
        capabilityRevision: result.capability_revision,
        activeTools: activeToolSchemas(result.active_tools),
      });
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('search_business_capabilities', {
    title: 'Search authorized BailingHub business capabilities',
    description:
      'Searches only capabilities authorized for the pinned run and business identity. Use when the initial catalog does not contain the capability needed for the current user request.',
    inputSchema: {
      run_id: z.string().uuid(),
      query: z.string().max(1_000).optional(),
      limit: z.number().int().min(1).max(12).default(8),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (input) => {
    try {
      const binding = await bindings.getRun(input.run_id);
      const profile = await profileFor(dependencies.connectionStore, binding);
      const result = await makeTransport(dependencies.connectionStore, profile).searchCapabilities(input, {
        connectionKey: binding.connectionKey,
        workspace: binding.workspace,
      });
      await bindings.replaceCapabilities(
        input.run_id,
        result.capability_revision,
        activeToolSchemas(result.tools),
      );
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('invoke_business_capability', {
    title: 'Invoke a governed BailingHub business capability',
    description:
      'Invokes one capability returned by this run. Core rechecks identity, authorization, ACC policy, approval, idempotency, limits, and audit. Within a run, the adapter derives a stable invocation id from the tool and normalized arguments.',
    inputSchema: {
      run_id: z.string().uuid(),
      tool: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      arguments: z.record(z.string(), z.unknown()),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, async (input) => {
    let normalizedArguments: Record<string, unknown>;
    try {
      const binding = await bindings.getRun(input.run_id);
      const schema = Object.hasOwn(binding.activeTools, input.tool)
        ? binding.activeTools[input.tool]
        : undefined;
      if (!schema) {
        throw new PublicConnectorError('The requested capability is not in this run\'s current active set. Search capabilities before invoking it.');
      }
      normalizedArguments = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
        .parse(input.arguments) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof z.ZodError) {
        return failure(new PublicConnectorError('The capability arguments do not match the current authorized schema.'));
      }
      return failure(error);
    }
    const invocationId = stableInvocationId(
      input.run_id,
      input.tool,
      normalizedArguments,
    );
    let binding: RunBinding;
    let profile: AgentConnectionProfile;
    try {
      binding = await bindings.getRun(input.run_id);
      profile = await profileFor(dependencies.connectionStore, binding);
      await bindings.putInvocation(
        invocationId,
        bindingForInvocation(binding, input.run_id, 'dispatching'),
      );
    } catch (error) {
      return failure(error, `invocation_id=${invocationId}. The business call was not sent.`);
    }

    let result;
    try {
      result = await makeTransport(dependencies.connectionStore, profile).invoke({
        run_id: input.run_id,
        tool: input.tool,
        arguments: normalizedArguments,
        capability_revision: binding.capabilityRevision,
        invocation_id: invocationId,
      }, {
        connectionKey: binding.connectionKey,
        workspace: binding.workspace,
      });
    } catch (error) {
      if (error instanceof BailingHubClientError && error.disposition === 'accepted_unknown') {
        const recoveryId = acceptedUnknownInvocationId(error, invocationId);
        let localWarning = '';
        try {
          await bindings.putInvocation(
            recoveryId,
            bindingForInvocation(binding, input.run_id, 'accepted_unknown'),
          );
          if (recoveryId !== invocationId) {
            await bindings.removeInvocation(invocationId);
          }
        } catch {
          localWarning = ` ${LOCAL_RECOVERY_WARNING}`;
        }
        return failure(
          error,
          `invocation_id=${recoveryId}. Do not create a replacement write or hot-poll. Report the current state, then resume this exact invocation_id only in a later user turn or after approval completion.${localWarning}`,
        );
      }
      if (error instanceof BailingHubClientError) {
        await bindings.removeInvocation(invocationId).catch(() => undefined);
        return failure(error, `invocation_id=${invocationId}. BailingHub did not accept this invocation; do not resume or replace it.`);
      }
      return failure(
        error,
        `invocation_id=${invocationId}. The outcome could not be confirmed. Do not create a replacement write; resume this exact invocation_id in a later turn.`,
      );
    }

    try {
      if (shouldRetainInvocation(result)) {
        await bindings.putInvocation(
          invocationId,
          bindingForInvocation(binding, input.run_id, result.state),
        );
      } else {
        await bindings.removeInvocation(invocationId);
      }
    } catch {
      return success(result as unknown as Record<string, unknown>, LOCAL_RECOVERY_WARNING);
    }
    return success(result as unknown as Record<string, unknown>);
  });

  server.registerTool('resume_governed_tool_invocation', {
    title: 'Resume a pending or unknown BailingHub invocation',
    description:
      'Recovers the governed outcome for the exact invocation_id after approval, in-progress, or unknown-finality states. Never creates a replacement business write.',
    inputSchema: {
      invocation_id: z.string().regex(/^[a-f0-9]{64}$/),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (input) => {
    let binding: InvocationBinding;
    let result;
    try {
      binding = await bindings.getInvocation(input.invocation_id);
      const profile = await profileFor(dependencies.connectionStore, binding);
      result = await makeTransport(dependencies.connectionStore, profile).resume(
        input.invocation_id,
        {},
        { connectionKey: binding.connectionKey, workspace: binding.workspace },
      );
    } catch (error) {
      if (error instanceof BailingHubClientError && error.disposition === 'accepted_unknown') {
        return failure(error, 'Do not hot-poll. Preserve this invocation_id and resume it only in a later user turn or after approval completion.');
      }
      return failure(error, 'Do not create a replacement business invocation.');
    }

    try {
      if (shouldRetainInvocation(result)) {
        await bindings.putInvocation(input.invocation_id, {
          ...bindingForInvocation(binding, binding.runId, result.state),
        });
      } else {
        await bindings.removeInvocation(input.invocation_id);
      }
    } catch {
      return success(result as unknown as Record<string, unknown>, LOCAL_RECOVERY_WARNING);
    }
    return success(result as unknown as Record<string, unknown>);
  });

  server.registerTool('complete_business_run', {
    title: 'Complete the visible BailingHub business run',
    description:
      'Writes the visible final response and public usage totals to the BailingHub audit trail. Never send hidden reasoning, full sensitive arguments, credentials, or raw private context.',
    inputSchema: {
      run_id: z.string().uuid(),
      status: z.enum(['completed', 'failed', 'cancelled']),
      visible_text: z.string().min(1).max(64_000),
      model: z.string().max(191).optional(),
      runtime: z.string().max(191).optional(),
      usage: z.object({
        input_tokens: z.number().nonnegative().optional(),
        cached_input_tokens: z.number().nonnegative().optional(),
        output_tokens: z.number().nonnegative().optional(),
        total_tokens: z.number().nonnegative().optional(),
        tool_calls: z.number().nonnegative().optional(),
        cost_usd: z.number().nonnegative().optional(),
      }).strict().optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async (input) => {
    try {
      const binding = await bindings.getRun(input.run_id);
      const profile = await profileFor(dependencies.connectionStore, binding);
      const completionPayload = {
        status: input.status,
        content: input.visible_text,
        ...(input.model ? { model: input.model } : {}),
        ...(input.runtime ? { runtime: input.runtime } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
      };
      const result = await makeTransport(dependencies.connectionStore, profile).completeRun(
        input.run_id,
        {
          ...completionPayload,
          assistant_message_id: stableId('assistant', input.run_id, stableJson(completionPayload)),
        },
        { connectionKey: binding.connectionKey, workspace: binding.workspace },
      );
      await bindings.completeRun(input.run_id);
      return success(result as unknown as Record<string, unknown>);
    } catch (error) {
      return failure(error, 'Retry completion with the exact same run_id, status, visible_text, model, runtime, and usage payload.');
    }
  });

  return server;
}
