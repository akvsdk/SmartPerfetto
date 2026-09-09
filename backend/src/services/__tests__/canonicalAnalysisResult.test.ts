// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {renderConclusionContractSidecar, type ConclusionContract} from '../../agent/core/conclusionContract';
import {analysisDeliveryFingerprint, type AnalysisCompletion, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import {canonicalizeAnalysisResult, isIssuedCanonicalAnalysisProjection, inspectCandidateProtocol,
  buildCandidateProtocolDiagnostic, sanitizeCandidateProtocolDiagnostic} from '../canonicalAnalysisResult';
import {assessFinalResultQualityAssessment} from '../finalResultQualityGate';
import {runClaimVerification} from '../verifier/claimVerificationRunner';
import {createDataEnvelope} from '../../types/dataContract';
import {finalizeSourceAwareAnalysisResultWithProjection} from '../codebase/sourceClaimVerifier';
import {claimConclusionProtocolProjection, readConclusionProtocolProjection, releaseConclusionProtocolProjection,
  projectConclusionSemanticInput} from '../security/conclusionProtocolProjection';
import {registerOnDemandSourceLookupForEcho, registerCodeAwareCanary, registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards, clearCodeAwareOutputGuards} from '../security/codeAwareOutputRegistry';
import {prepareClaimEvidence, preparedClaimEvidenceSnapshot} from '../evidence/claimEvidencePreparation';

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

async function proseFixture(attach = true) {
  const marker = 'source_native_prose_marker_unique';
  const prose = (field: string) => `${field}: ${marker}`;
  const contract: ConclusionContract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
    conclusions: [{rank: 1, statement: prose('statement'), trigger: prose('trigger'), supply: prose('supply'), amplification: prose('amplification')}],
    clusters: [{cluster: prose('cluster'), description: prose('description')}],
    evidenceChain: [{conclusionId: 'C1', text: prose('evidence')}], uncertainties: [prose('uncertainty')], nextSteps: [prose('next')],
    claims: [{id: 'c1', conclusionId: 'C1', kind: 'inference', text: prose('claim'), references: [],
      semantics: {schemaVersion: 'claim_semantics@1', predicate: 'source.prose', polarity: 'affirmed', discourse: 'asserted',
        quantifier: 'one', modality: 'possible', conditions: [prose('condition')], scope: {population: 'codebase'}}}]};
  const source = result(`Visible ${marker}.\n${renderConclusionContractSidecar(contract)}`);
  registerOnDemandSourceLookupForEcho(source.sessionId, [{referenceId: 'prose-read', codebaseId: 'cb-prose',
    filePath: 'src/Prose.kt', lineRange: {start: 1, end: 1}, text: `val marker = "${marker}"`}]);
  const projected = finalizeSourceAwareAnalysisResultWithProjection(source, undefined, {context: contextFor(source)});
  const token = projected.protocolProjection!;
  if (attach) claimConclusionProtocolProjection(token);
  if (!projected.deliveryContext || projected.deliveryContext.entry === 'historical_restore') throw new Error('Unexpected fixture entry');
  const native = readConclusionProtocolProjection(token, {result: source,
    candidate: projected.deliveryContext.acceptedCandidate, runId: 'run-a'});
  const canonical = canonicalizeAnalysisResult(source, {context: projected.deliveryContext, nativeDeclaration: native});
  const prepared = await prepareClaimEvidence({conclusionContract: canonical.validationContract, bindingEligibility: canonical.bindingEligibility});
  const input = {sessionId: source.sessionId, nativeDeclaration: native, canonicalProjection: canonical.projection,
    canonicalCandidate: canonical.projection.candidate!, runId: 'run-a', prepared,
    snapshot: {inputCoverage: 'complete' as const, declarationBindingEligibility: canonical.bindingEligibility,
      query: 'Review these declarations', body: canonical.result.conclusion,
      conclusionContract: structuredClone(canonical.validationContract), evidenceSnapshot: preparedClaimEvidenceSnapshot(prepared)}};
  return {input, marker, source, canonical, token,
    cleanup: () => {releaseConclusionProtocolProjection(token); clearCodeAwareOutputGuards(source.sessionId);}};
}

