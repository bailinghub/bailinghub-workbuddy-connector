# Security policy

## Supported line

Only the latest released connector version is supported. This `0.1.0` tree is a pre-release candidate until its npm runtime and WorkBuddy ZIP have passed their separate publication gates.

## Report a vulnerability

Do not open a public issue containing credentials, authorization codes, business records, or exploitable details. Submit a private report through [GitHub Security Advisories](https://github.com/bailinghub/bailinghub-workbuddy-connector/security/advisories/new) and include the affected version, platform, reproduction, and impact.

## Security boundary

- The connector accepts only public Hub/client/workspace metadata on its loopback configuration page.
- Business login and tenant selection stay on the business-owned authorization page.
- Agent access and refresh tokens stay in the BailingHub SDK credential store: macOS Keychain, Windows CurrentUser DPAPI, or an explicitly confirmed Linux mode-0600 file.
- The model cannot add, select, remove, or rewrite connections and cannot provide Hub URLs, identities, approval decisions, or capability revisions to runtime tools.
- Each run remains pinned to its original connection. Capability invocation is allowed only for the current active catalog and is validated against the stored JSON Schema.
- Unknown-finality and approval states preserve the original invocation ID. The adapter never converts them into a blind replacement write.
- The loopback setup page binds to `127.0.0.1`, uses a random CSRF value, rejects non-form requests, caps request size, disables caching/referrers/framing, and applies a restrictive CSP.

## Distribution controls

The WorkBuddy ZIP must contain no credentials, business URLs, private Client App IDs, private workspaces, personal identifiers, or development configuration. Run `npm run verify` before every candidate is handed to the marketplace reviewer.

Release verification scans source files, compiled output, and the final connector ZIP. Maintainers may add private exact-match rules without committing their values by pointing `BAILING_PUBLIC_DENYLIST_FILE` at a JSON file outside the repository. The file is an object whose keys are non-sensitive rule names and whose values are strings or arrays of exact values. Failure output contains only the rule name and affected repository file or ZIP entry, never the denied value or denylist path.

`npm-shrinkwrap.json` is the published dependency lock for this CLI. `THIRD_PARTY_NOTICES.md` and `sbom.cyclonedx.json` are deterministic inventories generated from its production entries. Regenerate them with `npm run supply-chain:generate`; `npm run verify` fails if committed inventories are stale.
