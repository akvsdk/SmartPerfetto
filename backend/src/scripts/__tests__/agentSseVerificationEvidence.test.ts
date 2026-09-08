// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CodeLookupLedgerEntry} from '../../services/codebase/codeLookupLedger';
import {
  privateProjectedSourceEventType,
  successfulCodeLookupToolCounts,
} from '../agentSseVerificationEvidence';
import {
  collectAgentSseOracleRows,
  evaluateAgentSseExpectation,
  parseAgentSseExpectation,
  taskAcceptanceStatus,
  assertVerificationTraceReady,
  loadVerificationTracePair,
  type TerminalAnalysisEvidence,
} from '../verifyAgentSseScrolling';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';

const expectation = parseAgentSseExpectation({schemaVersion: 1,
  intent: {taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer'},
  facts: [{id: 'frame_count', kind: 'numeric', columns: ['total_frames'], unit: 'frames',
    verification: 'proved', oracle: {sql: 'SELECT COUNT(*) AS total_frames FROM actual_frame_timeline_slice', column: 'total_frames', unit: 'frames'}}]});

function terminalFixture(text = 'There are 1912 frames.'): TerminalAnalysisEvidence {
  const reference = {evidenceRefId: 'data:frames', rowIndex: 0, column: 'total_frames', value: 1912};
  const semantics = {schemaVersion: 'claim_semantics@1' as const, predicate: 'numeric.cell',
    polarity: 'affirmed' as const, discourse: 'asserted' as const, modality: 'certain' as const, quantifier: 'one' as const,
    scope: {population: 'cited_rows' as const, subjectRefs: [reference]}, numeric: {operator: 'eq' as const, value: 1912, unit: 'frames'}};
  return {
    success: true, conclusion: text,
    completion: {schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk', runId: 'run',
      attemptId: 'attempt', candidateRef: 'candidate', conclusionFingerprint: analysisDeliveryFingerprint(text)},
    deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed', claims: 'passed',
      source: 'not_applicable', identity: 'not_applicable', report: 'not_applicable'},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', sceneId: 'scrolling',
      taskKind: 'fact', scope: 'bounded_question', deliverable: 'answer', recommendedComplexity: 'quick',
      evidenceAccess: 'read_new', registryFingerprint: 'registry'},
    conclusionContract: {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [],
      clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
      claims: [{id: 'frames', kind: 'numeric', text, references: [reference], semantics}]},
    claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'passed', passed: true, policy: 'record_only',
      checkedClaimCount: 1, unsupportedClaimCount: 0, issues: [], claimResults: [{claimId: 'frames', status: 'verified',
        referenceCells: [{anchorId: 'anchor:frames', evidenceRefId: 'data:frames', column: 'total_frames', status: 'matched'}],
        deterministicProof: {kind: 'numeric_cell', status: 'proved', reason: 'numeric_cell_verified',
          anchorIds: ['anchor:frames'], evidenceRefIds: ['data:frames']},
        propositionCoverage: {status: 'complete', covered: ['numeric'], uncovered: [], reason: 'proved'}}]},
    claimSupport: [{claimId: 'frames', kind: 'numeric', text, semantics, supportLevel: 'verified', anchors: [{
      anchorId: 'anchor:frames', evidenceRefId: 'data:frames', version: 'evidence_contract@1',
      context: {traceId: 'trace-current', traceSide: 'current', producerKind: 'execute_sql'},
      cells: [{column: 'total_frames', rowIndex: 0, value: 1912, actualValue: 1912}],
    }]}],
  };
}

function evaluate(terminal = terminalFixture()) {
  return evaluateAgentSseExpectation({terminal, expectation, traceId: 'trace-current',
    oracleRows: {frame_count: [{total_frames: 1912}]}});
}

