// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection} from '../canonicalAnalysisResult';
import {assessFinalResultQualityAssessment} from '../finalResultQualityGate';
import {runClaimVerification} from '../verifier/claimVerificationRunner';
import {createDataEnvelope} from '../../types/dataContract';

function declaration(value = 999): ConclusionContract {
  return {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [],
    evidenceChain: [], uncertainties: [], nextSteps: [], claims: [{id: 'measured-duration', kind: 'numeric',
      text: `Measured duration is ${value} ms.`, references: [{evidenceRefId: 'data:duration', rowIndex: 0,
        column: 'dur_ms', value}]}]};
}

function result(conclusion: string): AnalysisResult {
  return {sessionId: 'canonical-session', success: true, findings: [], hypotheses: [], conclusion,
    confidence: 0.8, rounds: 1, totalDurationMs: 10};
}

function contextFor(source: AnalysisResult, status: AnalysisCompletion['status'] = 'completed'):
  Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
  const acceptedCandidate = {candidateRef: 'native-a', runId: 'run-a', attemptId: 'attempt-a',
    conclusionFingerprint: analysisDeliveryFingerprint(source.conclusion)};
  return {entry: 'new_finalization', acceptedCandidate, outputOrigin: 'sdk_final',
    completion: {...acceptedCandidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status},
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'registry-a',
      taskKind: 'fact', sceneId: 'general', scope: 'bounded_question', recommendedComplexity: 'quick',
      deliverable: 'answer', evidenceAccess: 'read_new'}};
}

const control = '<!-- smartperfetto:conversation-control {"kind":"needs_user_input","question":"Which trace?"} -->';

