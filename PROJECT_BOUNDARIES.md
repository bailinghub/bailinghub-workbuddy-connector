# Project boundaries

This repository is the independent WorkBuddy ecosystem adapter for BailingHub.

It owns:

- WorkBuddy connector metadata, CLI pre-authorization, and Skill guidance;
- the fixed local MCP surface that maps WorkBuddy turns to the BailingHub Agent Client protocol;
- adapter-local non-secret recovery bindings and release packaging.

It does not own:

- BailingHub Core routing, knowledge, approval, policy, audit, or Agent Client protocol implementation;
- ACC capability declarations;
- the BailingHub DeepSeek Harness plugin or MCP server;
- any business system, business login page, tenant selection UI, or business API;
- developer-specific Hub addresses, Client App IDs, workspaces, routes, accounts, or credentials.

The business system remains authoritative for identity and business authorization. BailingHub remains authoritative for governed capability discovery, policy enforcement, approval, dispatch, idempotency, and audit. WorkBuddy remains responsible for local planning and user interaction.
