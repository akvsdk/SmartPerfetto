// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {parseConclusionContractDeclaration, type ConclusionContract} from '../../agent/core/conclusionContract';
import {attachFinalizationContext, takeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import type {IntentTransportInput, IntentTransportResult} from '../../agentRuntime/intentTransport';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {buildStrategyRegistrySnapshotFromDefinitions, type StrategyDefinition} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import type {EvidenceScopeProvenanceV1, IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import {finalizeAnalysisResult, type AnalysisFinalizationOwner} from '../finalizeAnalysisResult';
import {clearAllCodeAwareOutputGuards, registerCodeAwareCanary,
  registerPrivateAnalysisQueryForEcho, sanitizeCodeAwareText} from '../security/codeAwareOutputRegistry';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'final-result-test'});

function fixture(options: {body?: string; capture?: boolean; claim?: boolean; inconsistent?: boolean;
  omissions?: boolean; report?: boolean; providerQuery?: {text: string; analysisContextFingerprint?: string};
  identity?: IdentityResolutionV1; scope?: EvidenceScopeProvenanceV1;
  deadlineMs?: number;
  dispatch?: (input: IntentTransportInput) => Promise<IntentTransportResult>} = {}) {
  const body = options.body ?? 'The captured value is 49.';
  const ref = {evidenceRefId: 'data:count', rowIndex: 0, column: 'count', value: 49};
  const declared: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
    claims: options.claim === false ? [] : [{id: 'count', kind: 'numeric', text: body, references: [ref],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'numeric.cell', polarity: 'affirmed',
        discourse: 'asserted', quantifier: 'one', modality: 'certain',
        scope: {population: 'cited_rows', subjectRefs: [ref]}, numeric: {operator: 'eq', value: 49, unit: 'count'}}}]};
  const result: AnalysisResult = {sessionId: 'final-result-test', conclusion: body, success: true,
    confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1,
    conclusionContract: parseConclusionContractDeclaration(declared).contract};
  const envelope = createDataEnvelope({columns: ['count'], rows: [[49]]}, {
    type: 'sql_result', source: 'execute_sql', title: 'Count', evidenceRefId: 'data:count',
    traceId: 'trace', traceSide: 'current', executionStatus: 'observed', identityResolution: options.identity,
    scopeProvenance: options.scope});
  const store = new ArtifactStore();
  if (options.capture !== false) store.registerStandaloneEvidenceCapture(captureEvidenceTable(envelope.data, {
    count: {unit: 'count', origin: {kind: 'native_producer', definitionFingerprint: 'count-v1'}},
  }), {meta: envelope.meta, display: envelope.display});
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(body)};
  const controller = new AbortController();
  const owner: AnalysisFinalizationOwner = {runId: 'run', signal: controller.signal,
    isCurrent: () => true, assertAuthorized: () => {}};
  const dispatch = jest.fn(options.dispatch ?? (async (): Promise<IntentTransportResult> => {
    const location = {start: 0, end: body.length, text: body};
    return {status: 'ok', text: JSON.stringify({schemaVersion: 'final_semantic_response@1',
      bodyCoverage: {status: 'complete', reviewedSpans: [{start: 0, end: body.length}]},
      claims: options.claim === false ? [] : [{claimId: 'count',
        consistency: options.inconsistent ? 'inconsistent' : 'consistent', contentLocations: [location],
        issues: options.inconsistent ? [{code: 'numeric_mismatch', contentLocations: [location]}] : []}],
      omissions: options.omissions ? [{code: 'undeclared_claim', contentLocations: [location]}] : [],
      requirements: options.report ? [{requirementId: 'detail', applicability: 'applicable', coverage: 'unknown',
        contentLocations: [], claimIds: []}] : []})};
  }));
  const reportStrategy: StrategyDefinition = {scene: 'general', classificationDescription: 'General analysis.',
    strategyKind: 'normal', priority: 1, effort: 'low', keywords: [], compoundPatterns: [], requiredCapabilities: [],
    optionalCapabilities: [], phaseHints: [], planTemplate: null, verifierMisdiagnosisPatterns: [], content: 'General analysis.',
    detailSections: [], sourcePath: '/fixture/general.strategy.md', finalReportContract: {requiredSections: [{
      id: 'detail', label: 'Detail', required: true, triggerPatterns: [], patterns: [], patternGroups: [], recoveryText: {zh: [], en: []},
    }]}};
  const pinnedRegistry = options.report
    ? buildStrategyRegistrySnapshotFromDefinitions({definitions: [reportStrategy], overlayGeneration: 'report-test'}) : registry;
  attachFinalizationContext(result, {runId: 'run', sessionId: result.sessionId, deadlineMs: options.deadlineMs ?? Date.now() + 10_000,
    strategyRegistry: pinnedRegistry, traceIdentity: {currentTraceId: 'trace'},
    providerQuery: options.providerQuery,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: pinnedRegistry.registryFingerprint,
      taskKind: 'fact', sceneId: 'general', scope: options.report ? 'scene_wide' : 'bounded_question', recommendedComplexity: 'quick',
      deliverable: options.report ? 'report' : 'answer', evidenceAccess: 'existing_only'},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate, outputOrigin: 'sdk_final',
      completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}},
    evidenceReadView: store.createEvidenceReadView({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: 'run'}),
    dispatchText: dispatch});
  const context = takeFinalizationContext(result)!;
  return {result, context, controller, owner, dispatch, envelope,
    run: () => finalizeAnalysisResult({result, context, owner, query: 'What is the captured value?', dataEnvelopes: [envelope]})};
}