describe('Agent SSE verification evidence', () => {
  it('admits only a ready trace and preserves the processor startup error', () => {
    expect(() => assertVerificationTraceReady('trace', {status: 'ready'})).not.toThrow();
    for (const status of ['uploading', 'processing', 'error'] as const) {
      expect(() => assertVerificationTraceReady('trace', {status, error: 'worker module could not load'}))
        .toThrow('worker module could not load');
    }
    expect(() => assertVerificationTraceReady('trace', undefined)).toThrow('not ready (missing)');
  });

  it('rejects a failed reference before pair admission while retaining both IDs for cleanup', async () => {
    const owned: string[] = [];
    const oracle = jest.fn();
    const service = {
      loadTraceFromFilePath: jest.fn(async (file: string) => file),
      getTrace: jest.fn((id: string) => ({id, filename: id, size: 1, uploadTime: new Date(),
        status: id === 'primary' ? 'ready' as const : 'error' as const, error: 'reference worker failed'})),
    };
    await expect(loadVerificationTracePair({service, tracePath: 'primary', referenceTracePath: 'reference',
      onLoaded: id => owned.push(id)}).then(oracle)).rejects.toThrow('reference worker failed');
    expect(owned).toEqual(['primary', 'reference']);
    expect(oracle).not.toHaveBeenCalled();
    await expect(loadVerificationTracePair({service, tracePath: 'primary'})).resolves.toEqual({traceId: 'primary'});
  });
  it('recognizes privacy-projected full-mode lifecycle events', () => {
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'plan_submitted',
    })).toBe('plan_submitted');
    expect(privateProjectedSourceEventType({
      privateModelTextSuppressed: true,
      sourceEventType: 'agent_response',
    })).toBe('agent_response');
    expect(privateProjectedSourceEventType({sourceEventType: 'plan_submitted'})).toBeUndefined();
  });

  it('credits only successful provenance-bearing code lookups', () => {
    const entry = (
      toolName: CodeLookupLedgerEntry['toolName'],
      outcome: CodeLookupLedgerEntry['outcome'],
      chunkIds: string[],
    ): CodeLookupLedgerEntry => ({
      turn: 1,
      ts: 1,
      toolName,
      chunkIds,
      consentApplied: true,
      tokensSpent: 10,
      outcome,
      legacyPath: false,
    });

    expect(successfulCodeLookupToolCounts([
      entry('lookup_app_source', 'success', ['chunk-app']),
      entry('lookup_blog_knowledge', 'success', ['chunk-rag']),
      entry('lookup_app_source', 'unresolved', []),
      entry('lookup_kernel_source', 'success', []),
    ])).toEqual({
      lookup_app_source: 1,
      lookup_blog_knowledge: 1,
    });
  });
});

