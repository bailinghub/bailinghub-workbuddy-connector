# Privacy

This connector has no BailingHub-operated relay service and does not send telemetry to the connector maintainers.

## Data flow

- Public connection metadata is stored in the BailingHub SDK's local host registry.
- Agent Session credentials are stored by the operating-system-specific secure store described in `SECURITY.md`.
- Visible user input, governed context, capability calls, and the visible final answer travel directly between the local connector and the BailingHub instance selected by the user.
- BailingHub may retain the conversation and execution audit trail according to that deployment's administrator policy.
- WorkBuddy and the selected model provider process the conversation according to their own settings and privacy terms.

## Local runtime metadata

The connector persists only the minimum metadata needed to pin and recover a governed run: run/invocation IDs, connection key, workspace, capability revision, current active tool names and JSON Schemas, state, and timestamps. It does not persist user message text, hidden reasoning, tool arguments, business response bodies, credentials, cookies, or model keys in that runtime mapping.

`logout` revokes the current Agent Session but leaves its public connection entry for later reauthorization. `connections remove` attempts remote revocation before deleting the selected local connection and credential.
