// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {randomUUID} from 'node:crypto';
import type {AnalysisResult} from '../agent/core/orchestratorTypes';
import {deriveConclusionContract} from '../agent/core/conclusionGenerator';
import {parseConclusionContractSidecar, parseTypedConclusionContractJson, parseDeclaredConclusionClaims,
  parseDeclaredRelationProposals, type ConclusionContract, type ConclusionBindingEligibility,
  type ConclusionContractDeclarationParseResult, type ConclusionContractSidecarParseResult} from '../agent/core/conclusionContract';
import {parseConversationResponseWithProjection, type ConversationEvidenceRef,
  type ConversationResponseProjection, type ConversationRuntimeOutcome} from '../assistant/contracts/conversationContract';
import {analysisDeliveryFingerprint, sameAnalysisCandidate, type AnalysisCandidateIdentity,
  type AnalysisDeliveryContext} from '../types/analysisDelivery';
import {sanitizeSourceUseDecision, sanitizeSourceReferences, sanitizeSourceClaimBindings} from './codebase/sourceUseDecision';
import type {CaseKnowledgeReportRecommendation, CaseKnowledgeRecommendation} from '../types/caseKnowledge';

/** Internal receipt. Neither this object nor the source hash belongs in result JSON. */
export interface CanonicalAnalysisProjection {
  readonly disposition: 'preserved' | 'protocol_projection';
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly sourceCandidate?: Readonly<AnalysisCandidateIdentity>;
  readonly candidate?: Readonly<AnalysisCandidateIdentity>;
}

export interface CanonicalAnalysisResult {
  result: AnalysisResult;
  /** Exact selected declaration, including invalid originals; never serialize this sidecar. */
  validationContract?: ConclusionContract;
  /** Server parser qualification survives invalid declarations that have no typed shell. */
  bindingEligibility: ConclusionBindingEligibility;
  deliveryContext?: AnalysisDeliveryContext;
  projection: CanonicalAnalysisProjection;
  conversationOutcome?: ConversationRuntimeOutcome;
  /** Private parser records preserve original declarations for finalization diagnostics. */
  protocolDiagnostics?: {
    sidecar: ConclusionContractSidecarParseResult;
    typedJson?: ConclusionContractDeclarationParseResult;
    conversation?: ConversationResponseProjection;
  };
}

const issuedProjections = new WeakSet<object>();

export function isIssuedCanonicalAnalysisProjection(value: unknown): value is CanonicalAnalysisProjection {
  return typeof value === 'object' && value !== null && issuedProjections.has(value);
}

function issueProjection(input: CanonicalAnalysisProjection): CanonicalAnalysisProjection {
  const projection = Object.freeze({...input,
    ...(input.sourceCandidate ? {sourceCandidate: Object.freeze({...input.sourceCandidate})} : {}),
    ...(input.candidate ? {candidate: Object.freeze({...input.candidate})} : {}),
  });
  issuedProjections.add(projection);
  return projection;
}

function declaredFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  if (!value || typeof value !== 'object') return {} as Pick<T, K>;
  return Object.fromEntries(keys.flatMap(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? [[key, descriptor.value]] : [];
  })) as Pick<T, K>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(Object.entries(declaredFields(value, keys)).filter(([, item]) => typeof item === 'string')) as Partial<Pick<T, K>>;
}

function numberFields<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(Object.entries(declaredFields(value, keys)).filter(([, item]) => typeof item === 'number' && Number.isFinite(item))) as Partial<Pick<T, K>>;
}

