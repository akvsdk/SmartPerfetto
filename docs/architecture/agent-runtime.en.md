# Agent Runtime Architecture

[English](agent-runtime.en.md) | [中文](agent-runtime.md)

<!-- i18n-headings: paired -->

SmartPerfetto separates model SDK mechanics from Perfetto analysis capability.
The HTTP and CLI session layers depend on the shared `IOrchestrator` contract;
the concrete runtime is selected from the request provider, Provider Manager,
or environment.

| Runtime | SDK | Provider family | Notes |
|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK | Anthropic, Bedrock, Vertex, DeepSeek, Anthropic-compatible gateways | Default runtime; supports local Claude Code auth, MCP server and configurable sub-agents under shared completion and verification contracts |
| `openai-agents-sdk` | OpenAI Agents SDK | OpenAI, Ollama, OpenAI-compatible gateways | Native OpenAI runtime; adapts the same SmartPerfetto tools as function tools |
| `pi-agent-core` | Pi Agent Core | custom only | Optional public runtime; real model configurations reuse the shared SmartPerfetto prompt/tool/report pipeline, while fake-stream remains smoke-only; does not enable `.pi` discovery, package extensions, shell tools, or file tools |
| `opencode` | OpenCode server / SDK | custom only | Optional public runtime; uses explicit OpenAI-compatible or OpenCode model configuration, request-scoped SmartPerfetto MCP tools, and a hardened isolated OpenCode server; does not read local OpenCode login/project state or enable built-in file/shell/web/edit tools |
| `qoder-agent-sdk` | Qoder Agent SDK / `qodercli` | custom only or env | Optional public runtime; SDK is an opt-in optional peer, uses a local Qoder CLI login or PAT, exposes request-scoped SmartPerfetto MCP tools, and isolates private-knowledge streams/sessions/snapshots |

## Entry Points

HTTP analysis:

```text
POST /api/agent/v1/analyze
  -> AgentAnalyzeSessionService.prepareSession()
  -> createAgentOrchestrator()
  -> ClaudeRuntime.analyze() | OpenAIRuntime.analyze() | PiAgentCoreRuntime.analyze() | OpenCodeRuntime.analyze() | QoderRuntime.analyze()
```

Resume and scene reconstruction use the same runtime factory:

```text
POST /api/agent/v1/resume
POST /api/agent/v1/scene-reconstruct
  -> createAgentOrchestrator()
```

The npm CLI is a standalone terminal product exposed as `smp` /
`smartperfetto`. It does not start the Web UI, but it reuses the same runtime,
MCP tools, Skills, reports, and session snapshots.

## Runtime Selection

Priority, highest first:

1. `providerId` from the request or session.
2. The Provider Manager active provider.
3. `SMARTPERFETTO_AGENT_RUNTIME`.
4. Default `claude-agent-sdk`.

`SMARTPERFETTO_AGENT_RUNTIME` only accepts `claude-agent-sdk`,
`openai-agents-sdk`, `pi-agent-core`, `opencode`, or `qoder-agent-sdk`. Provider names such as
`deepseek` or `openai` are not valid runtime values. Provider Manager active profiles
override env fallback, and a resumed session keeps the provider/runtime it was
created with.

Provider mapping:

| Provider type | Runtime | Protocol |
|---|---|---|
| `anthropic` / `bedrock` / `vertex` / `deepseek` | `claude-agent-sdk` | Claude/Anthropic |
| `openai` | `openai-agents-sdk` | OpenAI Responses |
| `ollama` | `openai-agents-sdk` | OpenAI-compatible Chat Completions |
| `custom` | selected by `connection.agentRuntime` or `connection.openaiProtocol` | explicit configuration; Pi Agent Core, OpenCode, and Qoder are custom-only |

Provider connection fields map to runtime-specific env:

