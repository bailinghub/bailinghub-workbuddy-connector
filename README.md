# BailingHub WorkBuddy Connector

[简体中文](README.zh-CN.md)

Use WorkBuddy to look up commerce orders and perform authorized product operations in a business system connected to BailingHub. Users describe the task in chat; their business system keeps final control of access and business rules.

**Version 0.1.2 is a review candidate. It is not listed in the WorkBuddy connector marketplace.** The Chinese display name is **百灵中枢**; the English display name is **BailingHub Business Operations**. Package and integration identifiers remain unchanged.

## What users can do

Examples for a commerce system that declares the corresponding tools:

- “Show orders from the last seven days and summarize their status.”
- “Find products with fewer than ten units in stock and list them for review.”
- “Change the display order of this test product to the value I provided. If approval is required, tell me its status.”
- “Approval has completed. Check the result of the previous product change.”

These are example requests, not built-in tools or a bundled demo. Available operations depend on the connected business system, the signed-in user's permissions, and the current capability catalog. Installing the connector does not automatically connect a commerce system, CRM, ERP, or multiple systems.

## First connection

1. Install the candidate connector through the WorkBuddy review workflow. Marketplace availability is pending review.
2. Select **Connect**. The local browser configuration page asks for the developer-provided public `hubUrl`, `clientAppId`, and `workspace`, plus a local `connectionName`.
3. The browser opens the business application's own authorization page. Sign in, select the permitted account or store, and approve access there.
4. Return to WorkBuddy and make a business request. WorkBuddy plans locally; BailingHub returns the authorized capabilities and checks identity, authorization, policy, approval, idempotency, limits, and audit for each invocation.

A developer must first deploy BailingHub with Agent Auth v1 and Agent Client Runtime v1, register a Client App and its workspace, provide the business-owned authorization page, and connect the required capability declarations. The authorization page derives identity from the business system's server-side login session, not from an identity supplied by the Agent. Without these prerequisites, reviewers can inspect installation and the connection form but cannot validate real business operations.

Do not distribute or enter Client Tokens, admin tokens, Tool Provider secrets, business cookies, model keys, or Agent Session tokens in chat or the public connection form. Users enter only the four non-secret connection fields; business credentials belong on the business application's authorization page.

## Review candidate 0.1.2

- Chinese naming and examples focus on practical commerce tasks.
- The runtime pins the stable SDK release `bailinghub-mcp-server@0.5.0`, upgraded from `0.3.0`.
- CLI and MCP explicitly declare Node `>=20.15.0`, which also permits WorkBuddy-managed Node 22. Installation reports the Node/npm versions before installing; the Windows command uses `npm install`. This improves installation diagnostics but does not supply a missing managed runtime or repair the host's PATH. Windows WorkBuddy installation remains unverified, and the change does not establish the cause of every earlier installation error or indicate platform approval.

See the [Chinese review guide](docs/REVIEW_GUIDE.zh-CN.md) for prerequisites, installation checks, and business acceptance steps.

## Runtime and recovery boundary

The bundle uses MCP + Skill with a pre-authentication CLI. The CLI handles setup, browser PKCE authorization, status, and revocation. MCP exposes only five tools: start, search, invoke, resume, and complete.

Each visible user turn starts one `run_id`. Search and new capability calls in that turn use that run. The adapter currently isolates each visible turn into a separate BailingHub conversation; it does not claim to archive or automatically group the entire WorkBuddy chat.

Within one run, the same tool and normalized arguments derive the same `invocation_id`. If a transport response is lost, a retry of that exact call keeps its invocation identity. An intentional repeat requires a new visible user request and a new run. When an invocation is pending approval, in progress, or has an unknown outcome, report its state and end the visible turn. On a later user request, resume the original `invocation_id`; its stored binding preserves the original run and connection. Do not submit a replacement write in the new turn. Completing a visible run does not mean the pending business action succeeded.

Local recovery bindings retain routing IDs, workspace, capability revision, active tool schemas, pending invocation IDs, states, and timestamps. They do not store credentials, user messages, tool arguments, or business response bodies. Visible input, capability calls, and the final answer are sent to the selected BailingHub deployment as described in [PRIVACY.md](PRIVACY.md).

## Connection management

Users manage connections in CLI/settings; these actions are not model tools.

```bash
bailinghub-workbuddy connections list
bailinghub-workbuddy connections add
bailinghub-workbuddy connections use <connection-name>
bailinghub-workbuddy connections remove <connection-name>
```

Selection affects new runs only. Existing runs and pending invocations remain pinned to their original connection and business identity. `logout` revokes only the current Agent Session; `connections remove` revokes and removes the selected local connection. The storage namespace remains `bailinghub-workbuddy`.

## Development

```bash
npm install
npm test
npm run verify
```

`npm run connector:build` creates the reproducible `artifacts/bailinghub-workbuddy-connector-0.1.2.zip`. The ZIP contains WorkBuddy metadata, MCP/CLI manifests, the Skill, and the icon. It references an exact npm runtime version; do not submit the ZIP until that version resolves publicly.

Credential storage uses macOS Keychain, Windows CurrentUser DPAPI, or—after an explicit one-time Linux confirmation—a current-user-owned mode-0600 file. See [SECURITY.md](SECURITY.md).

This is an independent ecosystem adapter. Repository ownership and integration boundaries are documented in [PROJECT_BOUNDARIES.md](PROJECT_BOUNDARIES.md). Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).