function caseRecommendationsForResult(value: ConclusionContract['caseRecommendations']): CaseKnowledgeReportRecommendation[] {
  const recommendations = (items: unknown): CaseKnowledgeRecommendation[] => Array.isArray(items) ? items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const fields = declaredFields(item as CaseKnowledgeRecommendation, ['id', 'priority', 'action', 'applies_when', 'risks']);
    return typeof fields.id === 'string' && typeof fields.action === 'string' && typeof fields.applies_when === 'string' &&
      typeof fields.risks === 'string' && ['P0', 'P1', 'P2', 'P3'].includes(fields.priority) ? [fields] : [];
  }) : [];
  return Array.isArray(value) ? value.flatMap(item => {
    if (!item || typeof item.caseId !== 'string' || typeof item.title !== 'string' ||
      !['strong', 'partial', 'background'].includes(item.matchStrength)) return [];
    const learned = item.learnedProvenance;
    return [{caseId: item.caseId, title: item.title, matchStrength: item.matchStrength,
      ...stringFields(item, ['scene', 'primaryRootCause', 'evidenceGap']),
      ...(item.evidenceRefs ? {evidenceRefs: strings(item.evidenceRefs)} : {}),
      ...(item.matchedSignatures ? {matchedSignatures: strings(item.matchedSignatures)} : {}),
      ...(item.missingRequiredSignatures ? {missingRequiredSignatures: strings(item.missingRequiredSignatures)} : {}),
      recommendations: {app: recommendations(item.recommendations?.app), oem: recommendations(item.recommendations?.oem)},
      ...(learned && typeof learned.candidateId === 'string' && typeof learned.supported === 'boolean' &&
        Number.isFinite(learned.supportingEvidence) && Number.isFinite(learned.contradictingEvidence) ? {learnedProvenance: {
          candidateId: learned.candidateId, supportingEvidence: learned.supportingEvidence,
          contradictingEvidence: learned.contradictingEvidence, supported: learned.supported,
        }} : {}),
    }];
  }) : [];
}

/** Raw malformed declarations remain private; typed declarations retain parser eligibility. */
function declaredContractForResult(contract: ConclusionContract | undefined): ConclusionContract | undefined {
  if (!contract) return undefined;
  const typed = declaredFields(contract, ['schemaVersion', 'mode', 'conclusions', 'clusters', 'evidenceChain',
    'claims', 'relationProposals', 'bindingEligibility', 'sourceUseDecision', 'sourceReferences',
    'sourceClaimBindings', 'caseRecommendations', 'uncertainties', 'nextSteps', 'metadata']);
  if (Array.isArray(typed.conclusions)) typed.conclusions = typed.conclusions.flatMap(item =>
    item && typeof item.statement === 'string' && Number.isFinite(item.rank) ? [{rank: item.rank, statement: item.statement,
      ...numberFields(item, ['confidencePercent']), ...stringFields(item, ['trigger', 'supply', 'amplification'])}] : []);
  if (Array.isArray(typed.clusters)) typed.clusters = typed.clusters.flatMap(item =>
    item && typeof item.cluster === 'string' ? [{cluster: item.cluster, ...stringFields(item, ['description']),
      ...numberFields(item, ['frames', 'percentage', 'omittedFrameRefs']),
      ...(item.frameRefs ? {frameRefs: strings(item.frameRefs)} : {})}] : []);
  if (Array.isArray(typed.evidenceChain)) typed.evidenceChain = typed.evidenceChain.flatMap(item =>
    item && typeof item.conclusionId === 'string' && typeof item.text === 'string'
      ? [{conclusionId: item.conclusionId, text: item.text}] : []);
  if (typed.claims) {
    const declarations = typed.claims.map(claim => declaredFields(claim,
      ['id', 'conclusionId', 'text', 'kind', 'references', 'artifactRefs', 'relationRefs', 'supportLevel', 'semantics']));
    typed.claims = parseDeclaredConclusionClaims(declarations).claims.map(claim => {
      const {rawReferences: _references, rawSemantics: _semantics, semanticsParseIssues: _issues, ...projected} = claim;
      if (projected.artifactRefs) projected.artifactRefs = projected.artifactRefs.map(reference => ({
        ...reference, ...(reference.rowSelector ? {rowSelector: Object.fromEntries(Object.entries(reference.rowSelector)
          .filter(([, item]) => typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)))} : {}),
      }));
      return projected;
    });
  }
  if (typed.relationProposals) typed.relationProposals = parseDeclaredRelationProposals(typed.relationProposals).relationProposals;
  if (typed.sourceUseDecision) typed.sourceUseDecision = sanitizeSourceUseDecision(typed.sourceUseDecision);
  if (typed.sourceReferences) typed.sourceReferences = sanitizeSourceReferences(typed.sourceReferences);
  if (typed.sourceClaimBindings) typed.sourceClaimBindings = sanitizeSourceClaimBindings(typed.sourceClaimBindings);
  if (typed.caseRecommendations) typed.caseRecommendations = caseRecommendationsForResult(typed.caseRecommendations);
  if (typed.uncertainties) typed.uncertainties = strings(typed.uncertainties);
  if (typed.nextSteps) typed.nextSteps = strings(typed.nextSteps);
  if (typed.metadata) {
    const metadata = typed.metadata;
    const clusterPolicy = metadata.clusterPolicy;
    typed.metadata = {
      ...(typeof metadata.confidencePercent === 'number' ? {confidencePercent: metadata.confidencePercent} : {}),
      ...(typeof metadata.rounds === 'number' ? {rounds: metadata.rounds} : {}),
      ...(typeof metadata.sceneId === 'string' ? {sceneId: metadata.sceneId} : {}),
      ...(typeof metadata.derivedFromNarrativeEvidenceMatch === 'boolean'
        ? {derivedFromNarrativeEvidenceMatch: metadata.derivedFromNarrativeEvidenceMatch} : {}),
      ...(typeof metadata.replacedUnresolvableProviderClaims === 'boolean'
        ? {replacedUnresolvableProviderClaims: metadata.replacedUnresolvableProviderClaims} : {}),
      ...(metadata.claimDerivation === 'explicit_model_contract' || metadata.claimDerivation === 'narrative_evidence_match'
        ? {claimDerivation: metadata.claimDerivation} : {}),
      ...(metadata.claimVerificationScope === 'explicit_claims' || metadata.claimVerificationScope === 'sampled_narrative_evidence'
        ? {claimVerificationScope: metadata.claimVerificationScope} : {}),
      ...(clusterPolicy && ['required', 'optional', 'none'].includes(clusterPolicy.outputMode) &&
        ['none', 'top', 'full'].includes(clusterPolicy.frameListMode) ? {clusterPolicy: {
          outputMode: clusterPolicy.outputMode, frameListMode: clusterPolicy.frameListMode,
          ...(typeof clusterPolicy.maxFramesPerCluster === 'number' ? {maxFramesPerCluster: clusterPolicy.maxFramesPerCluster} : {}),
        }} : {}),
    };
  }
  return typed;
}

