// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';

import {
  normalizeSessionStateSnapshot,
  type SessionStateSnapshot,
} from '../../agentv3/sessionStateSnapshot';
import {
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  sanitizeSourceReference,
} from '../codebase/sourceUseDecision';
import {
  copyAnalysisResultForSnapshot,
  projectPrivateAnalysisResult,
  projectPrivateSessionStateSnapshot,
} from '../security/privateAnalysisProjection';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {clearCodeAwareOutputGuards, registerCodeAwareCanary} from '../security/codeAwareOutputRegistry';

function deliveredResult(): AnalysisResult {
  const conclusion = 'A current trace fact has a complete explanation without report headings.';
  const candidate = {candidateRef: 'candidate-1', runId: 'run-1', attemptId: 'attempt-1',
    conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
  const turnIntent: NonNullable<AnalysisResult['turnIntent']> = {
    schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'fact',
    sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
    deliverable: 'answer', evidenceAccess: 'existing_only', registryFingerprint: 'registry-1',
  };
  return {
    sessionId: 'session-delivery', success: true, findings: [], hypotheses: [], conclusion,
    confidence: 0.6, rounds: 1, totalDurationMs: 12, turnIntent,
    completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'},
    outputOrigin: 'sdk_final',
    runtimeAppendix: {schemaVersion: 1, origin: 'runtime_fallback', sourceCandidate: candidate, text: 'Separate runtime appendix.'},
    reportAssessment: {schemaVersion: 1, status: 'checked', binding: {
      ...candidate, conclusionContractFingerprint: analysisDeliveryFingerprint(undefined),
      evidenceFingerprint: analysisDeliveryFingerprint([]), requirementsFingerprint: analysisDeliveryFingerprint([]),
      registryFingerprint: 'registry-1', intentFingerprint: analysisDeliveryFingerprint(turnIntent),
    }, requirements: [{requirementId: 'requirement-1', applicability: 'applicable', coverage: 'covered',
      contentLocations: [{start: 0, end: conclusion.length}]}]},
    deliveryAssurance: {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
      claims: 'passed', source: 'passed', identity: 'passed', report: 'passed'},
    analysisReceipt: {schemaVersion: 1, runId: 'run-1', sessionId: 'session-delivery', traceId: 'trace-1',
      mode: 'fast', resolvedMode: 'quick', providerId: null, generatedAt: 1,
      traceEvidence: {sqlCount: 1, skillCount: 0, dataEnvelopeCount: 1, artifactCount: 0, evidenceRefCount: 1},
      nonEvidenceContext: {frontendPrequeryCount: 0, memoryHintCount: 0, conversationContextCount: 0, strategyHintCount: 0},
      claimAudit: {totalClaims: 1, verifiedClaims: 1, unsupportedClaims: 0, uncertainClaims: 0},
      qualityGates: {finalReportContract: 'passed', claimVerification: 'passed', identityResolution: 'passed'}, outputs: {}},
    claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'passed', policy: 'record_only', passed: true,
      checkedClaimCount: 1, unsupportedClaimCount: 0, issues: [], claimResults: [{claimId: 'claim-1', status: 'verified',
        referenceCells: [{evidenceRefId: 'evidence-1', status: 'matched'}],
        deterministicProof: {kind: 'numeric_cell', status: 'proved', reason: 'numeric_match', anchorIds: ['anchor-1'], evidenceRefIds: ['evidence-1']},
        propositionCoverage: {status: 'complete', covered: ['metric'], uncovered: [], reason: 'numeric_match'},
      }]},
  };
}