| Fields | Runtime | Env |
|---|---|---|
| `claudeBaseUrl` / `claudeApiKey` / `claudeAuthToken` | `claude-agent-sdk` | `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` |
| `openaiBaseUrl` / `openaiApiKey` / `openaiProtocol` | `openai-agents-sdk` | `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_AGENTS_PROTOCOL` |
| `piAgentCoreModulePath` / `piAgentCoreModelJson` / `piAgentCoreSystemPrompt` | `pi-agent-core` | `SMARTPERFETTO_PI_AGENT_CORE_MODULE_PATH` / `SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON` / `SMARTPERFETTO_PI_AGENT_CORE_SYSTEM_PROMPT` |
| `openCodeSdkModulePath` / `openCodeModelJson` / `openCodeSystemPrompt` plus OpenAI-compatible endpoint fields | `opencode` | `SMARTPERFETTO_OPENCODE_SDK_MODULE_PATH` / `SMARTPERFETTO_OPENCODE_MODEL_JSON` / `SMARTPERFETTO_OPENCODE_SYSTEM_PROMPT` plus `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` when model JSON is omitted |
| `qoderAccessToken` / `qoderCliPath` / `qoderModel` / `qoderSystemPrompt` | `qoder-agent-sdk` | `QODER_PERSONAL_ACCESS_TOKEN` / `QODERCLI_PATH` / `QODER_MODEL` / `SMARTPERFETTO_QODER_SYSTEM_PROMPT` |

## M10 Independent Feedback Triage

Agent-assisted GitHub feedback does not resume the main analysis session. New
RunManifests may persist `providerSnapshotHash` at completion. When the user
selects the feedback CTA, the backend resolves the persisted source run again
and requires the currently available provider snapshot to match that hash
exactly. It never reads a later active provider or falls back to another
runtime.

Claude/Anthropic-compatible source runs use a no-tool Claude SDK call for
triage. OpenAI/OpenAI-compatible source runs use a lightweight Chat
Completions call. Both receive only bounded public source context and do not
share the analysis SDK session. Pi Agent Core, OpenCode, Qoder, legacy
manifests, unavailable credentials, snapshot drift, or invalid model output
use an explicit deterministic fallback in V1 and are never presented as if the
same Agent reviewed the result. See
[Agent-Assisted GitHub Feedback](../getting-started/agent-assisted-feedback.en.md)
for the user-visible contract.

## Key Files

| File | Responsibility |
|---|---|
| `backend/src/agentRuntime/runtimeSelection.ts` | Runtime selection and the shared orchestrator factory |
| `backend/src/agentRuntime/runtimeKinds.ts` | Production runtime kinds and the current registered set |
| `backend/src/agentRuntime/runtimeDescriptors.ts` | Runtime descriptors, `EngineCapabilities`, and canonical loaders |
| `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | Claude Agent SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiRuntime.ts` | OpenAI Agents SDK orchestrator |
| `backend/src/agentRuntime/engines/openai/openAiToolAdapter.ts` | Shared MCP descriptors adapted to OpenAI function tools |
| `backend/src/agentRuntime/engines/pi/piAgentCoreRuntime.ts` | Pi Agent Core runtime adapter |
| `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts` | OpenCode server/runtime adapter and request-scoped MCP bridge |
| `backend/src/agentRuntime/engines/qoder/qoderRuntime.ts` | Qoder SDK adapter, stream projection, and session isolation |
| `backend/src/agentRuntime/runtimeExecutionGuard.ts` | Runtime/session single-active execution, cancellation, and stale-settle isolation |
| `backend/src/agentRuntime/analysisTurnIntent.ts`, `runtimeTurnPolicy.ts` | Shared typed intent, budget, scope and evidence-access policy for all native engines |
| `backend/src/agentRuntime/analysisFinalizationContext.ts`, `runtimeEvidenceContext.ts` | Private finalization context, original deadline, authorized capture reads and cross-turn leases |
| `backend/src/agentRuntime/runtimeCandidateAdmission.ts` | Maintainer-owned concurrency-candidate admission boundary |
| `backend/src/agentRuntime/runtimePerformance.ts` | Internal RunManifest phase, tool, and SQL queue/execution timing receipt |
| `backend/src/agentRuntime/runtimeToolConcurrency.ts` | Request-scoped fair read/write scheduling with an exclusive default |
| `backend/src/agentv3/claudeMcpServer.ts` | SmartPerfetto tool implementation and composition |
| `backend/src/agentv3/mcpToolRegistry.ts` | Tool descriptors, exposure levels, and allowlists |
| `backend/src/services/agentResultNormalizer.ts` | Shared final result, client projection, and report-data boundary |
| `backend/src/services/canonicalAnalysisResult.ts`, `finalizeAnalysisResult.ts` | Original-proposition canonical results and the single product-owned asynchronous finalizer |
| `backend/src/services/finalSemanticAssessment.ts`, `evidence/evidenceReadView.ts` | Bounded no-tool semantic review and original execution-capture reads |
| `backend/src/services/finalReportContractGate.ts` | Strategy-owned `final_report_contract` validation |
| `backend/src/services/providerManager/` | Provider configuration and runtime/protocol/env mapping |
| `backend/src/agentv3/sessionStateSnapshot.ts` | Shared snapshot for SDK and Pi/OpenCode/Qoder runtime state |
| `backend/src/services/externalIssueReporting/providerPin.ts` | M10 source-run provider snapshot validation |
| `backend/src/services/externalIssueReporting/triageRunner.ts` | M10 no-tool Agent triage and deterministic fallback |

