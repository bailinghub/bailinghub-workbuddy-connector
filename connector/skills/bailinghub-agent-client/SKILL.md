---
name: bailinghub-agent-client
description: Use BailingHub for authorized order queries and product operations in a business system connected by the user's organization.
description_zh: 用户希望通过百灵中枢查询商城订单、整理商品信息或执行业务系统已声明且已授权的操作时使用。
description_en: Use BailingHub to query orders or perform authorized operations declared by the connected business system.
version: 0.1.2
author: BailingHub Contributors
---

# 百灵中枢 / BailingHub business operations

中文面向用户时使用「百灵中枢」，英文使用「BailingHub」。只使用当前授权连接返回的业务能力。商城订单查询、商品信息整理、低风险商品修改及审批恢复是请求示例，不是内置工具或演示数据；不得虚构能力，或声称安装后自动支持多个业务系统。此版本为审核候选，尚未在 WorkBuddy 连接器市场上架。

The local WorkBuddy Agent plans the task. BailingHub supplies the governed context and capability contract, rechecks identity and authorization, dispatches the business call, and records the visible execution trail. The business system retains final control of business permissions and rules.

## Required flow for every visible user turn

1. Call `start_business_turn` exactly once for the visible user turn. Pass the user's visible request verbatim in `user_input`. The adapter derives conversation, turn, and message IDs; never invent or pass those IDs yourself. This adapter isolates each visible turn into a separate BailingHub conversation and does not automatically archive or group an entire WorkBuddy chat.
2. Read the returned instructions, governance context, `run_id`, `capability_revision`, and initial tool catalog. Use this `run_id` for this turn's capability searches and new business calls.
3. If the required capability is absent from the initial catalog, call `search_business_capabilities` with the same `run_id`. Replace your working catalog with the returned catalog; do not accumulate stale schemas. If no suitable capability is returned, explain the limitation without inventing a tool or endpoint.
4. Call `invoke_business_capability` only with that `run_id`, a tool name, and arguments from the current catalog. The adapter pins the capability revision and derives the invocation ID; never invent either value. Within one run, the same tool and normalized arguments identify the same operation. If only the transport response was lost, retry that exact call without changing arguments to force another write. When an invocation state or recovery instruction is available, follow it instead. Intentionally repeating an identical business action requires a new visible user request and a new run.
5. If the result is `awaiting_approval`, `in_progress`, `reconciliation_required`, or its outcome is unknown, preserve the exact `invocation_id`, report the state, complete the current visible run, and stop. Do not submit a replacement action or hot-poll `resume_governed_tool_invocation` in the same turn. On a later visible user request, including confirmation that approval has completed, start that new turn once and call `resume_governed_tool_invocation` with the original `invocation_id`. Recovery stays bound to the original invocation, run, connection, and business identity; do not recreate the old business call under the new run. If the tool says the invocation was not accepted and must not be resumed, follow that instruction.
6. Before sending the final answer, call `complete_business_run` for the current visible turn's `run_id` with the exact visible text, final run status, and public token/tool-call totals if available. Completion records the visible answer; it does not prove a pending business operation succeeded. After completion succeeds, send that same text. If completion fails, follow its recovery instruction and retry the exact completion payload; do not start another run merely to record the same answer.

## Safety and authority rules

- Never invent or override the Hub URL, Client App ID, workspace, connection, business identity, user roles, approval decision, or acting subject.
- Never approve, reject, or otherwise decide an approval on the user's behalf. Report the governed approval state and wait for the authorized human or business system.
- Never add, remove, select, or switch connections through model actions. Connection lifecycle belongs to the human-facing connector settings or CLI.
- Never call a business endpoint directly. Use `invoke_business_capability`, so BailingHub can revalidate policy, authorization, approval, idempotency, limits, and audit.
- A returned write capability is not blanket permission. Follow its declared schema, risk, read-only, idempotency, and approval fields.
- If a required write argument or intended target is ambiguous, ask for the missing value and finish the visible turn without invoking the write.
- Never claim a write succeeded until the returned invocation state confirms it. Preserve the original `invocation_id` for a pending or unknown outcome; do not create a replacement write after a restart, connection change, or local recovery warning.
- Send only visible final content to `complete_business_run`. Exclude hidden reasoning, full sensitive arguments, credentials, cookies, and private runtime configuration.

## Authentication and recovery

首次连接需要开发者提供公开 `hubUrl`、`clientAppId` 和 `workspace`，用户设置本地 `connectionName`。缺少这些信息时，提示用户向业务系统开发者获取公开连接参数；不能猜测环境或承诺免配置即可使用。

WorkBuddy runs human-facing authorization before MCP starts. Users enter only those four non-secret fields, then sign in on the business system's own authorization page. Do not request business passwords, cookies, Client Tokens, admin tokens, Tool Provider secrets, model keys, or Agent access/refresh tokens in chat or the public connection form.

If a tool reports that BailingHub is not connected or authorization has expired, tell the user to open WorkBuddy's connector settings and reconnect. Do not repair authentication with shell commands or model tools. A missing original connection is not permission to resume under another business identity.

On Linux, the connector requires a one-time human confirmation before the SDK may use a current-user-only mode-0600 credential file. Do not bypass that confirmation or set the opt-in environment variable yourself.
