# Codebase-Aware Analysis Rules

Use these rules before touching code-aware analysis, codebase registry, source ingestion, symbol resolution, patch proposal, or code-aware report/UI surfaces.

## Product Boundary

- Treat source code as user-owned local material. Do not persist raw source snippets in sessions, reports, exports, telemetry, access logs, or frontend storage.
- Registration makes a codebase selectable; it never attaches source to an analysis automatically. Every run must carry an explicit selection.
- The Web Add and use action may combine registration, disclosed provider consent, and explicit current selection. Register-only leaves selection and consent unchanged; metadata-only selections are never silently upgraded.
- LLM-visible output should prefer `CodeRef` metadata: `referenceId` or `chunkId`, relative `filePath`, `lineRange`, `symbol`, `codebaseId`, `buildId`, `vendor`.
- Raw excerpts are only for explicit user inspection through RBAC-protected endpoints. Frontend excerpt caches must remain in memory and clear on session switch, trace switch, panel unmount, permission revoke, codebase reindex, and codebase delete.
- `metadata_only` must never send source snippets to providers. `provider_send` still requires per-codebase `sendToProvider` consent.
- Trace/Skill/SQL supports occurrence in the current trace through its evidence contract. `CodeRef` locates source and supplies candidate mechanism context; it cannot prove implementation behavior or raise occurrence or root-cause confidence alone. Mechanism status is `corroborated`, `compatible`, `ambiguous`, or `unverified`.

## Backend

- Register and preview paths through `PathSecurityGate`; never trust a client-supplied root directly.
- A live registered root is sufficient for bounded `search_codebase` and `read_codebase_file`; an active index is optional acceleration, not an analysis prerequisite.
- Explicit source selection makes authorized tools available to the primary run. The AI decides whether source lookup is needed within the runtime evidence policy and caller budgets; completion does not require a lookup or `record_source_use_decision` call. An incomplete search cannot support a source-absence claim.
- On-demand access must enforce the registered path filters, extension/size limits, provider consent, bounded results/line ranges, secret redaction, and the private-output projection. Never return an absolute root.
- Code-aware chunks must carry `codebaseId` and `registryOrigin='codebase_registry'`.
- `app_source`, `kernel_source`, or registry-origin chunks missing codebase metadata must fail closed with `invalid_codebase_metadata`.
- Indexed lookup handlers must pass through `LookupResponseFilter`; on-demand handlers must pass through `OnDemandSourceAccessService` and the same external-surface projection boundary before results leave the runtime.
- SSE/log/snapshot/report/export paths must use projected/sanitized payloads, not raw MCP tool results.
- Parse native conclusion declarations before display replacement. Keep original verification values in the private finalization context and bind them to the exact run, attempt and public candidate with an issued receipt. Never verify rewritten display values or recover validation authority from serialized output. Project protocol fields structurally and serialize text values safely; preserve invalid native declarations as invalid.
- `SourceUseDecisionV1` is actual current-run MCP state, not model-authored prose. It records selected/queried/used IDs, status, structured reason code, coverage, and safe references. `pending` and `attempted` are audit states and do not override native completion or make the answer partial by themselves. Unchecked source claims remain unverified; actual invalid bindings and private-output projection failures retain their separate verification and delivery consequences.
- Issue model-visible `sourceReferences` before delivering lookup results; admit them into the current-run ledger before exposing associated body or authorizing patches. At reference capacity, return an explicit bound instead of silently dropping issued references. Accept safe relative Unicode and spaced paths consistently across reading, source identity, reports, and verification.
- An explicit stop decision cannot hide subsequent actual source calls. A requested file window is not incomplete search coverage; preserve real search incompleteness while allowing bindings to positively identified source.
- `SourceClaimBindingV1` uses only references returned by the current selected partition; any Trace references must belong to the same claim. `corroborated` requires verified trace occurrence plus `provider_send` body/indexed evidence; `metadata_only` is locate-only. Pure `source.location` claims use the exact returned `semantics.source` tuple without requiring a duplicate root binding. If provided, that claim's binding must be unique, use the same source ID and contain no Trace IDs. Location proof covers only the current returned location snapshot and still requires complete semantic review of the displayed proposition.
- Initial/replayed SSE, HTML reports, CLI JSON/Markdown/HTML, analysis-result snapshots, and report/snapshot APIs must share the canonical safe projector. The Web receipt is stricter and retains no CodeRefs. Never retain roots, snippets, queries, or free-text binding reasons on these surfaces.
- Private process views use shared deterministic tool/outcome narration and omit suppressed model events without repetitive placeholders. Receipt mechanism status comes from the actual source-claim verifier, never a model declaration. Index failure messages must distinguish capacity failure from fresh root access checks; source access scope affects both indexed and on-demand paths.
- Keep prompt content in `backend/strategies/` and Skills in `backend/skills/`; do not hardcode code-aware prompting in TypeScript.

## Patch Proposals

- `propose_patch` requires prior successful code lookup in `CodeLookupLedger`.
- On-demand `referenceId` records deliberately do not authorize `propose_patch`; patch targets remain tied to previously looked-up indexed `chunkId` context.
- Reject context from multiple codebases in Phase 1.
- Verify target files are inside previously looked-up context.
- Run `git apply --check` in the target codebase root before returning a `verified` patch.
- `sketch` and `unverified` responses must not expose copyable unified diff text.

## Verification

After backend changes:

```bash
cd backend
npm run typecheck
npm run validate:strategies
npm run validate:skills
npm run test:scene-trace-regression
```

After plugin UI changes:

```bash
./scripts/start-dev.sh
# Stop the dev server after browser verification.
(cd perfetto && tools/node ui/build.mjs)
./scripts/update-frontend.sh
```

Before landing:

```bash
npm run verify:pr
```

For full code-aware validation:

```bash
npm --prefix backend run verify:codebase-aware
npm --prefix backend run test:source-claim-contract
npm --prefix backend run test:report-contracts
npm --prefix backend run verify:code-aware-semantic-delta
```

This gate depends on local Heavy/Light traces plus a local
`HighPerformanceFriendsCircle` checkout. It verifies both no-codebase
trace-only behavior and configured-codebase reports/exports with source-level
`CodeRef` assertions.

`verify:code-aware-semantic-delta` is deterministic local evidence. It must
cover A0 no source, A1/A2 no-index access, A3 indexed access, A4 wrong-source
rejection, quantitative `not_needed`, source-binding strength, and the shared
runtime finalizer. Report real-provider acceptance separately; unavailable
credentials are `REAL PROVIDER NOT AVAILABLE`, not a pass.