`backend/src/agentOpenAI/` and individual files such as
`agentv3/claudeRuntime.ts` retain compatibility re-exports for old import paths.
MCP, strategy and planning remain canonical shared layers. The `claudeVerifier`
compatibility entry points to shared structured delivery diagnostics; the
finalizer owns content meaning and claim support.

## Tool Layer

SmartPerfetto analysis capability is registered through
`createClaudeMcpServer()` and described through `McpToolRegistry`: SQL
execution, Skill invocation, SQL schema lookup, planning/hypothesis tools,
artifacts, memory, code-aware lookup, baselines, and comparison tools.

Claude runtime exposes these tools as an in-process MCP server. OpenAI runtime
does not duplicate tool logic; it reads the same `McpToolRegistry` and adapts
tool descriptors into OpenAI Agents SDK function tools. Pi Agent Core uses
request-scoped native tools built from the same shared descriptors, the shared
system prompt, planning/hypothesis tools, and the same route-owned
finalization/claim-verification/report pipeline without turning SmartPerfetto
into a Pi coding-agent harness. OpenCode runs a hardened isolated server and
bridges request-scoped SmartPerfetto tools through a per-analysis MCP bridge;
its built-in project discovery, file, shell, web, and edit tools are disabled
or denied. Qoder uses the SDK's in-process MCP bridge with built-in SDK tools
disabled and projects every answer token through the shared private-output
guard before SSE emission. Each engine uses its pinned provider's native no-tool
transport for the same typed intent and hands its result to the same
product-owned finalizer/report boundary. SDK/server resume, streaming, tool
cadence and cost/timeout semantics still differ.

The tool surface follows actual request scope, artifact-store availability,
codebase permission, `referenceTraceId`, comparison context and evidence access.
Budget mode neither grants permission nor silently removes authorized tools.
`existing_only` strictly prohibits new acquisition.

## Concurrency, Observability, And Admission

Concurrency fails closed by default. A runtime/session permits only one active
analysis execution. Tools are exclusive unless a commutative read is explicitly
marked and admitted for the current request. Each trace processor instance
still has one SQL worker, so tool overlap cannot execute same-trace/processor SQL
concurrently; work on different processors/traces or admitted read-only
preparation may overlap. Processor creation and recovery are single-flight, and
a cancelled stale execution cannot overwrite newer session state.

The backend records real phase spans, first output, tool scheduler wait, and SQL
queue/execution timing in the internal `RunManifest.performance` field. This
`RuntimePerformance` receipt is not projected into public SSE. The public stream
also does not expose admission-grade model, provider snapshot, provider usage,
or performance fields. The receipt supports internal attribution and controlled
benchmarks; by itself it does not prove real-provider speed or accuracy.

Performance branches are controlled by the strict maintainer-only
`SMARTPERFETTO_ADMITTED_RUNTIME_CANDIDATES` boundary and default to no admitted
candidates. The value may contain only a comma-separated, whitespace-free,
duplicate-free list from `task4` through `task9`. Whitespace, an unknown item, a
duplicate, or any malformed value invalidates the whole setting. It is not a
Provider Manager, UI, or provider env option, and benchmark artifacts never
activate it automatically:

