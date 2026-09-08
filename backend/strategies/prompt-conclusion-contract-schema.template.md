<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2024-2026 Gracker (Chris) | SmartPerfetto -->

Write the answer naturally within the user's requested scope. No fixed headings, section order, claim count, or paragraph count is required. This declaration does not require a report, plan, SQL query, additional evidence, or another model call. A pure acknowledgement or a clarification question containing no factual assertion needs no declaration.

For an answer containing facts, inferences, or recommendations, append one standalone top-level HTML comment as below, outside code fences, blockquotes and examples. Declare every proposition actually present, including unsupported statements; preserve negation, uncertainty, conditions, quoted speech and causal meaning. Do not omit unverified propositions or add absent claims. Use one canonical JSON object, with no prose or trailing object inside its JSON fence. The filled values below illustrate types only: use actual answer content, or `[]` for an unused collection.

````text
{{sidecarOpeningMarker}}
```json
{
  "schemaVersion": "conclusion_contract_v1",
  "mode": "focused_answer",
  "conclusions": [{"rank": 1, "statement": "Statement from the answer"}],
  "clusters": [{"cluster": "Group from the answer"}],
  "evidenceChain": [{"conclusionId": "C1", "text": "Evidence explanation from the answer"}],
  "claims": [{"id": "example:statement", "text": "Statement from the answer", "kind": "inference", "references": []}],
  "relationProposals": [],
  "uncertainties": ["Uncertainty from the answer"],
  "nextSteps": ["Next step from the answer"]
}
```
-->
````

`mode` is `initial_report`, `focused_answer` or `need_input`. Root collections have these element types:

- `conclusions`: objects with finite numeric `rank` and string `statement`.
- `clusters`: objects with string `cluster`.
- `evidenceChain`: objects with string `conclusionId` and string `text`.
- `uncertainties` and `nextSteps`: strings only, never objects such as `{topic, detail}`.
- `claims` and `relationProposals`: objects described below.

Do not invent server verification state, `parseIssues`, `bindingEligibility`, `verified`, completion receipts or parser-owned `raw*` fields.

Each claim has a unique `id`, faithful `text`, `kind`, and `references`; optional fields are `conclusionId`, `artifactRefs` and `relationRefs`. Claim kinds are `numeric`, `categorical`, `time_range`, `identity`, `causal`, `comparison`, `inference` and `recommendation`. Use `references: []` when evidence is unavailable; preserve the claim and its uncertainty. A reference may specify `evidenceRefId`, `sourceToolCallId`, `sourceRef`, `artifactId`, `sourceArtifactId`, `rowIndex`, `rowSelector`, `column` and `value`; all identifiers must locate the same captured evidence. Keep original cell values and scalar types. Where row disambiguation is needed, use an original zero-based `rowIndex` or a unique `rowSelector`; never invent row locators or units. A citation does not itself prove the sentence.

Optional `semantics` describes the proposition without verifying it:

- `schemaVersion`: `claim_semantics@1`.
- `predicate`: a stable proof-rule identifier. An unknown identifier can express a declaration and remains unverified.
- `polarity`: `affirmed`, `negated` or `undetermined`.
- `discourse`: `asserted`, `hypothetical`, `quoted` or `rejected_quote`.
- `quantifier`: `one`, `some`, `all` or `only`.
- `modality`: `certain`, `possible` or `undetermined`.
- Optional `conditions`: an array of strings stating qualifications.
- `scope`: a `population` of `cited_rows`, `selected_interval`, `process_instance`, `trace` or `codebase`; optional `subjectRefs` and `objectRefs` use the same reference shape as claim references. Optional `timeRangeNs` has decimal nanosecond strings `start` and `end`, with `start` no later than `end`.
- Optional `numeric`: `operator` is `eq`, `ne`, `lt`, `lte`, `gt` or `gte`; `value` is a finite number or decimal numeric string; `unit` is the proposition's unit. This value describes what the sentence asserts and is separate from the value stored in a cited reference cell.

The following supported proof-rule catalog is data, not an execution checklist. Use a rule only when it faithfully expresses the proposition; do not rewrite causal or broader statements to fit an available rule. The backend determines whether captured evidence proves a declaration. Unknown rules and missing proof remain unverified.

```json
{{supportedProofRules}}
```

Optional `relationProposals` uses `evidence_relation_candidate@1`. Each proposal has a unique `id` beginning with `proposal:`, a `kind` (`overlap`, `wakeup`, `blocking_state`, `binder_peer`, `lock_owner`, `comparison_delta` or `derived`), a `direction` (`subject_to_object`, `object_to_subject` or `symmetric`), a `subject` reference and optional `object` and `proof` references. Existing optional `proofBindings`, `metricColumn`, `value`, `unit` and `deltaDirection: "current_minus_reference"` retain their candidate meanings. A claim's `relationRefs` names the corresponding proposal IDs. Proposals supply no verified relationship or execution authority; matching endpoints or overlapping intervals alone do not establish causality.

Serialize JSON strings correctly. Escape `<`, `>` and `&` as `\u003c`, `\u003e` and `\u0026` inside the JSON payload so a value containing `-->` cannot close the HTML comment. Encode embedded newlines and quotes using JSON escapes; decoding must reproduce the original claim, reference and qualification values.