describe('task fact oracle (deterministic composition, not a model semantic benchmark)', () => {
  it('does not promote reference-only or uncovered facets into full semantic acceptance', () => {
    expect(taskAcceptanceStatus(true, ['identity: proposition proof unavailable'])).toEqual({
      observedChecksPassed: true, semanticAcceptance: 'INCONCLUSIVE', completeAcceptance: false,
    });
    expect(taskAcceptanceStatus(true, [])).toMatchObject({semanticAcceptance: 'PASSED', completeAcceptance: true});
  });
  it.each(['There are 1912 frames.', '共记录 1912 帧。', 'The trace contains 1,912 frames.'])
    ('accepts equivalent output without titles or a prescribed tool path: %s', text => {
      expect(Object.values(evaluate(terminalFixture(text)).checks).every(Boolean)).toBe(true);
    });

  it('does not accept successful tool counts when no original claims or raw proof exist', () => {
    const terminal = terminalFixture();
    terminal.conclusionContract!.claims = [];
    const result = evaluate(terminal);
    expect(result.checks.originalClaimsVerified).toBe(false);
    expect(result.facts.frame_count.matched).toBe(false);
  });

  it('keeps the wrong proposition 9999 separate from an unrelated correctly cited 1912', () => {
    const terminal = terminalFixture('There are 9999 frames; 1912 unrelated events were observed.');
    terminal.conclusionContract!.claims![0].semantics!.numeric!.value = 9999;
    expect(evaluate(terminal).facts.frame_count.matched).toBe(false);
  });

  it('accepts exact numeric strings and artifact references without imposing evidence-id spelling', () => {
    const terminal = terminalFixture();
    terminal.conclusionContract!.claims![0].semantics!.numeric!.value = '1912';
    const reference = terminal.conclusionContract!.claims![0].semantics!.scope.subjectRefs![0];
    delete reference.evidenceRefId;
    reference.artifactId = 'artifact:frames';
    terminal.claimSupport![0].anchors[0].context.artifactId = 'artifact:frames';
    expect(Object.values(evaluate(terminal).checks).every(Boolean)).toBe(true);
  });

  it.each(['negated', 'quoted', 'rejected_quote', 'possible'])('does not turn %s language into the requested fact', disposition => {
    const terminal = terminalFixture();
    const semantics = terminal.conclusionContract!.claims![0].semantics!;
    if (disposition === 'negated') semantics.polarity = disposition;
    else if (disposition === 'possible') semantics.modality = disposition;
    else semantics.discourse = disposition as 'quoted' | 'rejected_quote';
    expect(evaluate(terminal).facts.frame_count.matched).toBe(false);
  });

  it.each(['wrong_trace', 'wrong_unit', 'missing_anchor', 'wrong_cell', 'partial_proof', 'v1', 'stale_body', 'unavailable_assurance'])
    ('rejects %s even if the aggregate compatibility flag says passed', failure => {
      const terminal = terminalFixture();
      if (failure === 'wrong_trace') terminal.claimSupport![0].anchors[0].context.traceId = 'other';
      if (failure === 'wrong_unit') terminal.conclusionContract!.claims![0].semantics!.numeric!.unit = 'events';
      if (failure === 'missing_anchor') terminal.claimSupport![0].anchors = [];
      if (failure === 'wrong_cell') terminal.claimSupport![0].anchors[0].cells![0].actualValue = 9999;
      if (failure === 'partial_proof') terminal.claimVerificationResult!.claimResults[0].propositionCoverage!.status = 'partial';
      if (failure === 'v1') terminal.claimVerificationResult!.schemaVersion = 'claim_verifier@1';
      if (failure === 'stale_body') terminal.conclusion = 'changed after verification';
      if (failure === 'unavailable_assurance') terminal.deliveryAssurance!.claims = 'unavailable';
      expect(Object.values(evaluate(terminal).checks).every(Boolean)).toBe(false);
    });

  it('requires independently queried task facts, not a different numeric observation', () => {
    const result = evaluateAgentSseExpectation({terminal: terminalFixture(), expectation, traceId: 'trace-current',
      oracleRows: {frame_count: [{total_frames: 8}]}});
    expect(result.facts.frame_count.matched).toBe(false);
  });

  it('checks the semantic scope decision instead of counting plan/tool events', () => {
    const terminal = terminalFixture();
    terminal.turnIntent = {...terminal.turnIntent!, scope: 'scene_wide', deliverable: 'report'};
    expect(evaluate(terminal).checks['intent:scope']).toBe(false);
    expect(evaluate(terminal).checks['intent:deliverable']).toBe(false);
  });

  it('rejects unknown expectation keys, missing numeric targets, and mutation SQL', () => {
    expect(() => parseAgentSseExpectation({...expectation, typo: true})).toThrow('Invalid --expectation-json');
    expect(() => parseAgentSseExpectation({...expectation, intent: {...expectation.intent, scope: 'all'}})).toThrow();
    expect(() => parseAgentSseExpectation({...expectation, facts: [{...expectation.facts[0], oracle: undefined}]})).toThrow();
    expect(() => parseAgentSseExpectation({...expectation, facts: [{...expectation.facts[0],
      oracle: {sql: 'SELECT 1; DROP TABLE process', column: 'total_frames'}}]})).toThrow();
  });

  it('collects real oracle rows and fails closed on unavailable or missing metrics', async () => {
    const query = jest.fn(async () => ({columns: ['total_frames'], rows: [[1912]]}));
    await expect(collectAgentSseOracleRows(expectation, query)).resolves.toEqual({frame_count: [{total_frames: 1912}]});
    expect(query).toHaveBeenCalledTimes(1);
    await expect(collectAgentSseOracleRows(expectation, async () => ({columns: ['other'], rows: [[1912]]})))
      .rejects.toThrow('Task fact oracle unavailable');
  });
});
