// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {
  analysisDeliveryFingerprint,
  type AnalysisCandidateIdentity,
  type AnalysisAssuranceStatus,
  type AnalysisReportBinding,
} from '../../types/analysisDelivery';
import {
  sanitizeSourceClaimBindings,
  sanitizeSourceReference,
  sanitizeSourceUseDecision,
} from '../codebase/sourceUseDecision';

export type AnalysisDeliveryFields = Pick<AnalysisResult,
  'turnIntent' | 'completion' | 'outputOrigin' | 'runtimeAppendix' |
  'reportAssessment' | 'deliveryAssurance'>;

/** Preserve surviving field order because existing bindings hash the serialized contract. */
export function preserveProjectedFieldOrder<T>(original: unknown, projection: T, depth = 0): T {
  if (depth > 24 || !projection || typeof projection !== 'object') return projection;
  if (Array.isArray(projection)) return projection.map((value, index) =>
    preserveProjectedFieldOrder(Array.isArray(original) ? original[index] : undefined, value, depth + 1)) as T;
  const source = original && typeof original === 'object' && !Array.isArray(original)
    ? original as Record<string, unknown> : {};
  const target = projection as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(source), ...Object.keys(target)])]
    .filter(key => Object.prototype.hasOwnProperty.call(target, key))
    .map(key => [key, preserveProjectedFieldOrder(source[key], target[key], depth + 1)])) as T;
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contentLocation(value: unknown): value is {start: number; end: number} {
  return record(value) && typeof value.start === 'number' && typeof value.end === 'number' &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start;
}

function opaqueId(value: unknown): string {
  return typeof value === 'string' && value.length <= 160 &&
    /^[A-Za-z0-9_.:-]+$/.test(value) ? value : '';
}