| Candidate | Scope |
|---|---|
| `task4` | Reuse one quick-evidence/focus preflight across all five runtimes |
| `task5` | Use bounded fair overlap for explicitly commutative read tools across all five runtimes; all other tools remain exclusive |
| `task6` | Overlap independent Claude/OpenAI preflight DAG nodes |
| `task7` | Load independent Pi SDK/provider startup concurrently and enable quick parallel-batch scheduling; descriptor/tool gates still serialize exclusive work |
| `task8` | Read OpenCode messages/status together and use adaptive polling |
| `task9` | Overlap Qoder Skill-registry and SDK startup |

After `task5` is admitted, its safe-read policy is enabled by default.
`SMARTPERFETTO_SAFE_TOOL_CONCURRENCY=false` is a rollback to exclusive
execution; it cannot bypass a missing `task5` admission. Cache single-flight,
execution isolation, cancellation cleanup, receipts, and deterministic repairs
are correctness/observability foundations and remain active independently of
performance-candidate admission.

Shipped defaults remain serial: genuine deterministic admission harnesses for
all five adapters are `NOT CONFIGURED`, and bounded real-provider base/candidate
A/B has not run, so performance/accuracy admission is `INCONCLUSIVE`. Synthetic
scorer data validates scoring mechanics only and cannot enable a candidate.
When real-provider validation cannot run, record `NOT AVAILABLE` or
`NOT CONFIGURED` precisely. Qoder needs a PAT or local `qodercli` login in
addition to BYOK. Unit, type, build, and deterministic gates are not substitutes
for real-provider evidence.

The Pi Agent Core real-model path reuses SmartPerfetto scene strategies, system
prompt assembly, SQL/Skill tools, planning/hypothesis tools, artifacts, and the
route-owned quality/finalization/report pipeline. It does not read `.pi`
project configuration, package extensions, shell tools, or file tools. Provider
Manager only exposes it for `custom` providers with explicit Pi model JSON or
equivalent env configuration. `SMARTPERFETTO_PI_AGENT_CORE_FAKE_STREAM=1` is
smoke/test-only and must stay labeled capability-limited.

The OpenCode path is also custom-only. It can use `SMARTPERFETTO_OPENCODE_MODEL_JSON`
with `providerID` / `modelID` / `baseUrl` / `apiKey` fields, or fall back to
OpenAI-compatible `OPENAI_*` env/provider fields. SmartPerfetto does not reuse
the user's OpenCode CLI login, config, or project extensions; rollback is
switching the custom provider or `SMARTPERFETTO_AGENT_RUNTIME` back to
`claude-agent-sdk` / `openai-agents-sdk`.

The Qoder path is custom-only in Provider Manager and also supports an explicit
env selection. The SDK is not installed by default; users must review its terms
and opt in through `qoder:install -- --accept-terms` or an explicit module path.
The `resolveModel` BYOK policy combines `QODER_BYOK_API_KEY`,
`QODER_BYOK_PROVIDER`, `QODER_MODEL`, and optional base URL, style, and light
model values; partial configuration fails closed. BYOK changes the model
provider only and never replaces Qoder PAT or local `qodercli` authentication.
Provider Manager accepts the four BYOK values only through a Qoder custom
profile's `custom.envOverrides`; it cannot override the CLI, SDK module, or
worker path. The BYOK key reaches only the SDK `resolveModel` callback, not the
SDK subprocess environment, diagnostics, or plaintext snapshots. Provider,
base URL, and style remain non-secret snapshot inputs, while key changes update
the secret fingerprint used by provider pinning, resume, external issue, and
Self-Evolution proof boundaries. Public sessions may resume by Qoder SDK session
id. A run authorized for private codebase or external knowledge never resumes
or stores that opaque provider session, and its intermediate state is excluded
from durable snapshots.

## Source-Aware Runtime Parity

The five production runtimes do not implement separate source policies. They
share the strategy-owned source-use prompt and actual `SourceUseDecisionV1`
state from the common MCP registry/handlers. Runtimes attach actual source-use
state for the product finalizer. Without a current-run accessor, model-authored
decisions/bindings cannot become executed facts. `pending` or `attempted` alone
does not force the whole run to fail; actual lookup, consent, reference and claim
failures retain their own contract outcomes.

