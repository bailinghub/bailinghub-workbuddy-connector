# BailingHub WorkBuddy Connector

[简体中文](README.zh-CN.md)

Let a local WorkBuddy Agent query and operate commerce, SaaS, CRM, ERP, and other business systems already connected to BailingHub.

This is an independent WorkBuddy ecosystem adapter. It is not part of BailingHub Core, ACC, the DeepSeek Harness plugin, or any specific business application.

## User journey

1. Install **BailingHub Business Operations** from the WorkBuddy connector marketplace.
2. Select **Connect**. A local browser page asks only for the developer-provided public `hubUrl`, `clientAppId`, `workspace`, and local `connectionName`.
3. The browser opens the business application's own authorization page. The user signs in, switches account or tenant if needed, and approves access there.
4. WorkBuddy plans locally. BailingHub projects the capabilities allowed for that trusted business identity and revalidates identity, authorization, ACC policy, approval, idempotency, limits, and audit on every invocation.

The connector is not a business data provider. A developer must first deploy BailingHub, register a Client App and workspace, implement the business-owned authorization page, and connect business capabilities.

Never distribute a BailingHub Client Token, admin token, Tool Provider secret, business cookie, model key, or Agent Session token. End users enter only the four public connection fields.

## Runtime boundary

The WorkBuddy bundle uses MCP + Skill with a pre-authentication CLI:

- the CLI owns human-facing setup, browser PKCE authorization, status, and revocation;
- MCP exposes only five model tools: start, search, invoke, resume, and complete;
- within one `run_id`, the same tool and normalized arguments always derive the same `invocation_id`; a WorkBuddy retry with a new JSON-RPC request id after a lost stdio response therefore cannot become a second business write. Intentionally repeating the exact same action requires a new visible user turn and a new `run_id`;
- connection add/use/remove stays in user-owned CLI/settings and is never a model tool;
- local run bindings retain only routing IDs, workspace, capability revision, active tool schemas, and pending invocation IDs—not credentials, user messages, tool arguments, or business response bodies.
- WorkBuddy does not currently expose a trustworthy host conversation ID to stdio `tools/call`, so this first release maps each visible user turn to a separate BailingHub conversation to prevent cross-chat mixing. Continuous grouping can be added if the host later exposes a trusted conversation identifier.

The runtime pins `bailinghub-mcp-server@0.3.0` and the host storage namespace is always `bailinghub-workbuddy`.

## Multiple connections

```bash
bailinghub-workbuddy connections list
bailinghub-workbuddy connections add
bailinghub-workbuddy connections use <connection-name>
bailinghub-workbuddy connections remove <connection-name>
```

Selection affects new sessions only. Existing runs remain pinned to their original connection and business identity. `logout` revokes only the current Agent Session; `connections remove` revokes and removes the selected local connection.

## Development

```bash
npm install
npm test
npm run verify
```

`npm run connector:build` creates the reproducible `artifacts/bailinghub-workbuddy-connector-0.1.0.zip`. The ZIP contains only WorkBuddy metadata, MCP/CLI manifests, the Skill, and the icon. It references an exact npm runtime version; do not submit the ZIP until that version resolves publicly.

Credential storage uses macOS Keychain, Windows CurrentUser DPAPI, or—only after an explicit one-time Linux confirmation—a current-user-owned mode-0600 file.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

Repository ownership and integration boundaries are documented in [PROJECT_BOUNDARIES.md](PROJECT_BOUNDARIES.md). Contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).