function fingerprint(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function candidate(value: AnalysisCandidateIdentity): AnalysisCandidateIdentity {
  return {
    candidateRef: opaqueId(value.candidateRef),
    runId: opaqueId(value.runId),
    attemptId: opaqueId(value.attemptId),
    conclusionFingerprint: fingerprint(value.conclusionFingerprint),
  };
}

function boundCandidate(value: AnalysisCandidateIdentity, conclusion: string): boolean {
  return Boolean(value.candidateRef && value.runId && value.attemptId &&
    value.conclusionFingerprint && value.conclusionFingerprint === analysisDeliveryFingerprint(conclusion));
}

function downgrade(status: AnalysisAssuranceStatus): AnalysisAssuranceStatus {
  return status === 'passed' || status === 'not_applicable' ? 'not_checked' : status;
}

function copyAssuranceStatus(value: unknown): AnalysisAssuranceStatus {
  return member(value, ['not_applicable', 'not_checked', 'unavailable', 'coverage_incomplete', 'passed', 'failed'])
    ? value : 'not_checked';
}

/** Explicit serialization only. These stored fields never issue current-run authority. */
export function copyAnalysisDeliveryFields(input: AnalysisDeliveryFields): AnalysisDeliveryFields {
  const output: AnalysisDeliveryFields = {};
  const intent = input.turnIntent;
  if (intent?.schemaVersion === 1 && member(intent.status, ['resolved', 'unavailable']) &&
      member(intent.source, ['semantic', 'fallback']) &&
      member(intent.taskKind, ['acknowledgement', 'fact', 'investigation', 'comparison']) &&
      member(intent.scope, ['bounded_question', 'scene_wide']) &&
      member(intent.recommendedComplexity, ['quick', 'full']) &&
      member(intent.deliverable, ['answer', 'report']) &&
      member(intent.evidenceAccess, ['existing_only', 'read_new'])) {
    output.turnIntent = {
      schemaVersion: 1, status: intent.status, source: intent.source,
      taskKind: intent.taskKind, sceneId: opaqueId(intent.sceneId), scope: intent.scope,
      recommendedComplexity: intent.recommendedComplexity, deliverable: intent.deliverable,
      evidenceAccess: intent.evidenceAccess, registryFingerprint: opaqueId(intent.registryFingerprint),
      ...(typeof intent.reason === 'string' ? {reason: intent.reason} : {}),
      ...(typeof intent.actualModel === 'string' ? {actualModel: intent.actualModel} : {}),
      ...(typeof intent.finishReason === 'string' ? {finishReason: intent.finishReason} : {}),
      ...(member(intent.unavailableReason, ['timeout', 'provider_error', 'invalid_configuration',
        'invalid_response', 'tool_use', 'incomplete_output', 'output_limit', 'prompt_unavailable', 'context_limit'])
        ? {unavailableReason: intent.unavailableReason} : {}),
    };
  }
  const completion = input.completion;
  if (completion?.schemaVersion === 1 && isProductionAgentRuntimeKind(completion.runtimeKind) &&
      member(completion.status, ['completed', 'incomplete', 'failed', 'cancelled', 'unknown'])) {
    output.completion = {
      schemaVersion: 1, ...candidate(completion), runtimeKind: completion.runtimeKind,
      status: completion.status,
      ...(member(completion.reason, ['output_limit', 'turn_limit', 'timeout', 'budget_limit', 'provider_error', 'cancelled'])
        ? {reason: completion.reason} : {}),
      ...(typeof completion.sdkFinishReason === 'string' ? {sdkFinishReason: completion.sdkFinishReason} : {}),
    };
  }
  if (member(input.outputOrigin, ['sdk_final', 'assistant_stream', 'evidence_rendered', 'runtime_fallback'])) {
    output.outputOrigin = input.outputOrigin;
  }
  const appendix = input.runtimeAppendix;
  if (appendix?.schemaVersion === 1 && appendix.origin === 'runtime_fallback' && appendix.sourceCandidate &&
      typeof appendix.text === 'string') {
    output.runtimeAppendix = {
      schemaVersion: 1, origin: 'runtime_fallback', sourceCandidate: candidate(appendix.sourceCandidate),
      text: appendix.text,
      ...(member(appendix.reason, ['output_limit', 'turn_limit', 'timeout', 'budget_limit', 'provider_error', 'cancelled'])
        ? {reason: appendix.reason} : {}),
    };
  }
  const assessment = input.reportAssessment;
  if (assessment?.schemaVersion === 1 && assessment.binding && Array.isArray(assessment.requirements) &&
      member(assessment.status, ['not_checked', 'unavailable', 'coverage_incomplete', 'checked'])) {
    const binding = assessment.binding;
    output.reportAssessment = {
      schemaVersion: 1, status: assessment.status,
      binding: {
        ...candidate(binding),
        conclusionContractFingerprint: fingerprint(binding.conclusionContractFingerprint),
        evidenceFingerprint: fingerprint(binding.evidenceFingerprint),
        requirementsFingerprint: fingerprint(binding.requirementsFingerprint),
        registryFingerprint: opaqueId(binding.registryFingerprint),
        intentFingerprint: fingerprint(binding.intentFingerprint),
        ...(binding.caseRetrievalFingerprint !== undefined
          ? {caseRetrievalFingerprint: fingerprint(binding.caseRetrievalFingerprint)} : {}),
      },
      requirements: assessment.requirements.map((raw: unknown) => {
        const requirement = record(raw) ? raw : {};
        return {
          requirementId: opaqueId(requirement.requirementId),
          applicability: member(requirement.applicability, ['applicable', 'not_applicable', 'unknown'])
            ? requirement.applicability : 'unknown',
          coverage: member(requirement.coverage, ['covered', 'missing', 'unknown']) ? requirement.coverage : 'unknown',
          ...(Array.isArray(requirement.contentLocations) ? {contentLocations: requirement.contentLocations
            .filter(contentLocation).map(({start, end}) => ({start, end}))} : {}),
          ...(Array.isArray(requirement.claimIds) ? {claimIds: requirement.claimIds.map(opaqueId).filter(Boolean)} : {}),
        };
      }),
    };
  }
  const assurance = input.deliveryAssurance;
  if (assurance?.schemaVersion === 1 && member(assurance.entry, ['runtime_draft', 'new_finalization', 'historical_restore'])) {
    output.deliveryAssurance = {
      schemaVersion: 1, entry: assurance.entry,
      completion: copyAssuranceStatus(assurance.completion), claims: copyAssuranceStatus(assurance.claims),
      source: copyAssuranceStatus(assurance.source), identity: copyAssuranceStatus(assurance.identity),
      report: copyAssuranceStatus(assurance.report),
    };
  }
  return preserveProjectedFieldOrder(input, output);
}

export function analysisProjectionChanged(before: unknown, after: unknown): boolean {
  return analysisDeliveryFingerprint(before) !== analysisDeliveryFingerprint(after);
}

/**
 * Redaction invalidates a binding; it cannot re-sign a different body. Empty
 * fingerprints deliberately represent no binding and remain empty on replay.
 */
export function projectPrivateAnalysisDelivery(
  input: AnalysisDeliveryFields & {conclusion?: string; conclusionContract?: unknown},
  projection: {conclusion: string; conclusionContract?: unknown; claimsChanged?: boolean;
    sourceChanged?: boolean; identityChanged?: boolean},
  projectText: (text: string) => string,
  options: {privateMetadata?: boolean} = {},
): AnalysisDeliveryFields {
  const output = copyAnalysisDeliveryFields(input);
  const bodyChanged = input.conclusion !== projection.conclusion;
  const contractChanged = analysisProjectionChanged(input.conclusionContract, projection.conclusionContract);
  const claimsChanged = bodyChanged || contractChanged || Boolean(projection.claimsChanged);
  if (output.turnIntent && options.privateMetadata !== false) {
    const {reason: _reason, actualModel: _model, finishReason: _finish, ...intent} = output.turnIntent;
    output.turnIntent = intent;
  }
  const intentChanged = analysisProjectionChanged(input.turnIntent, output.turnIntent);
  if (output.completion) {
    const {sdkFinishReason: _finishReason, ...safeCompletion} = output.completion;
    const completion = options.privateMetadata === false ? output.completion : safeCompletion;
    const bound = !bodyChanged && boundCandidate(completion, projection.conclusion);
    output.completion = {...completion,
      ...(!bound ? {conclusionFingerprint: '',
        status: completion.status === 'completed' ? 'unknown' as const : completion.status} : {})};
  }
  if (output.runtimeAppendix) {
    const appendix = output.runtimeAppendix;
    output.runtimeAppendix = {...appendix, text: projectText(appendix.text),
      sourceCandidate: {...appendix.sourceCandidate,
        ...(!boundCandidate(appendix.sourceCandidate, projection.conclusion) || bodyChanged
          ? {conclusionFingerprint: ''} : {})}};
  }
  const assessment = output.reportAssessment;
  const reportInvalid = analysisProjectionChanged(input.reportAssessment, assessment) || Boolean(assessment && (claimsChanged || intentChanged || projection.sourceChanged ||
    !boundCandidate(assessment.binding, projection.conclusion) ||
    assessment.binding.conclusionContractFingerprint !== analysisDeliveryFingerprint(projection.conclusionContract) ||
    assessment.binding.intentFingerprint !== analysisDeliveryFingerprint(output.turnIntent) ||
    Object.values(assessment.binding).some(value => value === '') ||
    assessment.requirements.some(requirement => requirement.contentLocations?.some(location => location.end > projection.conclusion.length))));
  if (assessment && reportInvalid) {
    const binding: AnalysisReportBinding = {...assessment.binding,
      conclusionFingerprint: '', conclusionContractFingerprint: '', evidenceFingerprint: '', intentFingerprint: ''};
    output.reportAssessment = {...assessment, binding,
      status: assessment.status === 'checked' ? 'coverage_incomplete' : assessment.status,
      requirements: assessment.requirements.map(requirement => ({
        requirementId: requirement.requirementId,
        applicability: requirement.applicability === 'not_applicable' ? 'unknown' : requirement.applicability,
        coverage: requirement.coverage === 'covered' ? 'unknown' : requirement.coverage,
      }))};
  }
  if (output.deliveryAssurance) {
    const assurance = output.deliveryAssurance;
    output.deliveryAssurance = {...assurance,
      completion: bodyChanged || !output.completion || !boundCandidate(output.completion, projection.conclusion)
        ? downgrade(assurance.completion) : assurance.completion,
      claims: claimsChanged ? downgrade(assurance.claims) : assurance.claims,
      source: claimsChanged || projection.sourceChanged ? downgrade(assurance.source) : assurance.source,
      identity: projection.identityChanged ? downgrade(assurance.identity) : assurance.identity,
      report: reportInvalid || claimsChanged || intentChanged ? downgrade(assurance.report) : assurance.report};
  }
  return output;
}

/** Legacy source metadata is copied safely, without claim verification or prose rewriting. */
export function projectStoredConclusionSourceMetadata<T>(contract: T, actualDecision?: unknown): T {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
  const record = contract as Record<string, unknown>;
  if (!['sourceUseDecision', 'sourceReferences', 'sourceClaimBindings'].some(key => key in record)) return contract;
  const decision = sanitizeSourceUseDecision(actualDecision ?? record.sourceUseDecision);
  const {sourceUseDecision: _decision, sourceReferences: _refs, sourceClaimBindings: _bindings, ...rest} = record;
  if (!decision) return rest as T;
  const aliases = new Map<string, string>();
  for (const reference of Array.isArray(record.sourceReferences) ? record.sourceReferences : []) {
    const safe = sanitizeSourceReference(reference);
    if (safe && reference && typeof reference === 'object' && typeof reference.id === 'string') {
      aliases.set(reference.id, safe.id);
    }
  }
  const references = decision.references.filter(reference => decision.codeAwareMode !== 'metadata_only' ||
    reference.lookupKind === 'metadata' || reference.lookupKind === 'graph');
  const allowed = new Set(references.map(reference => reference.id));
  const bindings = sanitizeSourceClaimBindings(record.sourceClaimBindings, {referenceIdAliases: aliases})
    .filter(binding => binding.sourceReferenceIds.every(id => allowed.has(id)));
  return preserveProjectedFieldOrder(contract, {...rest, sourceUseDecision: {...decision, references}, sourceReferences: references,
    sourceClaimBindings: bindings} as T);
}
