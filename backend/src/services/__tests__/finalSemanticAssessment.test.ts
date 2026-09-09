// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import {runInNewContext} from 'node:vm';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {ConclusionContract} from '../../agent/core/conclusionContract';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../../agentRuntime/intentTransport';
import {buildStrategyRegistrySnapshotFromDefinitions, loadPromptTemplate, type StrategyDefinition} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint, type AnalysisReportRequirement, type AnalysisCaseRetrievalState} from '../../types/analysisDelivery';
import {assessFinalSemantics, FINAL_SEMANTIC_INPUT_BYTE_LIMIT, type FinalSemanticAssessmentInput} from '../finalSemanticAssessment';

jest.mock('../../agentv3/strategyLoader', () => {
  const actual = jest.requireActual<typeof import('../../agentv3/strategyLoader')>('../../agentv3/strategyLoader');
  return {...actual, loadPromptTemplate: jest.fn(actual.loadPromptTemplate)};
});

const contexts: RuntimeFinalizationContext[] = [];
afterEach(() => {
  for (const context of contexts.splice(0)) context.dispose();
  jest.useRealTimers();
});
const span = (body: string, start = 0, end = body.length) => ({start, end, text: body.slice(start, end)});

function fixture(options: {
  body?: string;
  requirements?: AnalysisReportRequirement[];
  scope?: 'bounded_question' | 'scene_wide';
  deliverable?: 'answer' | 'report';
  caseRetrieval?: AnalysisCaseRetrievalState;
  deadlineMs?: number;
  dispatch?: (input: IntentTransportInput) => Promise<IntentTransportResult>;
} = {}) {
  const body = options.body ?? 'Frame A took 9 ms.';
  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', bindingEligibility: 'eligible',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{
      id: 'claim-a', text: body, kind: 'numeric', references: [{evidenceRefId: 'ev-1', rowIndex: 0, column: 'dur_ms', value: 9}],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.literal', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain', scope: {population: 'cited_rows'},
        numeric: {operator: 'eq', value: 9, unit: 'ms'}},
    }],
  };
  const requirements = options.requirements ?? [];
  const strategy: StrategyDefinition = {
    scene: 'general', classificationDescription: 'General performance interpretation.', strategyKind: 'normal',
    priority: 1, effort: 'low', keywords: [], compoundPatterns: [], requiredCapabilities: [], optionalCapabilities: [],
    phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'Scene context.', detailSections: [],
    sourcePath: '/fixtures/general.strategy.md', finalReportContract: {requiredSections: requirements.map(requirement => ({
      ...requirement, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }))},
  };
  const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [strategy], overlayGeneration: 'semantic-test'});
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(body)};
  const result: AnalysisResult = {sessionId: 'session', conclusion: body, success: true,
    confidence: 0, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
  const reply = {
    schemaVersion: 'final_semantic_response@1',
    bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
    claims: [{claimId: 'claim-a', consistency: 'consistent', contentLocations: [span(body)], issues: [] as unknown[]}],
    omissions: [] as unknown[],
    requirements: requirements.map(requirement => ({requirementId: requirement.id, applicability: 'applicable', coverage: 'covered',
      contentLocations: [span(body)], claimIds: ['claim-a']})),
  };
  const dispatch = jest.fn(options.dispatch ?? (async (_input: IntentTransportInput): Promise<IntentTransportResult> =>
    ({status: 'ok', text: JSON.stringify(reply)})));
  const reads = jest.fn(async () => []);
  attachFinalizationContext(result, {
    runId: 'run', sessionId: result.sessionId, deadlineMs: options.deadlineMs ?? Date.now() + 10_000,
    strategyRegistry: registry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: registry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: options.scope ?? 'bounded_question', recommendedComplexity: 'full',
      deliverable: options.deliverable ?? (requirements.length ? 'report' : 'answer'), evidenceAccess: 'existing_only'},
    traceIdentity: {currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'},
    deliveryContext: {entry: 'new_finalization', acceptedCandidate: candidate},
    evidenceReadView: {resolveReferences: reads}, dispatchText: dispatch,
  });
  const context = takeFinalizationContext(result)!;
  contexts.push(context);
  const controller = new AbortController();
  const input: FinalSemanticAssessmentInput = {context, canonicalCandidate: candidate, signal: controller.signal,
    snapshot: {inputCoverage: 'complete', declarationBindingEligibility: 'eligible', query: 'Explain this frame.', body, conclusionContract: contract,
      evidenceSnapshot: {schemaVersion: 'prepared_claim_evidence@1', reads: [{ref: 'ev-1', rows: [[9]], unit: 'ms'}]},
      ...(requirements.length || options.deliverable === 'report' ? {reportRequirements: {
        sceneId: 'general', registryFingerprint: registry.registryFingerprint, requirements,
      }} : {}), ...(options.caseRetrieval ? {caseRetrieval: options.caseRetrieval} : {})}};
  return {input, reply, dispatch, reads, controller, contract, candidate};
}