describe('final delivery private projection', () => {
  it.each(['claimAudit', 'traceEvidence', 'nonEvidenceContext', 'outputs'] as const)(
    'drops an incomplete historical receipt missing %s without changing its answer', field => {
      const result = deliveredResult();
      delete (result.analysisReceipt as unknown as Record<string, unknown>)[field];
      const before = structuredClone(result);
      for (const projected of [copyAnalysisResultForSnapshot(result),
        projectPrivateAnalysisResult(result.sessionId, result, 'en')]) {
        expect(projected.analysisReceipt).toBeUndefined();
        expect(projected.conclusion).toBe(result.conclusion);
      }
      expect(result).toEqual(before);
    },
  );
  it('retains bound positive metadata when the safe body and assessment inputs are unchanged', () => {
    const result = deliveredResult();
    const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
    expect(projected.conclusion).toBe(result.conclusion);
    expect(projected.completion).toEqual(result.completion);
    expect(projected.reportAssessment).toEqual(result.reportAssessment);
    expect(projected.claimVerificationResult).toEqual(result.claimVerificationResult);
    expect(projected.deliveryAssurance).toEqual(result.deliveryAssurance);
    expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
  });

  it('projects registered claim IDs and text while invalidating positive proof without mutating its input', () => {
    const result = {...deliveredResult(), sessionId: 'private-claim-id-projection'};
    const canary = 'PRIVATE_CLAIM_ID_CANARY';
    result.claimSupport = [{claimId: canary, kind: 'numeric', text: canary, anchors: [{
      anchorId: `anchor-${canary}`, version: 'evidence_contract@1', evidenceRefId: 'evidence-1',
      context: {traceId: 'trace-1', traceSide: 'current', producerKind: 'execute_sql'},
      cells: [{column: 'value', rowIndex: 0, value: 1, actualValue: 1, displayValue: canary}],
    }], supportLevel: 'verified'},
      {claimId: 'safe-claim', kind: 'numeric', text: 'Safe public claim', anchors: [], supportLevel: 'partial'}];
    result.claimVerificationResult!.claimResults[0].claimId = canary;
    const before = structuredClone(result);
    registerCodeAwareCanary(result.sessionId, canary);
    try {
      const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
      expect(projected.claimSupport).toEqual([
        expect.objectContaining({claimId: '[REDACTED_CODE_ECHO]', text: '[REDACTED_CODE_ECHO]',
          supportLevel: 'partial', bindingEligibility: 'ineligible', anchors: [expect.objectContaining({
            anchorId: 'anchor-[REDACTED_CODE_ECHO]', evidenceRefId: 'evidence-1',
            cells: [{column: 'value', rowIndex: 0, value: 1, actualValue: 1, displayValue: '[REDACTED_CODE_ECHO]'}],
          })]}),
        expect.objectContaining({claimId: 'safe-claim', text: 'Safe public claim', supportLevel: 'partial'}),
      ]);
      expect(projected.claimVerificationResult).toMatchObject({schemaVersion: 'claim_verifier@2',
        status: 'not_checked', passed: false, checkedClaimCount: 0, claimResults: [{
          claimId: '[REDACTED_CODE_ECHO]', status: 'not_checked',
          referenceCells: [{status: 'not_checked'}], deterministicProof: {status: 'not_checked'},
          propositionCoverage: {status: 'none', covered: []},
        }]});
      expect(projected.deliveryAssurance?.claims).toBe('not_checked');
      expect(projected.conclusion).toBe(result.conclusion);
      expect(JSON.stringify(projected)).not.toContain(canary);
      expect(result).toEqual(before);
      expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
    } finally { clearCodeAwareOutputGuards(result.sessionId); }
  });

  it('drops malformed historical verification and identity metadata instead of inventing valid receipts', () => {
    const result = {...deliveredResult(), sessionId: 'private-malformed-projection'};
    result.claimVerificationResult = {status: 'PRIVATE_VERIFY_CANARY'} as any;
    result.identityResolutions = [{identityRefId: 'PRIVATE_IDENTITY_CANARY'}] as any;
    const before = structuredClone(result);
    const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
    expect(projected.claimVerificationResult).toBeUndefined();
    expect(projected.identityResolutions).toEqual([]);
    expect(projected.deliveryAssurance).toMatchObject({claims: 'not_checked', identity: 'not_checked'});
    expect(projected.success).toBe(result.success);
    expect(projected.conclusion).toBe(result.conclusion);
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE_[A-Z_]+_CANARY/);
    expect(result).toEqual(before);
    expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
  });

  it('copies exact public body and safe metadata without serializing runtime or parser context', () => {
    const result = deliveredResult();
    const copied = copyAnalysisResultForSnapshot({...result, privateContext: {rawBody: 'PRIVATE_RAW', dispatch: () => undefined}} as AnalysisResult);
    expect(copied.conclusion).toBe(result.conclusion);
    expect(copied.completion).toEqual(result.completion);
    expect(copied.runtimeAppendix?.text).toBe('Separate runtime appendix.');
    expect(JSON.stringify(copied)).not.toContain('PRIVATE_RAW');
    expect(copied).not.toHaveProperty('privateContext');
  });

  it('invalidates all positive claim layers after redaction and remains stable on replay', () => {
    const result = deliveredResult();
    registerCodeAwareCanary(result.sessionId, 'current trace fact');
    try {
      const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
      expect(projected.conclusion).not.toContain('current trace fact');
      expect(projected.completion).toMatchObject({status: 'unknown', conclusionFingerprint: ''});
      expect(projected.deliveryAssurance).toMatchObject({completion: 'not_checked', claims: 'not_checked', source: 'not_checked', report: 'not_checked'});
      expect(projected.claimVerificationResult).toMatchObject({status: 'not_checked', passed: false, checkedClaimCount: 0,
        claimResults: [{status: 'not_checked', referenceCells: [{status: 'not_checked'}],
          deterministicProof: {status: 'not_checked'}, propositionCoverage: {status: 'none', covered: []}}]});
      expect(projected.reportAssessment).toMatchObject({status: 'coverage_incomplete',
        binding: {conclusionFingerprint: ''}, requirements: [{coverage: 'unknown'}]});
      expect(projected.reportAssessment?.requirements[0]).not.toHaveProperty('contentLocations');
      expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
    } finally { clearCodeAwareOutputGuards(result.sessionId); }
  });

  it.each(['claim_verifier@1', 'claim_verifier@2'] as const)('keeps machine failures for %s when control words are private canaries', schemaVersion => {
    const result = deliveredResult();
    result.completion = {...result.completion!, status: 'failed', reason: 'provider_error', sdkFinishReason: 'PRIVATE_SDK'};
    result.deliveryAssurance = {...result.deliveryAssurance!, completion: 'failed', claims: 'failed', source: 'failed', report: 'failed'};
    result.claimVerificationResult = {...result.claimVerificationResult!, schemaVersion, status: 'failed', passed: false,
      unsupportedClaimCount: 1, claimResults: [{claimId: 'claim-1', status: 'unsupported',
        referenceCells: [{status: 'value_mismatch'}], deterministicProof: {kind: 'numeric_cell', status: 'rejected', reason: 'PRIVATE_REASON', anchorIds: [], evidenceRefIds: []},
        propositionCoverage: {status: 'none', covered: [], uncovered: [], reason: 'PRIVATE_REASON'}}],
      issues: [{claimId: 'claim-1', severity: 'error', code: 'mismatch', message: 'PRIVATE_REASON'}]};
    result.sourceClaimVerificationResult = {schemaVersion: 'source_claim_verifier@1', status: 'failed', bindings: [],
      issues: [{severity: 'error', code: 'source_claim_missing', message: 'PRIVATE_REASON'}]};
    ['failed', 'unsupported', 'rejected', 'error', 'value_mismatch', 'PRIVATE_REASON'].forEach(value => registerCodeAwareCanary(result.sessionId, value));
    try {
      const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
      expect(projected.completion).toMatchObject({status: 'failed', reason: 'provider_error'});
      expect(projected.completion).not.toHaveProperty('sdkFinishReason');
      expect(projected.claimVerificationResult).toMatchObject({schemaVersion, status: 'failed', passed: false, unsupportedClaimCount: 1,
        claimResults: [{status: 'unsupported', referenceCells: [{status: 'value_mismatch'}], deterministicProof: {status: 'rejected'}}],
        issues: [{severity: 'error'}]});
      expect(projected.sourceClaimVerificationResult).toMatchObject({status: 'failed', issues: [{severity: 'error'}]});
      expect(projected.deliveryAssurance).toMatchObject({completion: 'failed', claims: 'failed', source: 'failed', report: 'failed'});
      expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    } finally { clearCodeAwareOutputGuards(result.sessionId); }
  });

  it.each([false, true])('invalidates partial support while preserving mixed failure=%s on replay', mixedFailure => {
    const result = deliveredResult();
    const partialClaim = {...result.claimVerificationResult!.claimResults[0], status: 'partial' as const,
      propositionCoverage: {status: 'partial' as const, covered: ['metric'], uncovered: ['mechanism'], reason: 'partial_proposition'}};
    result.claimVerificationResult = {...result.claimVerificationResult!, status: mixedFailure ? 'failed' : 'partial', passed: false,
      checkedClaimCount: mixedFailure ? 2 : 1, unsupportedClaimCount: mixedFailure ? 1 : 0,
      claimResults: [partialClaim, ...(mixedFailure ? [{...partialClaim, claimId: 'claim-failed', status: 'unsupported' as const,
        deterministicProof: {...partialClaim.deterministicProof!, status: 'rejected' as const}}] : [])]};
    registerCodeAwareCanary(result.sessionId, 'current trace fact');
    try {
      const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
      expect(projected.claimVerificationResult).toMatchObject({status: mixedFailure ? 'failed' : 'not_checked', passed: false,
        checkedClaimCount: mixedFailure ? 1 : 0, unsupportedClaimCount: mixedFailure ? 1 : 0});
      expect(projected.claimVerificationResult?.claimResults[0]).toMatchObject({status: 'not_checked',
        propositionCoverage: {status: 'none', covered: []}});
      if (mixedFailure) expect(projected.claimVerificationResult?.claimResults[1]).toMatchObject({status: 'unsupported', deterministicProof: {status: 'rejected'}});
      expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
    } finally { clearCodeAwareOutputGuards(result.sessionId); }
  });

  it('does not issue missing historical metadata, and invalidates report intent binding when dropping diagnostics', () => {
    const current = deliveredResult();
    current.turnIntent = {...current.turnIntent!, reason: 'PRIVATE_REASON', actualModel: 'PRIVATE_MODEL'};
    current.reportAssessment!.binding.intentFingerprint = analysisDeliveryFingerprint(current.turnIntent);
    const projected = projectPrivateAnalysisResult(current.sessionId, current, 'en');
    expect(projected.turnIntent).not.toHaveProperty('reason');
    expect(projected.reportAssessment).toMatchObject({status: 'coverage_incomplete', binding: {intentFingerprint: ''}});
    expect(projected.deliveryAssurance?.report).toBe('not_checked');
    const {turnIntent: _intent, completion: _completion, outputOrigin: _origin, runtimeAppendix: _appendix,
      reportAssessment: _assessment, deliveryAssurance: _assurance, ...historical} = current;
    const restored = projectPrivateAnalysisResult(current.sessionId, historical, 'en');
    expect(restored).not.toHaveProperty('completion');
    expect(restored).not.toHaveProperty('deliveryAssurance');
    expect(restored).not.toHaveProperty('turnIntent');
  });

  it('invalidates report coverage when its copied claim IDs change, and tolerates malformed nested entries', () => {
    const result = deliveredResult();
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], claims: [{id: 'claim/1', text: result.conclusion, references: []}],
      uncertainties: [], nextSteps: []};
    result.reportAssessment!.binding.conclusionContractFingerprint = analysisDeliveryFingerprint(result.conclusionContract);
    result.reportAssessment!.requirements = [{requirementId: 'requirement-1', applicability: 'applicable', coverage: 'covered', claimIds: ['claim/1']}];
    const publicCopy = copyAnalysisResultForSnapshot(result);
    expect(publicCopy.conclusion).toBe(result.conclusion);
    expect(publicCopy.conclusionContract).toBe(result.conclusionContract);
    expect(publicCopy.claimVerificationResult).toBe(result.claimVerificationResult);
    expect(publicCopy.reportAssessment?.status).toBe('coverage_incomplete');
    expect(publicCopy.deliveryAssurance?.report).toBe('not_checked');
    expect(publicCopy.analysisReceipt?.qualityGates).toMatchObject({finalReportContract: 'partial', claimVerification: 'passed'});
    expect(publicCopy.analysisReceipt?.claimAudit).toEqual(result.analysisReceipt?.claimAudit);
    const legacyCopy = copyAnalysisResultForSnapshot({...result,
      deliveryAssurance: {...result.deliveryAssurance!, entry: 'historical_restore'}});
    expect(legacyCopy.analysisReceipt?.qualityGates.finalReportContract).toBe('partial');
    expect(legacyCopy.analysisReceipt?.claimAudit).toEqual(result.analysisReceipt?.claimAudit);
    const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
    expect(projected.reportAssessment).toMatchObject({status: 'coverage_incomplete', requirements: [{coverage: 'unknown'}]});
    expect(projected.deliveryAssurance?.report).toBe('not_checked');
    result.reportAssessment!.requirements = [null, {requirementId: 'requirement-2', applicability: 'applicable', coverage: 'covered',
      claimIds: [null, {}], contentLocations: [null, {}, 'bad', {start: 0, end: 3}]}] as any;
    const malformed = projectPrivateAnalysisResult(result.sessionId, result, 'en');
    expect(malformed.reportAssessment?.status).toBe('coverage_incomplete');
    expect(malformed.deliveryAssurance?.report).toBe('not_checked');
    expect(projectPrivateAnalysisResult(result.sessionId, malformed, 'en')).toEqual(malformed);
  });

  it('invalidates source proof when only its reference metadata changes', () => {
    const result = deliveredResult();
    const reference = sanitizeSourceReference({referenceId: 'source-1', codebaseId: 'app-a', filePath: 'src/A.kt', lookupKind: 'body'})!;
    result.sourceUseDecision = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send', selectedCodebaseIds: ['app-a'],
      status: 'corroborated', attemptedTools: ['read_codebase_file'], queriedCodebaseIds: ['app-a'], usedCodebaseIds: ['app-a'], references: [reference]};
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'claim-1', text: result.conclusion, references: []}], uncertainties: [], nextSteps: [],
      sourceUseDecision: result.sourceUseDecision, sourceReferences: [reference],
      sourceClaimBindings: [{claimId: 'claim-1', mechanismStatus: 'corroborated', sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['evidence-1']}]};
    result.reportAssessment!.binding.conclusionContractFingerprint = analysisDeliveryFingerprint(result.conclusionContract);
    result.sourceClaimVerificationResult = {schemaVersion: 'source_claim_verifier@1', status: 'passed', issues: [],
      bindings: [{claimId: 'claim-1', mechanismStatus: 'corroborated', sourceReferenceIds: [reference.id],
        traceEvidenceRefIds: ['evidence-1'], reason: 'PRIVATE_BINDING_DIAGNOSTIC'}]};
    const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
    expect(projected.conclusion).toBe(result.conclusion);
    expect(projected.claimVerificationResult).toEqual(result.claimVerificationResult);
    expect(projected.sourceClaimVerificationResult).toMatchObject({status: 'not_checked', bindings: [{mechanismStatus: 'unverified'}]});
    expect(projected.conclusionContract?.sourceClaimBindings?.[0].mechanismStatus).toBe('unverified');
    expect(projected.deliveryAssurance?.source).toBe('not_checked');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_BINDING_DIAGNOSTIC');
    expect(projectPrivateAnalysisResult(result.sessionId, projected, 'en')).toEqual(projected);
  });

  it('copies legacy source fields safely while invalidating old proofs without changing the public body', () => {
    const result = deliveredResult();
    result.deliveryAssurance = {...result.deliveryAssurance!, entry: 'historical_restore'};
    const reference = sanitizeSourceReference({referenceId: 'source-1', codebaseId: 'app-a', filePath: 'src/A.kt', lookupKind: 'body'})!;
    const decision = {schemaVersion: 'source_use_decision@1' as const, codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['app-a'], status: 'corroborated' as const, attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['app-a'], usedCodebaseIds: ['app-a'], references: [{...reference, snippet: 'RAW_SOURCE_CANARY'}]};
    result.sourceUseDecision = {...decision, rootPath: '/private/RAW_ROOT_CANARY'} as any;
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'claim-1', text: result.conclusion, references: []}], uncertainties: [], nextSteps: [],
      sourceUseDecision: result.sourceUseDecision, sourceReferences: decision.references,
      sourceClaimBindings: [{claimId: 'claim-1', mechanismStatus: 'corroborated', sourceReferenceIds: [reference.id], traceEvidenceRefIds: ['evidence-1'], reason: 'RAW_REASON_CANARY'}]};
    result.sourceClaimVerificationResult = {schemaVersion: 'source_claim_verifier@1', status: 'passed', issues: [], bindings: result.conclusionContract.sourceClaimBindings!};
    result.reportAssessment!.binding.conclusionContractFingerprint = analysisDeliveryFingerprint(result.conclusionContract);
    const stored = copyAnalysisResultForSnapshot(result);
    expect(stored.conclusion).toBe(result.conclusion);
    expect(stored.completion).toEqual(result.completion);
    expect(stored.claimVerificationResult).toMatchObject({status: 'not_checked', passed: false});
    expect(stored.sourceClaimVerificationResult).toMatchObject({status: 'not_checked', bindings: [{mechanismStatus: 'unverified'}]});
    expect(stored.deliveryAssurance).toMatchObject({claims: 'not_checked', source: 'not_checked', report: 'not_checked'});
    expect(JSON.stringify(stored)).not.toMatch(/RAW_(?:SOURCE|ROOT|REASON)_CANARY/);
    expect(copyAnalysisResultForSnapshot(stored)).toEqual(stored);
  });

  it('removes private source metadata from every result and session copy while keeping machine failures', () => {
    const result = deliveredResult();
    const canary = 'PRIVATE_SOURCE_METADATA_CANARY';
    const safeReference = sanitizeSourceReference({referenceId: 'lookup-safe', codebaseId: 'app-safe', filePath: 'src/Safe.kt', lookupKind: 'body'})!;
    const unsafeReference = sanitizeSourceReference({referenceId: `lookup-${canary}`, codebaseId: `app-${canary}`,
      filePath: `src/${canary}.kt`, sourceGeneration: `generation-${canary}`, lookupKind: 'body'})!;
    result.sourceUseDecision = {schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['app-safe', `app-${canary}`], status: 'search_incomplete', reasonCode: 'search_incomplete',
      queriedCodebaseIds: ['app-safe', `app-${canary}`], usedCodebaseIds: ['app-safe', `app-${canary}`],
      attemptedTools: ['read_codebase_file', `tool-${canary}`], coverageComplete: false, references: [safeReference, unsafeReference]};
    result.sourceReferences = [safeReference, unsafeReference];
    result.sourceClaimVerificationResult = {schemaVersion: 'source_claim_verifier@1', status: 'failed', bindings: [], issues: []};
    result.conclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], claims: [], uncertainties: [], nextSteps: [],
      sourceUseDecision: result.sourceUseDecision, sourceReferences: result.sourceReferences, sourceClaimBindings: []};
    registerCodeAwareCanary(result.sessionId, canary);
    ['provider_send', 'search_incomplete', 'body'].forEach(control => registerCodeAwareCanary(result.sessionId, control));
    try {
      const projected = projectPrivateAnalysisResult(result.sessionId, result, 'en');
      expect(projected.sourceUseDecision).toMatchObject({codeAwareMode: 'provider_send', status: 'search_incomplete', reasonCode: 'search_incomplete',
        selectedCodebaseIds: ['app-safe'], queriedCodebaseIds: ['app-safe'], usedCodebaseIds: ['app-safe'], attemptedTools: ['read_codebase_file'], references: [safeReference]});
      expect(projected.conclusionContract?.sourceUseDecision).toEqual(projected.sourceUseDecision);
      expect(projected.sourceReferences).toEqual([safeReference]);
      expect(projected.sourceClaimVerificationResult?.status).toBe('failed');
      expect(JSON.stringify(projected)).not.toContain(canary);
      const state = {...snapshot(), sessionId: result.sessionId, finalResult: result,
        sourceUseDecision: result.sourceUseDecision, codebaseIds: ['app-safe', `app-${canary}`],
        codebaseSnapshot: [{codebaseId: 'app-safe', indexGeneration: 1}, {codebaseId: `app-${canary}`, indexGeneration: 1}],
        codeLookupSummary: {lookupCount: 2, patchCount: 0, referencedCodebaseIds: ['app-safe', `app-${canary}`],
          usedCodebaseIds: ['app-safe', `app-${canary}`], sourceUseDecision: result.sourceUseDecision}};
      const stored = projectPrivateSessionStateSnapshot(state);
      expect(stored.sourceUseDecision).toEqual(projected.sourceUseDecision);
      expect(stored.codeLookupSummary?.sourceUseDecision).toEqual(projected.sourceUseDecision);
      expect(stored.finalResult?.sourceClaimVerificationResult?.status).toBe('failed');
      expect(stored.codebaseIds).toEqual(['app-safe']);
      expect(JSON.stringify(stored)).not.toContain(canary);
      expect(projectPrivateSessionStateSnapshot(stored)).toEqual(stored);
      const legacyDecision = {...result.sourceUseDecision, status: 'corroborated' as const, reasonCode: undefined, coverageComplete: true};
      const legacy = projectPrivateSessionStateSnapshot({...state, finalResult: undefined,
        sourceUseDecision: legacyDecision, codeLookupSummary: {...state.codeLookupSummary, sourceUseDecision: legacyDecision}});
      expect(legacy.sourceUseDecision?.coverageComplete).toBe(false);
      expect(legacy.codeLookupSummary?.sourceUseDecision?.coverageComplete).toBe(false);
      expect(legacy).not.toHaveProperty('finalResult');
      expect(JSON.stringify(legacy)).not.toContain(canary);
      expect(projectPrivateSessionStateSnapshot(legacy)).toEqual(legacy);
    } finally { clearCodeAwareOutputGuards(result.sessionId); }
  });

  it('keeps the projected current result in a non-resumable snapshot without stale quality sidecars', () => {
    const current = {...deliveredResult(), sessionId: 'session-private'};
    const state = {...snapshot(), finalResult: current,
      claimVerificationResult: {...current.claimVerificationResult!, schemaVersion: 'claim_verifier@1' as const}};
    const projected = projectPrivateSessionStateSnapshot(state);
    expect(projected.finalResult?.conclusion).toBe(current.conclusion);
    expect(projected.finalResult?.completion?.candidateRef).toBe('candidate-1');
    expect(projected.claimVerificationResult).toEqual(projected.finalResult?.claimVerificationResult);
    expect(projected.claimVerificationResult?.schemaVersion).toBe('claim_verifier@2');
    expect(projected.sourceUseDecision).toBeUndefined();
    expect(projected.conclusionHistory).toEqual([]);
    expect(projected.agentResponses).toEqual([]);
  });
});