describe('canonical analysis result projection', () => {
  it.each(['sidecar_first', 'control_first'] as const)('preserves exact narrative for %s', order => {
    const sidecar = renderConclusionContractSidecar(declaration());
    const blocks = order === 'sidecar_first' ? `${sidecar}\r\n${control}` : `${control}\r\n${sidecar}`;
    const source = result(` \r\nConnection error is trace content.  \r\n${blocks}\r\n \t`);
    const context = contextFor(source);
    const canonical = canonicalizeAnalysisResult(source, {context, conversation: {fallbackQuestion: 'Never the body'}});
    expect(canonical.result.conclusion).toBe(' \r\nConnection error is trace content.  \r\n\r\n\r\n \t');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?',
      message: canonical.result.conclusion});
    expect(canonical.result.conclusionContract?.claims).toEqual(declaration().claims);
    expect(canonical.projection.disposition).toBe('protocol_projection');
    expect(canonical.result.completion?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(canonical.result.conclusion));
    expect(canonical.result.completion?.status).toBe('completed');
    expect(source.conclusion).toContain(sidecar);
    expect(JSON.stringify(canonical.result)).not.toContain(canonical.projection.inputFingerprint);
    expect(canonical.result).not.toHaveProperty('projection');
    expect(canonical.result).not.toHaveProperty('protocolDiagnostics');
  });

  it('leaves pure control questions outside the body so the empty gate can reject delivery', () => {
    const source = result(control);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source),
      conversation: {fallbackQuestion: 'Fallback question'}});
    expect(canonical.result.conclusion).toBe('');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'needs_user_input', question: 'Which trace?', message: ''});
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext}).issues)
      .toEqual(expect.arrayContaining([expect.objectContaining({code: 'empty_conclusion'})]));
  });

  it('removes all duplicate terminal control segments without applying the final one', () => {
    const answered = '<!-- smartperfetto:conversation-control {"kind":"answered"} -->';
    const canonical = canonicalizeAnalysisResult(result(`Body\n${answered}\n${control}`),
      {conversation: {fallbackQuestion: 'Fallback'}});
    expect(canonical.result.conclusion).toBe('Body\n\n');
    expect(canonical.conversationOutcome).toMatchObject({kind: 'answered', message: 'Body\n\n'});
    expect(canonical.protocolDiagnostics?.conversation?.issues).toEqual([{code: 'duplicate_marker'}]);
    expect(canonical.bindingEligibility).toBe('ineligible');
  });

  it('uses original sidecar claims instead of an existing normalized replacement', () => {
    const source = result(`Measured result.\n${renderConclusionContractSidecar(declaration(999))}`);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusionContract?.claims).toEqual(declaration(999).claims);
    expect(canonical.validationContract?.claims).toEqual(declaration(999).claims);
    const envelope = createDataEnvelope({columns: ['dur_ms'], rows: [[12.5]]}, {
      type: 'sql_result', source: 'execute_sql', title: 'Duration', evidenceRefId: 'data:duration',
    });
    // Display data alone cannot certify or refute the original proposition.
    expect(runClaimVerification({conclusionContract: canonical.result.conclusionContract, dataEnvelopes: [envelope]})
      .claimVerificationResult.status).toBe('not_checked');
  });

  it('does not fall back to an old contract for an invalid sidecar', () => {
    const marker = '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":"RAW_DIAGNOSTIC_CANARY"}\n```\n-->';
    const source = result(`Actual answer\n${marker}`);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusionContract).toBeUndefined();
    expect(canonical.bindingEligibility).toBe('ineligible');
    expect(canonical.protocolDiagnostics?.sidecar.status).toBe('invalid');
    expect(canonical.protocolDiagnostics?.sidecar.rawPayload).toEqual({broken: 'RAW_DIAGNOSTIC_CANARY'});
    expect(JSON.stringify(canonical.result)).not.toContain('RAW_DIAGNOSTIC_CANARY');
  });

  it('keeps malformed original declarations private while retaining ineligible typed claims', () => {
    const malformed = {...declaration(), claims: [{...declaration().claims![0], semantics: 'RAW_SEMANTICS_CANARY'}]};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const canonical = canonicalizeAnalysisResult(result(`Actual answer\n${marker}`));
    expect(canonical.result.conclusionContract?.bindingEligibility).toBe('ineligible');
    expect(canonical.result.conclusionContract?.claims?.[0].text).toBe('Measured duration is 999 ms.');
    expect(canonical.protocolDiagnostics?.sidecar.contract?.claims?.[0].rawSemantics).toBe('RAW_SEMANTICS_CANARY');
    expect(JSON.stringify(canonical.result)).not.toContain('RAW_SEMANTICS_CANARY');
    expect(canonical.result.completion).toBeUndefined();
  });

  it.each(['sidecar', 'legacy'] as const)('projects nested source and claim fields without leaking raw diagnostics on %s', path => {
    const untrusted = {...declaration(), bindingEligibility: 'ineligible',
      conclusions: [{rank: 1, statement: 'A statement', trigger: {rawDeclaration: 'TRIGGER_RAW_CANARY'}}],
      sourceUseDecision: {rawDeclaration: 'SOURCE_RAW_CANARY'},
      sourceReferences: [{referenceId: 'lookup-current', codebaseId: 'source-current', filePath: 'src/Foo.ts',
        lookupKind: 'body', snippet: 'REFERENCE_RAW_CANARY', rawDeclaration: 'REFERENCE_RAW_CANARY'}],
      sourceClaimBindings: [{claimId: 'measured-duration', mechanismStatus: 'compatible',
        sourceReferenceIds: [], traceEvidenceRefIds: [], rawDeclaration: 'BINDING_RAW_CANARY'}],
      claims: [{...declaration().claims![0], artifactRefs: [{artifactId: 'artifact-a',
        rowSelector: {row: 1, unsupported: {rawDeclaration: 'SELECTOR_RAW_CANARY'}}}],
        semantics: {rawDeclaration: 'SEMANTICS_RAW_CANARY'}}],
    };
    const source = result(path === 'sidecar'
      ? `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(untrusted)}\n\`\`\`\n-->` : 'Body');
    if (path === 'legacy') source.conclusionContract = untrusted as unknown as ConclusionContract;
    const canonical = canonicalizeAnalysisResult(source);
    expect(JSON.stringify(canonical.result.conclusionContract)).not.toContain('RAW_CANARY');
    expect(JSON.stringify(canonical.validationContract)).toContain('RAW_CANARY');
    expect(canonical.result.conclusionContract?.sourceUseDecision).toBeUndefined();
    expect(canonical.result.conclusionContract?.conclusions[0].trigger).toBeUndefined();
    expect(canonical.result.conclusionContract?.claims?.[0].artifactRefs?.[0].rowSelector).toEqual({row: 1});
    expect(canonical.bindingEligibility).toBe('ineligible');
  });

  it.each(['valid', 'invalid'] as const)('prioritizes the original complete typed JSON %s declaration without rendering its body', state => {
    const original = {...declaration(999), relationProposals: [],
      ...(state === 'invalid' ? {verified: true} : {})};
    const body = `  ${JSON.stringify(original)}  `;
    const source = result(body);
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(body);
    expect(canonical.validationContract?.claims?.[0].references[0].value).toBe(999);
    expect(canonical.protocolDiagnostics?.typedJson?.status).toBe(state);
    expect(canonical.bindingEligibility).toBe(state === 'valid' ? 'eligible' : 'ineligible');
  });

  it('keeps invalid protocol shells ineligible even when there is no typed contract to carry the verdict', () => {
    for (const body of [
      '<!-- smartperfetto:conclusion-contract@1\n```json\n{"broken":true}\n```\n-->',
      JSON.stringify({schemaVersion: 'conclusion_contract_v1', relationProposals: [], mode: 'focused_answer'}),
    ]) {
      const source = result(body);
      source.conclusionContract = declaration(12.5);
      const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
      expect(canonical.validationContract).toBeUndefined();
      expect(canonical.result.conclusionContract).toBeUndefined();
      expect(canonical.bindingEligibility).toBe('ineligible');
    }
  });

  it('keeps full raw declarations private on both sidecar and existing-contract paths', () => {
    const malformed = {...declaration(), bindingEligibility: 'eligible', metadata: {
      sceneId: 'general', unknownField: {rawDeclaration: 'NESTED_RAW_CANARY'},
      clusterPolicy: {outputMode: 'optional', frameListMode: 'none', unexpected: 'POLICY_RAW_CANARY'},
    }};
    const marker = `<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(malformed)}\n\`\`\`\n-->`;
    const parsed = canonicalizeAnalysisResult(result(`Body\n${marker}`));
    expect(parsed.validationContract?.bindingEligibility).toBe('ineligible');
    expect(parsed.validationContract?.rawDeclaration).toEqual(malformed);
    const legacy = result('Exact existing body');
    legacy.conclusionContract = parsed.validationContract;
    const existing = canonicalizeAnalysisResult(legacy);
    expect(existing.validationContract).toBe(parsed.validationContract);
    for (const canonical of [parsed, existing]) {
      expect(canonical.result.conclusionContract?.bindingEligibility).toBe('ineligible');
      expect(canonical.result.conclusionContract?.metadata).toEqual({sceneId: 'general',
        clusterPolicy: {outputMode: 'optional', frameListMode: 'none'}});
      expect(JSON.stringify(canonical.result)).not.toContain('RAW_CANARY');
      expect(canonical.result.conclusionContract).not.toHaveProperty('rawDeclaration');
    }
  });

  it('does not activate a nested second protocol or a nonterminal control', () => {
    const quotedSidecar = renderConclusionContractSidecar(declaration());
    const payload = JSON.stringify({kind: 'needs_user_input', question: quotedSidecar}).replace(/-->/g, '\\u002d\\u002d>');
    const nestedControl = `<!-- smartperfetto:conversation-control ${payload} -->`;
    const nested = canonicalizeAnalysisResult(result(nestedControl), {conversation: {fallbackQuestion: 'Fallback'}});
    expect(nested.result.conclusion).toBe('');
    expect(nested.protocolDiagnostics?.sidecar.status).toBe('absent');
    const ordinary = `${control}\nThis is subsequent narrative, so the earlier marker is ordinary content.`;
    expect(canonicalizeAnalysisResult(result(ordinary), {conversation: {fallbackQuestion: 'Fallback'}}).result.conclusion).toBe(ordinary);
  });

  it('preserves legacy declarations and exact prose only when sidecar is absent', () => {
    const source = result('  ## Complete report\n\n快速回答：Connection error and full analysis are trace content.  ');
    source.conclusionContract = declaration(12.5);
    const canonical = canonicalizeAnalysisResult(source, {context: contextFor(source)});
    expect(canonical.result.conclusion).toBe(source.conclusion);
    expect(canonical.result.conclusionContract).toEqual(source.conclusionContract);
    expect(canonical.validationContract).toBe(source.conclusionContract);
    expect(canonical.projection.disposition).toBe('preserved');
    expect(canonical.protocolDiagnostics).toBeUndefined();
  });

  it.each(['completed', 'incomplete', 'unknown'] as const)('transfers only native %s completion through issued projection', status => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source, status);
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(isIssuedCanonicalAnalysisProjection(canonical.projection)).toBe(true);
    expect(isIssuedCanonicalAnalysisProjection({...canonical.projection})).toBe(false);
    expect(Object.isFrozen(canonical.projection)).toBe(true);
    expect(Object.isFrozen(canonical.projection.sourceCandidate)).toBe(true);
    expect(Object.isFrozen(canonical.projection.candidate)).toBe(true);
    expect(canonical.result.completion?.status).toBe(status);
    expect(canonical.result.completion?.candidateRef).not.toBe(context.acceptedCandidate.candidateRef);
    expect(assessFinalResultQualityAssessment({result: canonical.result, context}).assurance.completion).toBe('not_checked');
  });

  it.each(['candidateRef', 'runId', 'attemptId', 'conclusionFingerprint'] as const)(
    'does not transfer a native receipt for another %s', field => {
      const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
      const context = contextFor(source);
      context.completion = {...context.completion!, [field]: 'stale'};
      expect(canonicalizeAnalysisResult(source, {context}).result.completion).toBeUndefined();
    },
  );

  it('does not re-sign a stale source body or trust result metadata without explicit context', () => {
    const source = result('Original body');
    const context = contextFor(source);
    source.conclusion = `Different body\n${renderConclusionContractSidecar(declaration())}`;
    source.completion = context.completion;
    source.outputOrigin = 'sdk_final';
    for (const options of [{context}, {}]) {
      const canonical = canonicalizeAnalysisResult(source, options);
      expect(canonical.result.completion).toBeUndefined();
      expect(canonical.projection.candidate).toBeUndefined();
      expect(canonical.projection.sourceCandidate).toBeUndefined();
    }
  });

  it('invalidates old evidence and report bindings when selecting a new declared contract', () => {
    const source = result(`Body\n${renderConclusionContractSidecar(declaration())}`);
    const context = contextFor(source);
    source.conclusionContract = declaration(12.5);
    source.claimSupport = [];
    source.deliveryAssurance = {schemaVersion: 1, entry: 'new_finalization', completion: 'passed',
      claims: 'passed', source: 'passed', identity: 'passed', report: 'passed'};
    context.claimVerificationBinding = {candidate: context.acceptedCandidate, evidenceFingerprint: 'evidence-a',
      claimsFingerprint: 'old-claims', verificationFingerprint: 'old-verification'};
    context.sourceVerificationBinding = {...context.claimVerificationBinding,
      conclusionContractFingerprint: 'old-contract', sourceUseFingerprint: 'old-source'};
    context.evidenceRenderedProof = {kind: 'verified_facts', ...context.claimVerificationBinding, claimIds: ['old']};
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result.claimSupport).toBeUndefined();
    expect(canonical.result.deliveryAssurance).toBeUndefined();
    if (canonical.deliveryContext?.entry !== 'new_finalization') throw new Error('Missing canonical context');
    expect(canonical.deliveryContext.claimVerificationBinding).toBeUndefined();
    expect(canonical.deliveryContext.sourceVerificationBinding).toBeUndefined();
    expect(canonical.deliveryContext.evidenceRenderedProof).toBeUndefined();
  });

  it('preserves a typed whole privacy fallback without granting completion', () => {
    const source = result('[PRIVATE_OUTPUT_SUPPRESSED]');
    source.success = false;
    source.partial = true;
    source.outputOrigin = 'runtime_fallback';
    const context = contextFor(source, 'unknown');
    context.outputOrigin = 'runtime_fallback';
    const canonical = canonicalizeAnalysisResult(source, {context});
    expect(canonical.result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback'});
    expect(canonical.result.completion?.status).toBe('unknown');
    expect(assessFinalResultQualityAssessment({result: canonical.result, context: canonical.deliveryContext})
      .assurance.completion).toBe('failed');
  });
});