Authorized source is accessed on demand. Fast/full does not insert a mandatory
lookup, fixed plan or extra source pass, and `existing_only` cannot use source or
RAG tools for new acquisition. Trace captures support referenced observations;
source evidence provides mechanism-analysis background, while `CodeRef` metadata
only locates code. `SourceUseDecision.status: corroborated` only audits an
authorized body lookup with references in this run. It does not prove a Trace
occurrence, mechanism or causal relationship, and is a different field from a
claim binding's `mechanismStatus`.

The shared finalizer uses `semanticsPolicy: declared`. Even with matched Trace
references and source bodies, a model-declared `mechanismStatus: corroborated`
is downgraded to `compatible` with `source_binding_mechanism_unverified`.
This path has no native proof that establishes a general mechanism. Unknown
mechanisms remain unverified/partial; a lookup-audit status cannot replace proof.

One canonical safe projector carries the same decision and binding through
initial and replayed SSE, HTML reports, CLI JSON/Markdown/HTML,
analysis-result snapshots, and report/snapshot APIs. Web chat further reduces
it to a current-run receipt without `CodeRef`. No surface retains absolute
roots, snippets, search queries, or model-authored free-text binding reasons.

The deterministic five-runtime execution/finalization gate and A0–A4 semantic
gate prove the product contract, not real-provider model quality. Claude,
OpenAI, Pi, OpenCode, and Qoder require separate repeated acceptance when
credentials are available. Unavailable authentication is reported as
`REAL PROVIDER NOT AVAILABLE` and cannot be replaced by unit tests or fixtures.

## Analysis Modes

| Mode | Behavior |
|---|---|
| `fast` | Fixed quick budget with the request's authorized tools and shared finalization |
| `full` | Fixed full budget without automatically requiring a report, plan or extra source lookup |
| `auto` | Shared typed-intent complexity recommendation; an explicit fallback when unavailable, without keyword guessing |

Typed intent separates task kind, scene, scope, complexity recommendation,
deliverable and evidence access. A scene must belong to the run's pinned registry.
Schema validation does not establish semantic correctness or widen permission.
`existing_only` reads retained evidence; `read_new` remains authorization-bound.
Bounded/unavailable intent does not trigger automatic prefetch. Planning is on
demand; completed phases require real successful evidence or an explicit valid
disposition. Unfinished exploration plans and hypotheses retain their state;
they neither trigger automatic continuation nor determine answer completeness alone.

## SSE Events

All runtimes emit the same SmartPerfetto streaming update categories to the
route layer:

| Event | Meaning |
|---|---|
| `progress` | Phase change |
| `thought` | Intermediate reasoning or phase guidance |
| `agent_task_dispatched` | Tool invocation started |
| `agent_response` | Tool result |
| `answer_token` | Final-answer token |
| `conclusion` | SDK conclusion arrived |
| `analysis_completed` | Product-finalized terminal metadata and actual report outcome |
| `error` | Failure |

The product emits `analysis_completed` after finalization and report handling.
Native completion, evidence/claims and report coverage retain separate states;
a successful chat projection cannot hide report failure.

## Final Result And Quality Artifacts

Each runtime returns its original `AnalysisResult` with a private finalization
context for the same run:

```text
exact runtime result + private RuntimeFinalizationContext
  -> product-owned finalizeAnalysisResult (once)
  -> canonical body / original claim semantics
  -> retained execution capture / finite proof / at most one no-tool semantic review
  -> independent completion / claim / report / source / identity assessments
  -> HTML report / CLI turn files / analysis-result snapshot
  -> frontend visible projection
```

The product takes the context from the exact result before copying it. The
context fixes the provider, original absolute deadline, trace identity and
evidence-read scope. The owner checks current-run identity, cancellation and
authorization across awaits. Semantic review runs at most once, has no tools,
and has a separate 60-second limit bounded by the original deadline and user
cancellation. A timeout records unavailable assurance while preserving the body
and native completion; review does not rewrite the body or reduce causal
propositions to numeric ones. Unknown review alone does not fail a focused answer;
full reports still require their report-assessment contract. The body, native completion and original claims
are independent inputs; valid JSON and model agreement alone are not proof.

