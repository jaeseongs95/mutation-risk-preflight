# mutation-risk-preflight

[한국어](README.md) | English

`mutation-risk-preflight` is a Codex skill that checks targets, approval, blast radius, and recovery evidence before deletion, deployment, publication, migration, permission or billing changes, and global configuration changes. It creates digests for the planned action and targets so the caller can verify that the intent is unchanged immediately before execution.

The skill does not perform the mutation itself. `READY` means that the preflight requirements are satisfied; it does not grant user approval or execution authority. After the change, a separate independent auditor must evaluate the fixed final result before completion, merge, or release.

## Requirements

- Node.js 22 or later
- pnpm 10

Agent Governance Suite and MCP are not required for standalone use. The suite's `TaskEnvelope.v1` is included as a pinned snapshot under `contracts/upstream/` and is used only after its checksum is verified.

To connect this skill with other governance checks in one workflow, import it into [Agent Governance Suite](https://github.com/jaeseongs95/agent-governance-suite).

## Run directly

~~~powershell
pnpm install --frozen-lockfile
node scripts/evaluate-preflight.mjs --input intent.json > report.json
~~~

The verification input used immediately before execution is JSON containing the report, current intent, and verificationTime.

~~~powershell
node scripts/verify-preflight-receipt.mjs --input verification.json
~~~

Both CLIs accept input from stdin and write only JSON to stdout. `READY` and a valid receipt exit with code 0; all other outcomes exit with code 2.

## Verdicts

- `READY`: The target, scope, authority, required approval, current fingerprint, and recovery evidence match.
- `NEEDS_INPUT`: Current-state evidence is missing.
- `NEEDS_APPROVAL`: Approval is missing, expired, or does not match the current operation.
- `NEEDS_REDESIGN`: The recovery plan or blast radius must be redesigned.
- `BLOCKED`: The target is too broad or conflicts with scope or authorization.

Requests targeting `C:\\`, a filesystem root, a UNC share root, `~`, a glob, or an unresolved environment variable cannot receive `READY`.

## Validation

~~~powershell
pnpm lint
pnpm test
~~~

The tests cover the no-mutation invariant, Windows paths, receipt tampering and extension, changes to every invalidating input, upstream checksums, and standalone execution. They do not call a real mutation API or filesystem mutation function.

## License

MIT