function snapshot(): SessionStateSnapshot {
  const sourceReference = {
    referenceId: 'source-safe',
    codebaseId: 'codebase-a',
    filePath: 'src/MainActivity.kt',
    lineRange: {start: 10, end: 12},
    lookupKind: 'body',
    query: 'PRIVATE_REFERENCE_QUERY_CANARY',
    snippet: 'PRIVATE_REFERENCE_SNIPPET_CANARY',
    rootPath: '/PRIVATE_REFERENCE_ROOT_CANARY',
  } as any;
  const sourceUseDecision = {
    schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
    codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['codebase-a', '/Users/chris/Code/App'],
    status: 'search_incomplete',
    reasonCode: 'search_incomplete',
    attemptedTools: ['search_codebase'],
    queriedCodebaseIds: ['codebase-a'],
    usedCodebaseIds: ['codebase-a'],
    coverageComplete: false,
    incompleteReasons: ['backend_degraded'],
    references: [sourceReference, {
      referenceId: 'unsafe-absolute',
      codebaseId: 'codebase-a',
      filePath: '/PRIVATE_ABSOLUTE_ROOT_CANARY/Secret.kt',
      lookupKind: 'body',
    }],
    rawQuery: 'PRIVATE_DECISION_QUERY_CANARY',
  } as any;
  return {
    version: 1,
    snapshotTimestamp: 1,
    sessionId: 'session-private',
    traceId: 'trace-private',
    conversationSteps: [{
      eventId: 'event-1',
      ordinal: 1,
      phase: 'tool',
      role: 'agent',
      text: 'PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS',
      timestamp: 1,
    }],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    analysisNotes: [],
    analysisPlan: null,
    planHistory: [],
    uncertaintyFlags: [],
    codebaseIds: ['codebase-a', '/Users/chris/Code/App'],
    knowledgeSourceIds: ['knowledge-a', '../knowledge-root'],
    traceSummary: {
      schemaVersion: 'trace_summary_attribution@1', status: 'ready',
      specId: 'smartperfetto.core.v1', specDigestSha256: 'a'.repeat(64),
      traceFingerprintSha256: 'b'.repeat(64),
      traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64), localPath: '/private/tp'},
      resultDigestSha256: 'd'.repeat(64),
      availableMetricIds: ['metric_a'], missingMetricIds: [],
      localPath: '/private/trace',
    } as any,
    codeLookupSummary: {
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a', 'bad path'],
      usedCodebaseIds: ['codebase-a', '/Users/chris/Code/App'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
      sourceUseDecision,
    },
    sourceUseDecision,
    codebaseSnapshot: [{
      codebaseId: 'codebase-a',
      displayName: 'App Source',
      kind: 'app_source',
      indexGeneration: 7,
      activeGeneration: 'codebase_7',
      rootPath: '/Users/chris/Code/App',
      rootRealpath: '/private/var/App',
    } as any, {
      codebaseId: 'bad path',
      displayName: '/Users/chris/Code/Secret',
      kind: 'not-a-kind',
      indexGeneration: 8,
    } as any],
    runSequence: 1,
    conversationOrdinal: 1,
  };
}