describe('exact native prose semantic input receipt', () => {
  it('restores only original declaration fields while keeping the actual display body and receipt private', async () => {
    const target = await proseFixture();
    try {
      const projected = projectConclusionSemanticInput(target.input);
      expect(projected.changed).toBe(false);
      const {parseIssues: _issues, ...expected} = target.input.snapshot.conclusionContract!;
      expect(projected.value.conclusionContract).toEqual(expected);
      expect(projected.value.body).toBe(target.canonical.result.conclusion);
      expect(projected.value.body).not.toContain(target.marker);
      expect(JSON.stringify(target.canonical.projection)).not.toContain(target.marker);
      expect(JSON.stringify(target.canonical.result)).not.toContain(target.marker);
    } finally {target.cleanup();}
  });

  it.each(['copy', 'absent', 'session', 'run', 'attempt', 'candidate', 'body', 'native', 'released', 'unattached', 'historical'] as const)(
    'grants no prose role after a changed %s identity', async kind => {
      const target = await proseFixture(kind !== 'unattached');
      try {
        const input = {...target.input, snapshot: structuredClone(target.input.snapshot)};
        if (kind === 'copy') input.canonicalProjection = {...input.canonicalProjection};
        if (kind === 'absent') delete (input as Partial<typeof input>).canonicalProjection;
        if (kind === 'session') input.sessionId = 'other-session';
        if (kind === 'run') input.runId = 'other-run';
        if (kind === 'attempt') input.canonicalCandidate = {...input.canonicalCandidate, attemptId: 'other-attempt'};
        if (kind === 'candidate') input.canonicalCandidate = {...input.canonicalCandidate, candidateRef: 'other-candidate'};
        if (kind === 'body') {input.snapshot.body += ' changed'; input.canonicalCandidate = {...input.canonicalCandidate,
          conclusionFingerprint: analysisDeliveryFingerprint(input.snapshot.body)};}
        if (kind === 'native') input.nativeDeclaration = {...input.nativeDeclaration};
        if (kind === 'released') releaseConclusionProtocolProjection(target.token);
        if (kind === 'historical') input.canonicalProjection = canonicalizeAnalysisResult(target.source,
          {context: {entry: 'historical_restore'}}).projection;
        if (kind === 'session') registerOnDemandSourceLookupForEcho(input.sessionId, [{referenceId: 'other-read',
          codebaseId: 'other', filePath: 'Other.kt', text: target.marker}]);
        const projected = projectConclusionSemanticInput(input);
        expect(projected.changed).toBe(true);
        expect(JSON.stringify(projected.value.conclusionContract)).not.toContain(target.marker);
      } finally {clearCodeAwareOutputGuards('other-session'); target.cleanup();}
    });

  it.each(['text', 'claim_id', 'kind', 'presence', 'rank', 'cluster', 'conclusion_id', 'moved', 'substring'] as const)(
    'does not restore original prose under changed %s fields', async kind => {
      const target = await proseFixture();
      try {
        const contract = target.input.snapshot.conclusionContract!;
        const claim = contract.claims![0];
        if (kind === 'text') claim.text += ' added';
        if (kind === 'claim_id') claim.id = 'other-claim';
        if (kind === 'kind') claim.kind = 'identity';
        if (kind === 'presence') delete claim.conclusionId;
        if (kind === 'rank') contract.conclusions[0].rank = 2;
        if (kind === 'cluster') contract.clusters[0].cluster += ' changed';
        if (kind === 'conclusion_id') contract.evidenceChain[0].conclusionId = 'C2';
        if (kind === 'moved') [contract.uncertainties[0], contract.nextSteps[0]] = [contract.nextSteps[0], contract.uncertainties[0]];
        if (kind === 'substring') claim.text = target.marker;
        expect(projectConclusionSemanticInput(target.input).changed).toBe(true);
      } finally {target.cleanup();}
    });

  it.each(['canary', 'private_query', 'revoked', 'claim_key', 'parent_key', 'statement_key'] as const)(
    'keeps %s stronger than exact native prose permissions', async kind => {
      const target = await proseFixture();
      try {
        if (kind === 'canary') registerCodeAwareCanary(target.input.sessionId, target.marker);
        if (kind === 'private_query') registerPrivateAnalysisQueryForEcho(target.input.sessionId, target.marker);
        if (kind === 'revoked') revokeCodeAwareOutputGuards(target.input.sessionId);
        if (kind === 'claim_key') registerCodeAwareCanary(target.input.sessionId, 'text');
        if (kind === 'parent_key') registerCodeAwareCanary(target.input.sessionId, 'claims');
        if (kind === 'statement_key') registerCodeAwareCanary(target.input.sessionId, 'statement');
        const projected = projectConclusionSemanticInput(target.input);
        expect(projected.changed).toBe(true);
        if (kind === 'claim_key') expect(projected.value.conclusionContract?.claims?.[0]).not.toHaveProperty('text');
        else if (kind === 'parent_key') expect(projected.value.conclusionContract).not.toHaveProperty('claims');
        else if (kind === 'statement_key') expect(projected.value.conclusionContract?.conclusions?.[0]).not.toHaveProperty('statement');
        else expect(JSON.stringify(projected.value)).not.toContain(target.marker);
      } finally {target.cleanup();}
    });
});

