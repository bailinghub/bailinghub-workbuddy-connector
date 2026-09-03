---
name: bailinghub-agent-client
description: Use BailingHub when the user wants WorkBuddy to query or operate a business system that their organization has connected to BailingHub.
description_zh: 当用户希望 WorkBuddy 查询或操作已接入 BailingHub 的业务系统时使用。
description_en: Use BailingHub when WorkBuddy needs to query or operate a business system already connected by the user's organization.
version: 0.1.1
author: BailingHub Contributors
---

# BailingHub business operations

Use this connector only for business systems and capabilities returned by the user's authorized BailingHub connection. The local WorkBuddy Agent plans the task; BailingHub supplies the governed context and capability contract, rechecks identity and authorization, dispatches the business call, and records the visible execution trail.

## Required flow for every visible user turn

1. Call `start_business_turn` exactly once. Pass the user's visible request verbatim in `user_input`. The adapter derives stable conversation, turn, and message IDs from the WorkBuddy process and MCP request; never invent or pass those IDs yourself.
2. Read the returned instructions, governance context, `run_id`, `capability_revision`, and initial tool catalog.
3. If the required capability is not in the initial catalog, call `search_business_capabilities` with the same `run_id`. Replace your working catalog with the returned catalog; do not accumulate stale schemas.
4. Call `invoke_business_capability` only with the same `run_id`, a tool name, and arguments from the current catalog. The adapter pins the capability revision and derives the stable invocation ID; never invent either value.
   Within one run, the same tool plus the same normalized arguments is the same governed operation. If the transport response is lost, retry that exact call instead of changing arguments merely to force another write. To intentionally repeat an identical business action, start a new visible user turn and obtain a new `run_id`.
5. If the result is `awaiting_approval`, `in_progress`, `reconciliation_required`, or the outcome is unknown, do not repeat the action and do not hot-poll `resume_governed_tool_invocation` in the same turn. Preserve the exact `invocation_id`, report the current state in the visible response, complete this visible run, and stop. In a later user turn—or after the user says approval has completed—use that original `invocation_id` with `resume_governed_tool_invocation`.
6. Before sending the final answer to the user, call `complete_business_run` with the exact visible text you are about to send, the final status, and public token/tool-call totals if available. The adapter derives the stable assistant message ID. After completion succeeds, send that same visible text to the user.

## Safety and authority rules

- Never invent or override the Hub URL, Client App ID, workspace, connection, business identity, user roles, approval decision, or acting subject.
- Never approve, reject, or otherwise decide an approval on the user's behalf. Only report the governed approval state and wait for the authorized human or business system.
- Never ask the model to add, remove, select, or switch connections. Connection lifecycle belongs to the human-facing WorkBuddy connector settings.
- Never call a business endpoint directly. Use `invoke_business_capability`, so BailingHub can revalidate ACC policy, authorization, approval, idempotency, limits, and audit.
- A returned write capability is not blanket permission. Follow its declared schema, risk, read-only, idempotency, and approval fields.
- If a required write argument or the user's intended target is ambiguous, do not guess. Ask the user for the missing value and finish the visible turn without invoking the write.
- Never claim a write succeeded until the returned invocation state confirms it.
- For unknown finality, preserve `invocation_id`. A blind retry can duplicate a business action.
- Send only visible final content to `complete_business_run`. Exclude chain-of-thought, hidden reasoning, complete sensitive arguments, credentials, cookies, and private runtime configuration.

## Authentication and recovery

WorkBuddy runs the connector's human-facing authorization before MCP starts. The user enters only public connection metadata, then signs in on the business system's own authorization page. Do not ask for business passwords, cookies, BailingHub Client Tokens, Tool Provider secrets, model keys, or Agent access/refresh tokens in chat.

If a tool reports that BailingHub is not connected or the authorization expired, tell the user to open WorkBuddy's connector settings and reconnect. Do not try to repair authentication with shell commands or model tools.

On Linux, the connector requires a one-time human confirmation before the SDK may use a current-user-only mode-0600 credential file. Do not bypass that confirmation or set the opt-in environment variable yourself.
