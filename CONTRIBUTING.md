# Contributing

Thank you for helping improve the BailingHub WorkBuddy connector.

## Before opening a change

1. Keep this repository limited to the WorkBuddy adapter. Core behavior belongs in BailingHub Core, capability contracts belong in ACC, and business-specific authorization pages belong in the business system.
2. Never commit Hub URLs, business domains, IP addresses, tenant/store identifiers, Client Tokens, Tool Provider secrets, cookies, authorization codes, model keys, or local absolute paths.
3. Preserve the human-controlled connection lifecycle and the five-tool model surface.
4. Treat unknown write finality as recoverable by the original `invocation_id`; never add blind retry behavior.

## Local checks

```bash
npm ci
npm run verify
```

`npm run verify` compiles and tests the runtime, verifies the WorkBuddy five-file ZIP, scans source/compiled/package content for sensitive material, checks the published shrinkwrap-derived SBOM and notices, installs the generated tarball in a clean directory, and audits production dependencies.

Open a focused pull request with the security and compatibility impact described explicitly. Report vulnerabilities through [GitHub Security Advisories](https://github.com/bailinghub/bailinghub-workbuddy-connector/security/advisories/new), not a public issue.