describe('canonical analysis result projection', () => {
  it('uses the same protocol inspection for native diagnostics and canonical narrative', () => {
    const raw = `Visible body\n${renderConclusionContractSidecar(declaration())}`;
    const inspected = inspectCandidateProtocol(raw);
    expect(inspected.canonicalBody).toBe(canonicalizeAnalysisResult(result(raw)).result.conclusion);
    expect(buildCandidateProtocolDiagnostic(inspected, 'native', 1)).toMatchObject({
      status: 'valid', sidecarStatus: 'valid', typedJsonStatus: 'not_checked', canonicalChars: 12,
      projectionKind: 'protocol_projection', issueCodes: [], issueCount: 0,
    });
    const onlySidecar = inspectCandidateProtocol(renderConclusionContractSidecar(declaration()));
    expect(buildCandidateProtocolDiagnostic(onlySidecar, 'native', 1)).toMatchObject({status: 'valid', canonicalChars: 0});
  });

  it('distinguishes valid native declarations from a later malformed projected declaration without disclosing text', () => {
    const raw = `Body PRIVATE_DIAGNOSTIC_CANARY\n${renderConclusionContractSidecar(declaration())}`;
    const changed = raw.replace('"focused_answer"', '"PRIVATE_DIAGNOSTIC_CANARY"');
    const native = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    const projected = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(changed), 'runtime_projected', 1, 'redacted');
    expect(native.status).toBe('valid');
    expect(projected).toMatchObject({status: 'invalid', projectionKind: 'redacted', issueCodes: ['invalid_contract']});
    expect(sanitizeCandidateProtocolDiagnostic(projected)).toEqual(projected);
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    expect(projected).toMatchObject({claimCount: 1, semanticClaimCount: 0, sourceBindingCount: 0, status: 'invalid'});
  });

  it('records declared claim/semantic/binding counts without treating them as valid evidence', () => {
    const original = {...declaration(), claims: [
      {id: 'one', text: 'A hypothetical statement.', kind: 'inference', references: [], semantics: {
        schemaVersion: 'claim_semantics@1', predicate: 'example.hypothesis', polarity: 'affirmed',
        discourse: 'hypothetical', quantifier: 'one', modality: 'possible', scope: {population: 'codebase'},
      }},
      {id: 'two', text: 'An unchecked statement.', kind: 'inference', references: []},
    ], sourceClaimBindings: [{invalid: 'PRIVATE_DIAGNOSTIC_CANARY'}, {alsoInvalid: true}]};
    const inspect = (payload: unknown) => inspectCandidateProtocol(
      `Body\n<!-- smartperfetto:conclusion-contract@1\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n-->`);
    const native = buildCandidateProtocolDiagnostic(inspect(original), 'native', 1);
    expect(native).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 2});
    expect(sanitizeCandidateProtocolDiagnostic(native)).toEqual(native);
    const projected = buildCandidateProtocolDiagnostic(inspect({...original, sourceClaimBindings: []}), 'runtime_projected', 1);
    expect(projected).toMatchObject({claimCount: 2, semanticClaimCount: 1, sourceBindingCount: 0});
    expect(JSON.stringify([native, projected])).not.toContain('PRIVATE_DIAGNOSTIC_CANARY');
    const old = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(old).not.toHaveProperty('claimCount');
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it('projects only fixed root structure facts and raw declaration entry counts for an invalid shell', () => {
    const raw = renderConclusionContractSidecar({...declaration(), mode: 'PRIVATE_STRUCTURE_CANARY'} as any);
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(raw), 'native', 1);
    expect(diagnostic).toMatchObject({status: 'invalid', issueCount: 1, claimCount: 1, semanticClaimCount: 0,
      sourceBindingCount: 0, details: [{field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'}]});
    expect(sanitizeCandidateProtocolDiagnostic(diagnostic)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toContain('PRIVATE_STRUCTURE_CANARY');
  });

  it('rejects duplicate, excessive, unknown or impossible structure detail combinations while accepting old diagnostics', () => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol(
      renderConclusionContractSidecar({...declaration(), mode: 'bad'} as any)), 'native', 1);
    const detail = {field: '$.mode', expected: 'conclusion_mode', actual: 'string', reason: 'invalid_enum'};
    for (const details of [[detail, detail], Array(25).fill(detail), [null],
      [{...detail, field: '/private/source'}], [{...detail, actual: 'PRIVATE_STRUCTURE_CANARY'}],
      [{...detail, expected: 'string'}], [{...detail, reason: 'wrong_type'}],
      [{...detail, field: '$.conclusions[].rank', expected: 'finite_number'}],
      [{...detail, field: '$', expected: 'object', actual: 'missing', reason: 'missing_required'}],
      [{...detail, raw: 'PRIVATE_STRUCTURE_CANARY'}]]) {
      expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details})).toBeUndefined();
    }
    const uniqueDetails = ['$', '$.conclusions[]', '$.clusters[]', '$.evidenceChain[]'].flatMap(field =>
      ['null', 'array', 'string', 'number', 'boolean', 'undefined', 'other', 'nonfinite_number'].map(actual =>
        ({field, expected: 'object', actual, reason: 'wrong_type'})));
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 24)})).toBeDefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, details: uniqueDetails.slice(0, 25)})).toBeUndefined();
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, issueCodes: ['invalid_reference'], details: [detail]})).toBeUndefined();
    const {details: _details, ...old} = diagnostic;
    expect(sanitizeCandidateProtocolDiagnostic(old)).toEqual(old);
  });

  it.each(['Ordinary answer', JSON.stringify(declaration())])('keeps ordinary or legacy declarations absent rather than invalid: %s', raw => {
    expect(inspectCandidateProtocol(raw).status).toBe('absent');
  });

  it.each([
    {raw: 'PRIVATE_DIAGNOSTIC_CANARY'}, {path: '/private/source'}, {claimId: 'private-claim'},
    {issueCodes: ['private_failure'], issueCount: 1}, {rawChars: -1}, {canonicalChars: Infinity},
    {issueCount: Number.MAX_SAFE_INTEGER + 1}, {candidateIndex: 3}, {stage: 'model_claim'},
    {claimCount: 1}, {claimCount: 1, semanticClaimCount: 2, sourceBindingCount: 0},
    {claimCount: 1, semanticClaimCount: 1, sourceBindingCount: -1},
  ])('rejects unsafe or malformed diagnostic metadata %j', extra => {
    const diagnostic = buildCandidateProtocolDiagnostic(inspectCandidateProtocol('Body'), 'native', 1);
    expect(sanitizeCandidateProtocolDiagnostic({...diagnostic, ...extra})).toBeUndefined();
  });

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