describe('final semantic assessment snapshot and transport', () => {
  it('sends one complete provider-safe snapshot and returns only semantic coverage', async () => {
    const run = fixture();
    const pending = assessFinalSemantics(run.input);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    const assessment = await pending;
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.reads).not.toHaveBeenCalled();
    expect(run.dispatch.mock.calls[0][0]).toMatchObject({deadlineMs: run.input.context.deadlineMs, systemPrompt: ''});
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain(JSON.stringify(run.input.snapshot.body));
    expect(prompt).toContain('prepared_claim_evidence@1');
    expect(prompt).toContain('trace-reference');
    expect(assessment).toMatchObject({status: 'checked', consistency: 'consistent',
      coverage: {body: 'complete', claims: 'complete', report: 'not_applicable'},
      binding: {canonicalCandidate: run.candidate}, claims: [{claimId: 'claim-a', contentLocations: [{start: 0, end: run.input.snapshot.body.length}]}]});
    expect(Object.isFrozen(assessment)).toBe(true);
    expect(Object.isFrozen(assessment.claims)).toBe(true);
    expect(Object.keys(assessment)).not.toContain('verified');
    expect(Object.keys(assessment)).not.toContain('evidenceStatus');
  });

  it('captures data and transport identity before the first await', async () => {
    const run = fixture();
    const other = fixture();
    const body = run.input.snapshot.body;
    const pending = assessFinalSemantics(run.input);
    run.input.snapshot.body = 'mutated after dispatch reservation';
    run.contract.claims![0].text = 'mutated declaration';
    run.input.context = other.input.context;
    const result = await pending;
    expect(result.status).toBe('checked');
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(other.dispatch).not.toHaveBeenCalled();
    expect(run.dispatch.mock.calls[0][0].prompt).toContain(JSON.stringify(body));
    expect(run.dispatch.mock.calls[0][0].prompt).not.toContain('mutated declaration');
  });

  it.each(['body', 'claim', 'evidence', 'source', 'capability', 'case', 'diagnostics', 'query', 'candidate'] as const)(
    'does not reuse or redispatch after a %s snapshot change', async field => {
      const run = fixture();
      await assessFinalSemantics(run.input);
      const changed = {...run.input, canonicalCandidate: {...run.candidate}, snapshot: structuredClone(run.input.snapshot)};
      if (field === 'body') changed.snapshot.body += ' Additional assertion.';
      if (field === 'claim') changed.snapshot.conclusionContract!.claims![0].text += ' changed';
      if (field === 'evidence') changed.snapshot.evidenceSnapshot = {reads: [[10]]};
      if (field === 'source') changed.snapshot.sourceUse = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'metadata_only',
        selectedCodebaseIds: [], status: 'pending', attemptedTools: [], queriedCodebaseIds: [], usedCodebaseIds: [], references: []};
      if (field === 'capability') changed.snapshot.capabilitySnapshot = {available: true};
      if (field === 'case') changed.snapshot.caseRetrieval = {status: 'checked', recommendations: []};
      if (field === 'diagnostics') changed.snapshot.protocolDiagnostics = {rawPayload: 'changed original'};
      if (field === 'query') changed.snapshot.query += ' Broader request.';
      if (field === 'candidate') changed.canonicalCandidate.attemptId = 'different-attempt';
      expect(await assessFinalSemantics(changed)).toMatchObject({status: 'not_checked', reason: 'snapshot_changed', consistency: 'unknown'});
      expect(run.dispatch).toHaveBeenCalledTimes(1);
    });

  it('binds current requirements, intent and trace identity into the snapshot', async () => {
    const run = fixture({requirements: [{id: 'observation', label: 'Observation', required: true}]});
    await assessFinalSemantics(run.input);
    const changed = {...run.input, snapshot: structuredClone(run.input.snapshot)};
    changed.snapshot.reportRequirements = {...changed.snapshot.reportRequirements!,
      requirements: [{id: 'observation', label: 'Changed meaning', required: true}]};
    expect(await assessFinalSemantics(changed)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('never dispatches a redacted or truncated semantic target and consumes its slot', async () => {
    const run = fixture();
    run.input.snapshot.inputCoverage = 'incomplete';
    const first = assessFinalSemantics(run.input);
    expect(await first).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete', consistency: 'unknown'});
    expect(assessFinalSemantics(run.input)).toBe(first);
    run.input.snapshot.inputCoverage = 'complete';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it.each(['invalid_mode', 'missing_fields', 'duplicate_marker', 'valid_contract_invalid_protocol'] as const)(
    'rejects issued ineligible %s declarations even when no bindable contract remains', async issue => {
      const run = fixture();
      run.input.snapshot.declarationBindingEligibility = 'ineligible';
      if (issue !== 'valid_contract_invalid_protocol') {
        run.input.snapshot.conclusionContract = undefined;
        run.reply.claims = [];
      }
      run.input.snapshot.protocolDiagnostics = {sidecar: {status: 'invalid', bindingEligibility: 'ineligible',
        issues: [{code: issue === 'duplicate_marker' ? 'duplicate_marker' : 'invalid_contract', path: '$'}],
        ...(issue === 'duplicate_marker' ? {} : {rawPayload: {mode: 'invalid', claims: [{id: 'original-claim', text: 'Original declaration'}]}})}};
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_declarations', consistency: 'unknown'});
      expect(run.dispatch).not.toHaveBeenCalled();
    });

  it('binds explicit parser eligibility and never upgrades existing legacy claims', async () => {
    const run = fixture();
    run.input.snapshot.declarationBindingEligibility = 'legacy_unchecked';
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown',
      claims: [{consistency: 'unknown'}], coverage: {claims: 'incomplete'}});
    run.input.snapshot.declarationBindingEligibility = 'eligible';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects accessors without invoking them and prevents a later valid retry', async () => {
    const run = fixture();
    const getter = jest.fn(() => 'private accessor text');
    run.input.snapshot.evidenceSnapshot = Object.defineProperty({}, 'rows', {enumerable: true, get: getter});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(getter).not.toHaveBeenCalled();
    run.input.snapshot.evidenceSnapshot = {rows: []};
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it.each([NaN, new Date(), [undefined], Array(1), {callback: () => undefined}])('rejects non-JSON evidence input %#', async value => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = value;
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('treats optional undefined properties as absent without losing literal JSON keys', async () => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = {optional: undefined, raw: JSON.parse('{"__proto__":"literal-cell"}')};
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked'});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('"__proto__":"literal-cell"');
  });

  it('accepts native plain objects and nested arrays from another realm', async () => {
    const run = fixture();
    const foreign: unknown = runInNewContext('({rows: [[9]], meta: {unit: "ms"}})');
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    run.input.snapshot.evidenceSnapshot = foreign;
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked'});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('"meta":{"unit":"ms"}');
  });

  it.each([
    'new (class Snapshot { constructor() { this.rows = [[9]]; } })()',
    'Object.create(Object.create(null))',
    'Object.create(Object.create(null, {constructor: {value: Object}}))',
    '(() => { function Object() {} globalThis.Object.setPrototypeOf(Object.prototype, null); return new Object(); })()',
  ])('rejects foreign classes and forged ordinary-object prototypes: %s', async expression => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = runInNewContext(expression);
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('does not invoke foreign own or prototype constructor accessors', async () => {
    for (const expression of [
      '({get rows() { reads += 1; return [[9]]; }})',
      'Object.create(Object.create(null, {constructor: {get() { reads += 1; return Object; }}}))',
    ]) {
      const run = fixture();
      const realm = {reads: 0};
      run.input.snapshot.evidenceSnapshot = runInNewContext(expression, realm);
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
      expect(realm.reads).toBe(0);
      expect(run.dispatch).not.toHaveBeenCalled();
    }
  });

  it('rejects unknown source-ledger fields rather than silently dropping them', async () => {
    const run = fixture();
    const ledger = {schemaVersion: 'source_use_decision@1' as const, codeAwareMode: 'metadata_only' as const,
      selectedCodebaseIds: [], status: 'pending' as const, attemptedTools: [], queriedCodebaseIds: [], usedCodebaseIds: [], references: []};
    run.input.snapshot.sourceUse = Object.assign(ledger, {body: 'unprojected private source'});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('reviews declarations beyond earlier preview limits and rejects an omitted last ID', async () => {
    const run = fixture();
    const declaration = run.contract.claims![0];
    const reply = run.reply.claims[0];
    run.contract.claims = Array.from({length: 60}, (_, index) => ({...structuredClone(declaration), id: `claim-${index}`}));
    run.reply.claims = Array.from({length: 60}, (_, index) => ({...structuredClone(reply), claimId: `claim-${index}`}));
    const result = await assessFinalSemantics(run.input);
    expect(result.claims).toHaveLength(60);
    expect(result.status).toBe('checked');
    const missing = fixture();
    missing.contract.claims = structuredClone(run.contract.claims);
    missing.reply.claims = structuredClone(run.reply.claims.slice(0, -1));
    expect(await assessFinalSemantics(missing.input)).toMatchObject({reason: 'invalid_response'});
  });

  it('marks complete-input overflow without reviewing only the first claims or rows', async () => {
    const run = fixture();
    run.input.snapshot.evidenceSnapshot = {rows: ['x'.repeat(FINAL_SEMANTIC_INPUT_BYTE_LIMIT)]};
    const first = assessFinalSemantics(run.input);
    expect(await first).toMatchObject({status: 'coverage_incomplete', reason: 'input_limit'});
    expect(assessFinalSemantics(run.input)).toBe(first);
    run.input.snapshot.evidenceSnapshot = {rows: []};
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'snapshot_changed'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed for missing assets and remembers the failed first attempt', async () => {
    const run = fixture();
    jest.mocked(loadPromptTemplate).mockReturnValueOnce(undefined);
    const first = assessFinalSemantics(run.input);
    expect(await first).toMatchObject({status: 'unavailable', reason: 'missing_template'});
    expect(assessFinalSemantics(run.input)).toBe(first);
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a body/candidate mismatch without dispatch', async () => {
    const run = fixture();
    run.candidate.conclusionFingerprint = 'another-body';
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });
});

describe('final semantic response protocol', () => {
  it.each(['plain', 'fenced'] as const)('accepts a complete %s JSON response', async mode => {
    const run = fixture();
    run.dispatch.mockImplementation(async () => ({status: 'ok', text: mode === 'plain'
      ? JSON.stringify(run.reply) : '```json\n' + JSON.stringify(run.reply) + '\n```'}));
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked'});
  });

  it.each(['missing_claim', 'extra_claim', 'duplicate_claim', 'extra_root', 'wrong_quote', 'bad_span', 'partial_full_span', 'extra_span_field'] as const)(
    'rejects the entire malformed response: %s', async issue => {
      const run = fixture();
      if (issue === 'missing_claim') run.reply.claims = [];
      if (issue === 'extra_claim') run.reply.claims[0].claimId = 'unbound';
      if (issue === 'duplicate_claim') run.reply.claims.push(structuredClone(run.reply.claims[0]));
      if (issue === 'extra_root') Object.assign(run.reply, {verified: true});
      if (issue === 'wrong_quote') run.reply.claims[0].contentLocations[0].text = 'different statement';
      if (issue === 'bad_span') run.reply.claims[0].contentLocations.push({start: 0, end: 999, text: 'outside'});
      if (issue === 'partial_full_span') run.reply.bodyCoverage.reviewedSpans[0].end -= 1;
      if (issue === 'extra_span_field') Object.assign(run.reply.claims[0].contentLocations[0], {evidenceStatus: 'verified'});
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'unavailable', reason: 'invalid_response', consistency: 'unknown'});
    });

  it.each(['explanation first ', 'tail', 'second_object'] as const)('rejects non-whole JSON framing %s', async framing => {
    const run = fixture();
    run.dispatch.mockImplementation(async () => ({status: 'ok', text: framing === 'explanation first '
      ? framing + JSON.stringify(run.reply) : JSON.stringify(run.reply) + (framing === 'tail' ? '\nExplanation' : '{}')}));
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
  });

  it('preserves an explicitly incomplete review instead of inferring success from full-looking spans', async () => {
    const run = fixture();
    run.reply.bodyCoverage.status = 'incomplete';
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown', coverage: {body: 'incomplete'}});
  });

  it.each(['kind_mismatch', 'polarity_mismatch', 'discourse_mismatch', 'numeric_mismatch'] as const)(
    'preserves the semantic %s finding without rewriting a claim', async code => {
      const run = fixture({body: '并非锁导致了掉帧；9 ms 只是区间长度。'});
      const original = structuredClone(run.contract);
      run.reply.claims[0].consistency = 'inconsistent';
      run.reply.claims[0].issues = [{code, contentLocations: [span(run.input.snapshot.body)]}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency: 'inconsistent',
        claims: [{claimId: 'claim-a', issues: [{code}]}]});
      expect(run.contract).toEqual(original);
    });

  it('retains omitted assertions from a table while allowing no-declaration acknowledgements', async () => {
    const run = fixture({body: '| observation | 9 ms |'});
    run.contract.claims = [];
    run.reply.claims = [];
    run.reply.omissions = [{code: 'undeclared_claim', contentLocations: [span(run.input.snapshot.body)]}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', consistency: 'inconsistent', omissions: [{code: 'undeclared_claim'}]});
    const acknowledgement = fixture({body: 'Understood.'});
    acknowledgement.input.snapshot.conclusionContract = undefined;
    acknowledgement.input.snapshot.declarationBindingEligibility = 'legacy_unchecked';
    acknowledgement.reply.claims = [];
    expect(await assessFinalSemantics(acknowledgement.input)).toMatchObject({status: 'checked', consistency: 'consistent', claims: []});
  });

  it('does not upgrade missing or invalid semantics because the model returned consistent', async () => {
    const run = fixture();
    delete run.contract.claims![0].semantics;
    run.contract.claims![0].rawSemantics = {predicate: 'unparsed original'};
    run.input.snapshot.protocolDiagnostics = {rawPayload: {claims: [{semantics: {predicate: 'unparsed original'}}]}};
    const result = await assessFinalSemantics(run.input);
    expect(result).toMatchObject({status: 'coverage_incomplete', consistency: 'unknown', claims: [{consistency: 'unknown'}]});
    expect(run.dispatch.mock.calls[0][0].prompt).toContain('unparsed original');
  });

  it.each(['missing', 'duplicate'] as const)('rejects %s declaration IDs without inventing replacements', async kind => {
    const run = fixture();
    if (kind === 'missing') delete run.contract.claims![0].id;
    else run.contract.claims!.push(structuredClone(run.contract.claims![0]));
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_declarations'});
    expect(run.dispatch).not.toHaveBeenCalled();
  });

  it('validates UTF-16 boundaries and exact repeated-text locations', async () => {
    const body = '😀 值为 9 ms；值为 9 ms。';
    const valid = fixture({body});
    valid.reply.claims[0].contentLocations = [span(body, body.lastIndexOf('值为'), body.length)];
    expect(await assessFinalSemantics(valid.input)).toMatchObject({status: 'checked'});
    const invalid = fixture({body});
    invalid.reply.claims[0].contentLocations = [span(body, 1, 2)];
    expect(await assessFinalSemantics(invalid.input)).toMatchObject({reason: 'invalid_response'});
  });
});

describe('final semantic v2 exact quotation locations', () => {
  function quoteFixture(options: Parameters<typeof fixture>[0] = {}) {
    const run = fixture(options);
    const quote = {text: run.input.snapshot.body};
    const reply: any = {...run.reply, schemaVersion: 'final_semantic_response@2',
      claims: run.reply.claims.map(claim => ({...claim, contentLocations: [quote]})),
      requirements: run.reply.requirements.map(requirement => ({...requirement, contentLocations: [quote]}))};
    run.dispatch.mockImplementation(async () => ({status: 'ok', text: JSON.stringify(reply)}));
    return {...run, reply};
  }

  it('requests v2 in the real template and retains only offsets with the existing one-review cache', async () => {
    const run = quoteFixture({body: '😀 本次区间持续 9 ms。'});
    run.reply.claims[0].contentLocations = [{text: '本次区间持续 9 ms'}];
    const pending = assessFinalSemantics(run.input);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    const assessment = await pending;
    expect(assessment).toMatchObject({schemaVersion: 'final_semantic_assessment@1', status: 'checked',
      consistency: 'consistent', claims: [{contentLocations: [{start: 3, end: 14}]}]});
    expect(assessment.claims[0].contentLocations[0]).toEqual({start: 3, end: 14});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.reads).not.toHaveBeenCalled();
    const prompt = run.dispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain('"schemaVersion": "final_semantic_response@2"');
    expect(prompt).toContain('including overlapping matches');
    expect(prompt).toContain('does not establish factual');
    expect(prompt).toContain(`"bodyUtf16Length":${run.input.snapshot.body.length}`);
  });

  it.each([1, 2])('selects exact repeated text occurrence %s in the whole original body', async occurrence => {
    const run = quoteFixture({body: '值为 9 ms；值为 9 ms。'});
    run.reply.claims[0].contentLocations = [{text: '值为 9 ms', occurrence}];
    const start = occurrence === 1 ? 0 : 8;
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start, end: start + 7}]}]});
  });

  it('counts overlapping occurrences rather than advancing by the quotation length', async () => {
    const run = quoteFixture({body: 'banana'});
    run.reply.claims[0].contentLocations = [{text: 'ana', occurrence: 2}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start: 3, end: 6}]}]});
  });

  it.each([undefined, 0, -1, 1.5, 3, Number.MAX_SAFE_INTEGER + 1, '2', null, true])(
    'rejects ambiguous or invalid repeated-text occurrence %s', async occurrence => {
      const run = quoteFixture({body: 'banana'});
      run.reply.claims[0].contentLocations = [{text: 'ana', ...(occurrence === undefined ? {} : {occurrence})}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response', claims: []});
    });

  it.each([
    {body: '  开始\r\n😀  e\u0301结束  ', text: '\r\n😀  e\u0301', start: 4, end: 12},
    {body: 'café e\u0301', text: 'e\u0301', start: 5, end: 7},
    {body: ' 9 ms ', text: ' 9 ms ', start: 0, end: 6},
  ])('preserves exact CRLF, spaces and combining characters in $text', async ({body, text, start, end}) => {
    const run = quoteFixture({body});
    run.reply.claims[0].contentLocations = [{text}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked',
      claims: [{contentLocations: [{start, end}]}]});
  });

  it.each([
    {body: 'x\r\n y', text: 'x\n y'},
    {body: 'x  y', text: 'x y'},
    {body: 'e\u0301', text: 'é'},
    {body: '😀', text: '\ud83d'},
    {body: '😀', text: '\ude00'},
    {body: 'seen', text: 'missing'},
    {body: 'x \r\n y', text: ' \r\n '},
    {body: 'seen', text: ''},
  ])('rejects nonexact, empty or split-surrogate quotation $text', async ({body, text}) => {
    const run = quoteFixture({body});
    run.reply.claims[0].contentLocations = [{text}];
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
  });

  it.each(['start', 'end', 'both', 'extra', 'duplicate', 'mixed', 'one_bad'] as const)(
    'rejects the entire v2 response for %s location fields', async invalid => {
      const run = quoteFixture();
      const quote = {text: run.input.snapshot.body};
      if (invalid === 'start') run.reply.claims[0].contentLocations = [{...quote, start: 0}];
      if (invalid === 'end') run.reply.claims[0].contentLocations = [{...quote, end: quote.text.length}];
      if (invalid === 'both') run.reply.claims[0].contentLocations = [span(quote.text)];
      if (invalid === 'extra') run.reply.claims[0].contentLocations = [{...quote, verified: true}];
      if (invalid === 'duplicate') run.reply.claims[0].contentLocations = [quote, {...quote, occurrence: 1}];
      if (invalid === 'mixed') run.reply.claims[0].contentLocations = [quote, span(quote.text)];
      if (invalid === 'one_bad') run.reply.claims[0].contentLocations = [quote, {text: 'not in body'}];
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response', claims: []});
    });

  it.each(['missing_offsets', 'mixed_quote', 'occurrence'] as const)(
    'never repairs v1 %s using the v2 quotation protocol', async invalid => {
      const run = fixture();
      const quote = {text: run.input.snapshot.body};
      if (invalid === 'missing_offsets') run.reply.claims[0].contentLocations = [quote as any];
      if (invalid === 'mixed_quote') run.reply.claims[0].contentLocations.push(quote as any);
      if (invalid === 'occurrence') Object.assign(run.reply.claims[0].contentLocations[0], {occurrence: 1});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });

  it.each(['claim', 'issue', 'omission', 'requirement'] as const)(
    'resolves and validates every location in the %s collection', async collection => {
      const requirements = [{id: 'observation', label: 'Observation', required: true}];
      for (const invalid of [false, true]) {
        const run = quoteFixture({requirements, scope: 'scene_wide'});
        const locations = [{text: run.input.snapshot.body}, ...(invalid ? [{text: 'not in body'}] : [])];
        if (collection === 'claim') run.reply.claims[0].contentLocations = locations;
        if (collection === 'issue') {
          run.reply.claims[0].consistency = 'inconsistent';
          run.reply.claims[0].issues = [{code: 'numeric_mismatch', contentLocations: locations}];
        }
        if (collection === 'omission') run.reply.omissions = [{code: 'undeclared_claim', contentLocations: locations}];
        if (collection === 'requirement') run.reply.requirements[0].contentLocations = locations;
        const assessment = await assessFinalSemantics(run.input);
        expect(assessment).toMatchObject(invalid ? {reason: 'invalid_response', claims: [], omissions: [], requirements: []}
          : {status: 'checked', consistency: collection === 'issue' || collection === 'omission' ? 'inconsistent' : 'consistent'});
        if (!invalid) expect(JSON.stringify(assessment)).not.toContain('"text":');
      }
    });

  it.each(['missing_claim', 'duplicate_claim', 'missing_omissions', 'empty_omission', 'missing_requirement',
    'duplicate_requirement', 'wrong_claim_ref', 'coverage_gap', 'coverage_quote', 'extra_coverage'] as const)(
    'preserves the existing full-response rejection for %s', async invalid => {
      const run = quoteFixture({requirements: [{id: 'observation', label: 'Observation', required: true}], scope: 'scene_wide'});
      if (invalid === 'missing_claim') run.reply.claims = [];
      if (invalid === 'duplicate_claim') run.reply.claims.push(structuredClone(run.reply.claims[0]));
      if (invalid === 'missing_omissions') delete run.reply.omissions;
      if (invalid === 'empty_omission') run.reply.omissions = [{code: 'undeclared_claim', contentLocations: []}];
      if (invalid === 'missing_requirement') run.reply.requirements = [];
      if (invalid === 'duplicate_requirement') run.reply.requirements.push(structuredClone(run.reply.requirements[0]));
      if (invalid === 'wrong_claim_ref') run.reply.requirements[0].claimIds = ['unknown'];
      if (invalid === 'coverage_gap') run.reply.bodyCoverage.reviewedSpans[0].end -= 1;
      if (invalid === 'coverage_quote') run.reply.bodyCoverage.reviewedSpans = [{text: run.input.snapshot.body}];
      if (invalid === 'extra_coverage') run.reply.bodyCoverage.reviewedSpans[0].text = run.input.snapshot.body;
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });
});