describe('private session snapshot provenance', () => {
  it('preserves the quality-specific termination reason', () => {
    const projected = projectPrivateAnalysisResult('session-private', {
      sessionId: 'session-private',
      success: true,
      findings: [],
      hypotheses: [],
      conclusion: '结果未通过最终质量核验。',
      confidence: 0.55,
      rounds: 1,
      totalDurationMs: 1,
      partial: true,
      terminationReason: 'quality_gate_failed',
    }, 'zh-CN');

    expect(projected.terminationReason).toBe('quality_gate_failed');
  });

  it('keeps bounded source generation provenance without private content', () => {
    const projected = projectPrivateSessionStateSnapshot(snapshot());
    const safeReference = sanitizeSourceReference({
      referenceId: 'source-safe',
      codebaseId: 'codebase-a',
      filePath: 'src/MainActivity.kt',
      lineRange: {start: 10, end: 12},
      lookupKind: 'body',
    });

    expect(projected.codeLookupSummary).toEqual({
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
      sourceUseDecision: {
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['codebase-a'],
        status: 'search_incomplete',
        reasonCode: 'search_incomplete',
        attemptedTools: ['search_codebase'],
        queriedCodebaseIds: ['codebase-a'],
        usedCodebaseIds: ['codebase-a'],
        coverageComplete: false,
        incompleteReasons: ['backend_degraded'],
        references: [safeReference],
      },
    });
    expect(projected.sourceUseDecision).toEqual(projected.codeLookupSummary?.sourceUseDecision);
    expect(projected.codebaseSnapshot).toEqual([{
      codebaseId: 'codebase-a',
      displayName: 'App Source',
      kind: 'app_source',
      indexGeneration: 7,
      activeGeneration: 'codebase_7',
    }]);
    expect(projected.codebaseIds).toEqual(['codebase-a']);
    expect(projected.knowledgeSourceIds).toEqual(['knowledge-a']);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS');
    expect(JSON.stringify(projected)).not.toContain('/Users/chris/Code/App');
    expect(JSON.stringify(projected)).not.toContain('/private/var/App');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projected.conversationSteps).toEqual([]);
    expect(projected.traceSummary).toEqual(expect.objectContaining({
      status: 'ready', resultDigestSha256: 'd'.repeat(64),
    }));
    expect(JSON.stringify(projected.traceSummary)).not.toContain('/private/');
  });

  it('migrates a summary-only source decision into the additive snapshot field', () => {
    const legacy = snapshot();
    delete legacy.sourceUseDecision;

    const normalized = normalizeSessionStateSnapshot(legacy);

    expect(normalized.sourceUseDecision).toEqual(
      normalized.codeLookupSummary?.sourceUseDecision,
    );
    expect(normalized.sourceUseDecision).toEqual(expect.objectContaining({
      schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      selectedCodebaseIds: ['codebase-a'],
      status: 'search_incomplete',
    }));
    expect(JSON.stringify(normalized.sourceUseDecision)).not.toContain('PRIVATE_');
  });

  it('partitions normalized decisions by the actual session codebase selection', () => {
    const input = snapshot();
    const decision = {
      ...input.sourceUseDecision!,
      selectedCodebaseIds: ['codebase-a', 'codebase-outside'],
      queriedCodebaseIds: ['codebase-a', 'codebase-outside'],
      usedCodebaseIds: ['codebase-a', 'codebase-outside'],
      references: [
        ...input.sourceUseDecision!.references,
        {
          referenceId: 'outside-ref',
          codebaseId: 'codebase-outside',
          filePath: 'src/Outside.kt',
          lookupKind: 'body',
        },
      ],
    };
    input.sourceUseDecision = decision as any;
    input.codeLookupSummary!.sourceUseDecision = decision as any;

    const normalized = normalizeSessionStateSnapshot(input);

    expect(normalized.sourceUseDecision?.selectedCodebaseIds).toEqual(['codebase-a']);
    expect(normalized.sourceUseDecision?.queriedCodebaseIds).toEqual(['codebase-a']);
    expect(normalized.sourceUseDecision?.usedCodebaseIds).toEqual(['codebase-a']);
    expect(normalized.sourceUseDecision?.references).toEqual([
      expect.objectContaining({codebaseId: 'codebase-a'}),
    ]);
    expect(normalized.codeLookupSummary?.sourceUseDecision)
      .toEqual(normalized.sourceUseDecision);
  });

  it('projects one authoritative decision across top-level and summary fields', () => {
    const input = snapshot();
    input.sourceUseDecision = {
      ...input.sourceUseDecision!,
      selectedCodebaseIds: ['codebase-a', 'codebase-outside'],
      queriedCodebaseIds: ['codebase-a', 'codebase-outside'],
      usedCodebaseIds: ['codebase-a', 'codebase-outside'],
      status: 'located',
      reasonCode: undefined,
      references: [{
        referenceId: 'outside-ref',
        codebaseId: 'codebase-outside',
        filePath: 'src/Outside.kt',
        lookupKind: 'body',
      }],
    } as any;
    input.codeLookupSummary!.sourceUseDecision = {
      ...input.codeLookupSummary!.sourceUseDecision!,
      status: 'search_incomplete',
      reasonCode: 'search_incomplete',
    };

    const projected = projectPrivateSessionStateSnapshot(input);

    expect(projected.sourceUseDecision).toEqual(expect.objectContaining({
      selectedCodebaseIds: ['codebase-a'],
      queriedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      status: 'located',
      references: [],
    }));
    expect(projected.sourceUseDecision).not.toHaveProperty('reasonCode');
    expect(projected.codeLookupSummary?.sourceUseDecision)
      .toEqual(projected.sourceUseDecision);
  });
});