function removeMachineSegments(raw: string, segments: Array<{start: number; end: number}>): string {
  const merged: Array<{start: number; end: number}> = [];
  for (const segment of [...segments].sort((left, right) => left.start - right.start)) {
    const previous = merged[merged.length - 1];
    if (previous?.start === segment.start && previous.end === segment.end) continue;
    if (previous && segment.start < previous.end) throw new Error('overlapping_canonical_protocol_segments');
    merged.push({...segment});
  }
  let narrative = raw;
  for (const {start, end} of merged.reverse()) narrative = narrative.slice(0, start) + narrative.slice(end);
  return narrative;
}

/**
 * Select canonical declarations and remove only protocol spans identified by the
 * actual parsers. No caller-supplied renderer or text replacement can mint proof.
 */
export function canonicalizeAnalysisResult(
  source: AnalysisResult,
  options: {context?: AnalysisDeliveryContext; conversation?: {
    fallbackQuestion: string; evidence?: ConversationEvidenceRef[];
  }} = {},
): CanonicalAnalysisResult {
  const raw = source.conclusion;
  if (options.context?.entry === 'historical_restore') {
    return {result: source, validationContract: source.conclusionContract,
      bindingEligibility: source.conclusionContract?.bindingEligibility ?? 'legacy_unchecked',
      deliveryContext: options.context, projection: issueProjection({
      disposition: 'preserved', inputFingerprint: analysisDeliveryFingerprint(raw), outputFingerprint: analysisDeliveryFingerprint(raw),
    })};
  }
  // Sidecar presence is decided from the original body, before any display projection.
  const sidecar = parseConclusionContractSidecar(raw);
  const conversation = options.conversation ? parseConversationResponseWithProjection(
    raw, options.conversation.fallbackQuestion, options.conversation.evidence,
  ) : undefined;
  const narrative = removeMachineSegments(raw, [...sidecar.machineSegments, ...(conversation?.machineSegments ?? [])]);
  const typedJson = sidecar.status === 'absent' ? parseTypedConclusionContractJson(narrative) : undefined;
  const intent = options.context?.turnIntent;
  const validationContract = sidecar.status !== 'absent'
    ? sidecar.contract
    : typedJson && typedJson.status !== 'absent' ? typedJson.contract : source.conclusionContract ?? deriveConclusionContract(narrative, {
      mode: intent?.status === 'resolved' && intent.deliverable === 'answer' ? 'focused_answer' : 'initial_report',
      ...(intent?.status === 'resolved' ? {sceneId: intent.sceneId} : {}),
    }) ?? undefined;
  const bindingEligibility: ConclusionBindingEligibility = sidecar.status === 'invalid' || typedJson?.status === 'invalid' ||
    conversation?.status === 'invalid' ? 'ineligible' : validationContract?.bindingEligibility ?? 'legacy_unchecked';
  const conclusionContract = declaredContractForResult(validationContract);
  if (conclusionContract && bindingEligibility === 'ineligible') conclusionContract.bindingEligibility = 'ineligible';
  const bodyChanged = narrative !== raw;
  const contractChanged = sidecar.status !== 'absent' || (typedJson !== undefined && typedJson.status !== 'absent') ||
    validationContract !== source.conclusionContract ||
    analysisDeliveryFingerprint(conclusionContract) !== analysisDeliveryFingerprint(source.conclusionContract);
  const result: AnalysisResult = {...source, conclusion: narrative, conclusionContract};
  let deliveryContext = options.context;
  const sourceCandidate = deliveryContext?.acceptedCandidate;
  const sourceMatches = sameAnalysisCandidate(sourceCandidate, sourceCandidate, raw);
  const candidate = sourceMatches && sourceCandidate
    ? bodyChanged ? {...sourceCandidate, candidateRef: `canonical-${randomUUID()}`,
      conclusionFingerprint: analysisDeliveryFingerprint(narrative)} : sourceCandidate
    : undefined;
  const projection = issueProjection({
    disposition: bodyChanged ? 'protocol_projection' : 'preserved',
    inputFingerprint: analysisDeliveryFingerprint(raw), outputFingerprint: analysisDeliveryFingerprint(narrative),
    ...(sourceMatches ? {sourceCandidate} : {}), ...(candidate ? {candidate} : {}),
  });
  if (deliveryContext) {
    const nativeCompletion = deliveryContext.completion;
    const completionCurrent = nativeCompletion?.schemaVersion === 1 &&
      sameAnalysisCandidate(nativeCompletion, sourceCandidate, raw);
    deliveryContext = {...deliveryContext,
      ...(candidate ? {acceptedCandidate: candidate} : {}),
      completion: candidate && completionCurrent ? {...nativeCompletion, ...candidate} : undefined,
    };
  }
  // Result metadata alone never supplies authority for the current canonical body.
  result.completion = deliveryContext?.completion;
  if (sourceMatches) result.outputOrigin = deliveryContext?.outputOrigin;
  else if (result.outputOrigin !== 'runtime_fallback') delete result.outputOrigin;
  if (bodyChanged || contractChanged) {
    delete result.claimSupport;
    delete result.claimVerificationResult;
    delete result.sourceClaimVerificationResult;
    delete result.reportAssessment;
    delete result.deliveryAssurance;
    if (deliveryContext) deliveryContext = {...deliveryContext,
      claimVerificationBinding: undefined, sourceVerificationBinding: undefined,
      reportAssessment: undefined, evidenceRenderedProof: undefined,
    };
  }
  return {result, projection, bindingEligibility, ...(validationContract ? {validationContract} : {}), ...(deliveryContext ? {deliveryContext} : {}),
    ...(conversation ? {conversationOutcome: {...conversation.outcome, message: narrative}} : {}),
    ...(sidecar.status !== 'absent' || (typedJson && typedJson.status !== 'absent') || (conversation && conversation.status !== 'absent')
      ? {protocolDiagnostics: {sidecar, ...(typedJson ? {typedJson} : {}), ...(conversation ? {conversation} : {})}} : {}),
  };
}