describe('semantic report applicability and coverage', () => {
  const required = {id: 'observation', label: 'Observed data', required: true};
  it('accepts content locations without a prescribed heading', async () => {
    const run = fixture({requirements: [required], scope: 'scene_wide'});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'checked', coverage: {report: 'complete'},
      requirements: [{requirementId: 'observation', applicability: 'applicable', coverage: 'covered'}]});
  });

  it.each(['extra_id', 'duplicate_id', 'missing_id', 'bad_claim_ref', 'bad_one_of_many_spans', 'unconditional_waiver'] as const)(
    'rejects every invalid coverage row: %s', async issue => {
      const run = fixture({requirements: [required], scope: 'scene_wide'});
      if (issue === 'extra_id') run.reply.requirements[0].requirementId = 'unknown';
      if (issue === 'duplicate_id') run.reply.requirements.push(structuredClone(run.reply.requirements[0]));
      if (issue === 'missing_id') run.reply.requirements = [];
      if (issue === 'bad_claim_ref') run.reply.requirements[0].claimIds.push('unknown-claim');
      if (issue === 'bad_one_of_many_spans') run.reply.requirements[0].contentLocations.push({start: -1, end: 1, text: 'bad'});
      if (issue === 'unconditional_waiver') Object.assign(run.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown'});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
    });

  it('permits bounded semantic applicability and retains unresolved conditions as unknown', async () => {
    const bounded = fixture({requirements: [required], scope: 'bounded_question'});
    Object.assign(bounded.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(bounded.input)).toMatchObject({status: 'checked', requirements: [{applicability: 'not_applicable'}]});
    const unresolved = fixture({requirements: [{...required, condition: {kind: 'unresolved', reason: 'legacy_trigger_patterns'}}]});
    Object.assign(unresolved.reply.requirements[0], {applicability: 'unknown', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(unresolved.input)).toMatchObject({status: 'coverage_incomplete', coverage: {report: 'incomplete'}});
  });

  it.each([true, false])('keeps optional unknown coverage non-blocking with required rows=%s', async includeRequired => {
    const optional = {id: 'optional', label: 'Optional context', required: false,
      condition: {kind: 'semantic' as const, description: 'When useful to the question.'}};
    const run = fixture({requirements: [...(includeRequired ? [required] : []), optional], scope: 'scene_wide'});
    const optionalRow = run.reply.requirements.find(item => item.requirementId === 'optional')!;
    Object.assign(optionalRow, {applicability: 'unknown', coverage: 'unknown', contentLocations: [], claimIds: []});
    const assessment = await assessFinalSemantics(run.input);
    expect(assessment).toMatchObject({status: 'checked', coverage: {report: 'complete'}});
    expect(assessment.requirements).toContainEqual({requirementId: 'optional', applicability: 'unknown', coverage: 'unknown',
      contentLocations: [], claimIds: []});
  });

  it.each(['not_checked', 'unavailable', 'checked'] as const)('uses actual case retrieval state %s without inventing complete search', async status => {
    const run = fixture({requirements: [{...required, condition: {kind: 'strong_case_retrieval'}}],
      caseRetrieval: {status, recommendations: []}});
    Object.assign(run.reply.requirements[0], {applicability: status === 'checked' ? 'not_applicable' : 'unknown',
      coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: status === 'checked' ? 'checked' : 'coverage_incomplete'});
  });

  it('cannot waive an actual strong case retrieval requirement', async () => {
    const run = fixture({requirements: [{...required, condition: {kind: 'strong_case_retrieval'}}],
      caseRetrieval: {status: 'checked', recommendations: [{caseId: 'case-1', title: 'Relevant case', matchStrength: 'strong', recommendations: {app: [], oem: []}}]}});
    Object.assign(run.reply.requirements[0], {applicability: 'not_applicable', coverage: 'unknown', contentLocations: [], claimIds: []});
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_response'});
  });

  it('rejects absent or mutated requirement pins before dispatch', async () => {
    const run = fixture({requirements: [required]});
    run.input.snapshot.reportRequirements = undefined;
    expect(await assessFinalSemantics(run.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(run.dispatch).not.toHaveBeenCalled();
    const mutated = fixture({requirements: [required]});
    mutated.input.snapshot.reportRequirements = {...mutated.input.snapshot.reportRequirements!,
      requirements: [{...required, label: 'unrelated requirement'}]};
    expect(await assessFinalSemantics(mutated.input)).toMatchObject({reason: 'invalid_snapshot'});
    expect(mutated.dispatch).not.toHaveBeenCalled();
  });
});

describe('semantic dispatch failure and cancellation', () => {
  it.each(['provider_error', 'timeout', 'tool_use', 'incomplete_output', 'output_limit'] as const)(
    'does not turn native %s into a semantic pass', async reason => {
      const run = fixture({dispatch: async () => ({status: 'unavailable', reason})});
      expect(await assessFinalSemantics(run.input)).toMatchObject({reason, consistency: 'unknown'});
      expect(run.dispatch).toHaveBeenCalledTimes(1);
    });

  it('rejects an oversized response without accepting its prefix', async () => {
    const run = fixture({dispatch: async () => ({status: 'ok', text: 'x'.repeat(65_537)})});
    expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'coverage_incomplete', reason: 'output_limit'});
  });

  it('does not disclose provider exception details', async () => {
    const run = fixture({dispatch: async () => {throw new Error('credential=do-not-echo');}});
    const result = await assessFinalSemantics(run.input);
    expect(result).toMatchObject({status: 'unavailable', reason: 'provider_error'});
    expect(JSON.stringify(result)).not.toContain('do-not-echo');
  });

  it('honors pre-dispatch cancellation and an already-expired original deadline', async () => {
    const cancelled = fixture();
    cancelled.controller.abort();
    expect(() => assessFinalSemantics(cancelled.input)).toThrow();
    expect(cancelled.dispatch).not.toHaveBeenCalled();
    const expired = fixture({deadlineMs: Date.now() - 1});
    expect(await assessFinalSemantics(expired.input)).toMatchObject({reason: 'timeout'});
    expect(expired.dispatch).not.toHaveBeenCalled();
  });

  it('uses the context deadline to stop an unresponsive native callback', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 1_100, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({reason: 'timeout', consistency: 'unknown'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(1_100);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
  });

  it('accepts a same-request response after 60 seconds when the original run deadline has time remaining', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    let settled = false;
    void pending.then(() => {settled = true;});
    await jest.advanceTimersByTimeAsync(65_000);
    expect(settled).toBe(false);
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(await pending).toMatchObject({status: 'checked', consistency: 'consistent'});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    expect(run.input.context.deadlineMs).toBe(91_000);
  });

  it('stops an unresponsive issued transport at the original deadline without renewing it on repeated calls', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    let settled = false;
    void pending.then(() => {settled = true;});
    await jest.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    await jest.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown'});
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('preserves the original absolute deadline across dispatch delay and ignores success after the cached timeout', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    // Synchronous work before the dispatch microtask consumes the original run budget.
    jest.setSystemTime(31_000);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    await jest.advanceTimersByTimeAsync(60_000);
    const timeout = await pending;
    expect(timeout).toMatchObject({status: 'unavailable', reason: 'timeout'});
    expect(run.dispatch.mock.calls[0][0].deadlineMs).toBe(91_000);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    await jest.advanceTimersByTimeAsync(0);
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(await assessFinalSemantics(run.input)).toBe(timeout);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful response after a clock jump past the original deadline before its timer runs', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(0);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
    jest.setSystemTime(91_001);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(await pending).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown'});
    expect(assessFinalSemantics(run.input)).toBe(pending);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('stops a disposed context and never accepts its late response', async () => {
    jest.useFakeTimers({now: 1_000});
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({deadlineMs: 91_000, dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    await jest.advanceTimersByTimeAsync(0);
    run.input.context.dispose();
    const disposed = await pending;
    expect(disposed).toMatchObject({status: 'unavailable', consistency: 'unknown'});
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    await jest.advanceTimersByTimeAsync(0);
    expect(await pending).toBe(disposed);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it('lets owner cancellation win before the original deadline even if the callback never settles', async () => {
    jest.useFakeTimers({now: 1_000});
    const run = fixture({deadlineMs: 901_000, dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const pending = assessFinalSemantics(run.input);
    const cancelled = new Error('review owner cancelled');
    const rejected = expect(pending).rejects.toBe(cancelled);
    await jest.advanceTimersByTimeAsync(100);
    run.controller.abort(cancelled);
    await rejected;
    expect(Date.now()).toBe(1_100);
    expect(run.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'does not turn an invalid original deadline %s into a valid service budget', async deadlineMs => {
      const run = fixture();
      run.input.context = {...run.input.context, deadlineMs};
      expect(await assessFinalSemantics(run.input)).toMatchObject({status: 'not_checked', reason: 'invalid_configuration'});
      expect(run.dispatch).not.toHaveBeenCalled();
    });

  it('propagates cancellation and discards a late successful response', async () => {
    let resolve!: (response: IntentTransportResult) => void;
    const run = fixture({dispatch: async () => new Promise<IntentTransportResult>(done => {resolve = done;})});
    const pending = assessFinalSemantics(run.input);
    const rejection = expect(pending).rejects.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    run.controller.abort();
    await rejection;
    resolve({status: 'ok', text: JSON.stringify(run.reply)});
    expect(run.dispatch).toHaveBeenCalledTimes(1);
  });
});