afterEach(() => {clearAllCodeAwareOutputGuards(); jest.useRealTimers();});

describe('shared final analysis boundary', () => {
  const capturedIdentity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: 'identity:target',
    status: 'verified', target: {traceId: 'trace', traceSide: 'current', upid: 42, source: 'skill_param'},
    processes: [{upid: 42, confidence: 1, matchSources: ['upid']}], threads: [], warnings: []};
  const capturedScope: EvidenceScopeProvenanceV1 = {version: 'process_scope_evidence@1', entries: [{role: 'target',
    scope: {mode: 'exact_upid', traceId: 'trace', traceSide: 'current', upid: 42, identityRefId: capturedIdentity.identityRefId}}]};

  it('replaces forged display identity with the issued capture even when no sidecar claims exist', async () => {
    const target = fixture({claim: false, identity: capturedIdentity, scope: capturedScope});
    delete target.result.conclusionContract;
    const forged = {...capturedIdentity, target: {...capturedIdentity.target, upid: 999},
      processes: [{upid: 999, confidence: 1, matchSources: ['FORGED']}]};
    target.envelope.meta.identityResolution = forged;
    target.result.identityResolutions = [forged];
    const {result} = await target.run();
    expect(result.identityResolutions).toEqual([capturedIdentity]);
    expect(target.result.identityResolutions).toEqual([forged]);
    expect(target.envelope.meta.identityResolution).toBe(forged);
  });

  it('never manufactures public identity from uncaptured compatibility metadata', async () => {
    const target = fixture({capture: false, identity: capturedIdentity, scope: capturedScope});
    target.envelope.meta.identityResolution = undefined;
    target.envelope.meta.identityRefId = capturedIdentity.identityRefId;
    target.envelope.meta.identityStatus = 'verified';
    target.result.identityResolutions = [capturedIdentity];
    expect((await target.run()).result.identityResolutions).toEqual([]);
  });

  it('retains captured ambiguous status instead of adopting a verified display override', async () => {
    const ambiguous = {...capturedIdentity, status: 'ambiguous' as const};
    const target = fixture({identity: ambiguous, scope: capturedScope});
    target.envelope.meta.identityResolution = capturedIdentity;
    target.envelope.meta.identityStatus = 'verified';
    expect((await target.run()).result.identityResolutions).toEqual([ambiguous]);
  });

  it('leaves public identity empty without a live context and never trusts result metadata', async () => {
    const target = fixture({identity: capturedIdentity, scope: capturedScope});
    target.context.dispose();
    target.result.identityResolutions = [capturedIdentity];
    const {result} = await finalizeAnalysisResult({result: target.result, owner: target.owner,
      query: 'What is already available?', dataEnvelopes: [target.envelope]});
    expect(result.identityResolutions).toEqual([]);
  });

  it('joins an issued captured cell with whole-body semantics before passing the current result', async () => {
    const target = fixture();
    const finalized = await target.run();
    expect(finalized.result.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2', passed: true,
      claimResults: [{claimId: 'count', status: 'verified', deterministicProof: {status: 'proved'}}]});
    expect(finalized.result.deliveryAssurance).toMatchObject({entry: 'new_finalization', completion: 'passed', claims: 'passed'});
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(() => target.context.runId).toThrow();
  });

  it('does not turn matching preview values or semantic agreement into an execution proof', async () => {
    const target = fixture({capture: false});
    const {result} = await target.run();
    expect(result.claimVerificationResult?.passed).toBe(false);
    expect(result.claimVerificationResult?.claimResults.some(claim => claim.status === 'verified')).toBe(false);
    expect(result.deliveryAssurance?.claims).not.toBe('passed');
    expect(result.conclusion).toBe(target.result.conclusion);
  });

  it.each([false, true])('preserves native delivery while semantic review times out, report=%s', async report => {
    jest.useFakeTimers({now: 1_000});
    const target = fixture({report, deadlineMs: 901_000,
      dispatch: async () => new Promise<IntentTransportResult>(() => undefined)});
    const body = target.result.conclusion;
    const delivery = target.context.deliveryContext;
    if (delivery.entry !== 'runtime_draft') throw new Error('Expected the issued runtime draft fixture');
    const candidate = delivery.acceptedCandidate;
    const completion = delivery.completion;
    const pending = target.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].deadlineMs).toBe(61_000);
    await jest.advanceTimersByTimeAsync(60_000);
    const finalized = await pending;
    expect(finalized.semanticAssessment).toMatchObject({status: 'unavailable', reason: 'timeout', consistency: 'unknown',
      binding: {canonicalCandidate: candidate}});
    expect(finalized.result.conclusion).toBe(body);
    expect(target.result.conclusion).toBe(body);
    expect(finalized.result.completion).toEqual(completion);
    expect(finalized.result.success).toBe(true);
    expect(finalized.result.claimVerificationResult).toMatchObject({passed: false,
      claimResults: [{claimId: 'count', status: 'partial', deterministicProof: {status: 'proved'}}]});
    expect(finalized.result.deliveryAssurance).toMatchObject({completion: 'passed', claims: 'coverage_incomplete'});
    expect(finalized.result.partial === true).toBe(report);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(() => target.context.runId).toThrow();
  });

  it.each([false, true])('keeps report gaps independent from a complete claim review, inconsistent=%s', async inconsistent => {
    const target = fixture({report: true, inconsistent});
    const finalized = await target.run();
    expect(finalized.semanticAssessment?.coverage).toEqual({body: 'complete', claims: 'complete', report: 'incomplete'});
    expect(finalized.result.deliveryAssurance?.report).toBe('coverage_incomplete');
    expect(finalized.result.deliveryAssurance?.claims).toBe(inconsistent ? 'failed' : 'passed');
    expect(finalized.result.claimVerificationResult?.claimResults[0].status).toBe(inconsistent ? 'unsupported' : 'verified');
  });

  it('still reports an omitted claim when report coverage is incomplete', async () => {
    const target = fixture({report: true, omissions: true});
    const {result} = await target.run();
    expect(result.claimVerificationResult?.status).toBe('failed');
    expect(result.claimVerificationResult?.issues.map(issue => issue.code)).toContain('semantic_undeclared_claim');
  });

  it('retains source declarations for checking when no actual source ledger exists', async () => {
    const target = fixture();
    target.result.conclusionContract!.sourceClaimBindings = [{claimId: 'count', mechanismStatus: 'compatible',
      sourceReferenceIds: ['invented-source'], traceEvidenceRefIds: ['data:count']}];
    const {result} = await target.run();
    expect(result.sourceUseDecision).toBeUndefined();
    expect(result.sourceClaimVerificationResult).toMatchObject({status: 'partial', issues: [
      expect.objectContaining({code: 'source_claim_semantics_unchecked'}),
    ]});
    expect(result.partial).toBe(true);
  });

  it('uses a detached result when a caller changes the original during the semantic request', async () => {
    const target = fixture();
    const originalDispatch = target.dispatch.getMockImplementation()!;
    target.dispatch.mockImplementation(async request => {
      target.result.conclusion = 'A later run';
      target.result.conclusionContract!.claims![0].semantics!.numeric!.value = 999;
      return originalDispatch(request);
    });
    const {result} = await target.run();
    expect(result.conclusion).toBe('The captured value is 49.');
    expect(result.conclusionContract?.claims?.[0].semantics?.numeric?.value).toBe(49);
    expect(result.claimVerificationResult?.passed).toBe(true);
  });

  it('does not accept a self-consistent old comparison pair outside the runtime pin', async () => {
    const target = fixture();
    const resolution = (traceId: string, traceSide: 'current' | 'reference'): IdentityResolutionV1 => ({
      version: 'identity_contract@1' as const, identityRefId: `identity-${traceId}`, status: 'verified' as const,
      target: {traceId, traceSide, source: 'derived' as const},
      processes: [{upid: 1, pid: 1, processName: 'app', packageName: 'app', matchSources: [], confidence: 1}], threads: [], warnings: [],
    });
    const {result} = await finalizeAnalysisResult({result: target.result, context: target.context, owner: target.owner,
      query: 'Compare', comparisonIdentity: {currentTraceId: 'old-current', referenceTraceId: 'old-reference',
        currentResolution: resolution('old-current', 'current'), referenceResolution: resolution('old-reference', 'reference')}});
    expect(result.deliveryAssurance?.identity).not.toBe('passed');
    expect(result.partial).toBe(true);
  });

  it('rejects a mismatching proposition even when its reference value is correct', async () => {
    const target = fixture({body: 'The captured value is 50.', inconsistent: true});
    const {result} = await target.run();
    expect(result.conclusion).toBe(target.result.conclusion);
    expect(result.conclusionContract?.claims?.[0].references[0].value).toBe(49);
    expect(result.claimVerificationResult).toMatchObject({status: 'failed',
      claimResults: [{claimId: 'count', status: 'unsupported'}]});
    expect(result.deliveryAssurance?.claims).toBe('failed');
  });

  it('requires full semantics before an empty declaration set can represent a non-factual answer', async () => {
    const noFacts = fixture({body: 'Acknowledged.', claim: false});
    expect((await noFacts.run()).result.claimVerificationResult?.passed).toBe(true);
    const omitted = fixture({claim: false, omissions: true});
    expect((await omitted.run()).result.claimVerificationResult?.status).toBe('failed');
    const unavailable = fixture({claim: false, dispatch: async () => ({status: 'unavailable', reason: 'provider_error'})});
    expect((await unavailable.run()).result.claimVerificationResult?.passed).toBe(false);
  });

  it.each([1, 2])('does not convert %i invalid machine declarations into a verified empty claim set', async count => {
    const invalid = '<!-- smartperfetto:conclusion-contract@1\n```json\n{"mode":"broken"}\n```\n-->';
    const target = fixture({body: 'Visible answer\n' + Array(count).fill(invalid).join('\n'), claim: false});
    const finalized = await target.run();
    expect(finalized.result.claimVerificationResult?.passed).toBe(false);
    expect(finalized.semanticAssessment).toMatchObject({status: 'not_checked', reason: 'invalid_declarations'});
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('does not call a provider after privacy projection makes the review input incomplete', async () => {
    const target = fixture();
    registerCodeAwareCanary(target.result.sessionId, 'What is the captured value?');
    const finalized = await target.run();
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(finalized.semanticAssessment).toMatchObject({status: 'coverage_incomplete', reason: 'input_projection_incomplete'});
    expect(finalized.result.claimVerificationResult?.passed).toBe(false);
  });

  it('allows the captured provider-query role while still suppressing the same query in output', async () => {
    const question = 'PRIVATE original provider question';
    const target = fixture({providerQuery: {text: question, analysisContextFingerprint: 'selection'}});
    target.owner.analysisContextFingerprint = 'selection';
    registerPrivateAnalysisQueryForEcho(target.result.sessionId, question);
    const {result} = await target.run();
    expect(result.claimVerificationResult?.passed).toBe(true);
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0].prompt).toContain(question);
    expect(sanitizeCodeAwareText(target.result.sessionId, question)).not.toBe(question);
    expect(JSON.stringify(result)).not.toContain(question);
  });

  it('does not extend query-role permission to the same text in a claim or evidence', async () => {
    const question = 'PRIVATE original provider question';
    const target = fixture({providerQuery: {text: question}});
    target.result.conclusionContract!.claims![0].rawReferences = {privateValue: question};
    registerPrivateAnalysisQueryForEcho(target.result.sessionId, question);
    expect((await target.run()).result.claimVerificationResult?.passed).toBe(false);
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('requires the original authorization selection for the captured query view', async () => {
    const target = fixture({providerQuery: {text: 'question', analysisContextFingerprint: 'old-selection'}});
    target.owner.analysisContextFingerprint = 'new-selection';
    await expect(target.run()).rejects.toThrow('finalization_authorization_fingerprint_mismatch');
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'authorization', 'superseded'] as const)('does not return a result after %s during semantic review', async reason => {
    const target = fixture();
    target.dispatch.mockImplementation(async () => {
      if (reason === 'cancel') target.controller.abort();
      if (reason === 'authorization') target.owner.assertAuthorized = () => {throw new Error('authorization changed');};
      if (reason === 'superseded') target.owner.isCurrent = () => false;
      return {status: 'unavailable', reason: 'provider_error'};
    });
    await expect(target.run()).rejects.toThrow();
    expect(() => target.context.hasSemanticTransport).toThrow();
  });

  it('cannot obtain current completion or intent from serialized result fields without a private context', async () => {
    const target = fixture();
    target.context.dispose();
    const {result} = await finalizeAnalysisResult({result: {...target.result,
      completion: {schemaVersion: 1, runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
        conclusionFingerprint: analysisDeliveryFingerprint(target.result.conclusion), runtimeKind: 'openai-agents-sdk', status: 'completed'}},
      owner: target.owner, query: 'value'});
    expect(result.deliveryAssurance?.completion).toBe('not_checked');
    expect(result.completion).toBeUndefined();
    expect(result.partial).toBe(true);
    expect(target.dispatch).not.toHaveBeenCalled();
  });

  it('checks the owner identity before invoking any finalization capability', async () => {
    const target = fixture();
    target.owner.runId = 'other-run';
    await expect(target.run()).rejects.toThrow('finalization_run_identity_mismatch');
    expect(target.dispatch).not.toHaveBeenCalled();
    expect(() => target.context.runId).toThrow();
  });
});