`final_report_contract` remains strategy frontmatter in the pinned registry.
`claudeVerifier` supplies structured delivery diagnostics without an additional
semantic LLM or misdiagnosis-word matching. The finite catalog is authoritative
in `SUPPORTED_DETERMINISTIC_CLAIM_RULES`: currently `numeric.cell`,
`interval.overlap` and `comparison.delta`. Missing original witnesses, trusted
units/field semantics or coverage retain candidate/unknown states. Equal values
or endpoints do not establish general causality. Complete claim status joins
captured evidence with semantic review of the current proposition. Reports, CLI
artifacts and snapshots keep provenance. Chat projects the body, machine
sidecars and structured runtime appendix separately without mechanically editing
natural-language conclusions.

## Sessions And Resume

The route layer calls `orchestrator.takeSnapshot()` and restores with
`restoreFromSnapshot()`.

Claude runtime persists the Claude SDK session id. OpenAI runtime persists
OpenAI history, the last response id, and reserved run state. Responses API can
resume with `previousResponseId`; Chat Completions-compatible providers resume
from full history.

Pi Agent Core, OpenCode, and Qoder store runtime-specific opaque state only where the
adapter supports it. They still preserve provider/runtime identity so resume,
reports, and snapshots do not silently switch to another engine.

Snapshots also carry final-result quality fields such as conclusion contracts,
claim verification results, and identity resolutions so resume, report export,
and analysis-result comparison can reuse them.

Historical GET, report and snapshot replay only read/project stored state. They
do not run a new finalizer, semantic review or evidence attestation; normal
access authorization still applies. Restored display rows cannot recreate
in-process execution witnesses.

A logical Conversation session retains in-memory artifacts/captures under the
exact trace pair, authorization fingerprint and tenant/workspace/user scope;
physical session/run IDs remain unique. Issued bindings travel through internal
options, cannot be forged by JSON, and cannot be replaced by a missing-binding
fallback to a cached facade. The model receives a bounded locator catalog for
retained artifact reads, without rows, coverage or proof authority. Each
finalization fixes its admitted capture set; release the lease and clean up the
physical session after it settles. Scope changes/disposal revoke the context,
events are isolated by their producer run, and old cancellation/cleanup cannot
affect the next turn.

Raw trace comparison sessions must also persist `referenceTraceId`,
`comparisonSource`, and `comparisonReportSection`. A comparison session cannot
silently downgrade to single-trace mode or switch to a different reference
trace. Claude/OpenAI SDK session keys must be read and written with the
comparison identity, and Pi/OpenCode/Qoder runtime state must preserve the same
provider/runtime identity.

## Platform Boundaries

- Source runs and the npm CLI require Node.js `>=24 <25`.
- Portable packages bundle Node.js 24, backend runtime files, committed
  `frontend/`, and the pinned trace processor.
- Typed-intent, claim-schema, semantic-review and Conversation evidence-context
  templates are runtime assets. Changes require checking existing public Skill
  export, npm CLI and Docker/portable bundled paths so distribution does not omit
  templates available in source. Documentation cannot substitute for those gates.
- Docker does not read host Claude Code local auth; use Provider Manager or env
  provider configuration.
- Qoder is absent from default Docker/portable/npm installs until the optional
  SDK peer is explicitly installed after its terms are accepted.
- Runtime/provider/session changes must be checked against Web UI, CLI, API,
  reports, Docker, and portable packages. See
  [`../../.claude/rules/product-surface.md`](../../.claude/rules/product-surface.md).

## Health Check

Authenticated `GET /api/runtime-health` exposes the selected runtime. Public
`GET /health` returns only liveness and version:

```json
{
  "aiEngine": {
    "runtime": "openai-agents-sdk",
    "providerMode": "openai_responses",
    "diagnostics": {
      "protocol": "responses",
      "model": "gpt-5.4-mini"
    }
  }
}
```

This distinguishes provider connectivity from the runtime that will actually
execute analysis.
