// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  parseClaimSemanticsDeclaration,
  type ConclusionContract,
  type ConclusionContractClaimItem,
} from '../../agent/core/conclusionContract';
import type {
  ClaimVerificationClaimResult,
  ClaimVerificationIssue,
  ClaimVerificationResult,
  DeterministicClaimProof,
} from '../../types/claimVerification';
import {isSourceClaimBindingsDeclaration, sanitizeSourceUseDecision, type SourceUseDecisionV1} from './sourceUseDecision';

export interface SourceLocationProofInput {
  contract?: ConclusionContract | null;
  /**
   * The frozen ledger from the current private finalization context. A declaration's
   * sourceUseDecision is never authority. The caller must bind the resulting verdict
   * to the same candidate, authorization selection, contract and ledger receipt.
   */
  sourceUse?: SourceUseDecisionV1;
  draft: ClaimVerificationResult;
}

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function sourceProof(status: DeterministicClaimProof['status'], reason: string): DeterministicClaimProof {
  // Source locations never issue Trace evidence or anchors. The frozen ledger
  // retains the actual reference metadata independently of optional claim bindings.
  return {kind: 'source_location', status, reason, anchorIds: [], evidenceRefIds: []};
}

function proveLocation(
  claim: ConclusionContractClaimItem,
  contract: ConclusionContract,
  sourceUse: SourceUseDecisionV1 | undefined,
): DeterministicClaimProof {
  const reject = (reason: string) => sourceProof('rejected', reason);
  const candidate = (reason: string) => sourceProof('candidate', reason);
  if (contract.bindingEligibility !== 'eligible') return reject('source_location_binding_ineligible');
  if (!claim.id || contract.claims?.filter(item => item.id === claim.id).length !== 1) {
    return reject('source_location_claim_identity_invalid');
  }
  if (hasOwn(claim, 'rawSemantics') || hasOwn(claim, 'rawReferences') || claim.semanticsParseIssues?.length) {
    return reject('source_location_declaration_invalid');
  }
  const semantics = parseClaimSemanticsDeclaration(claim.semantics).semantics;
  if (!semantics?.source) return candidate('source_location_declaration_missing');
  if ((claim.kind !== 'identity' && claim.kind !== 'categorical') ||
    semantics.polarity !== 'affirmed' || semantics.discourse !== 'asserted' ||
    semantics.quantifier !== 'one' || semantics.modality !== 'certain' ||
    semantics.scope.population !== 'codebase' || semantics.conditions?.length ||
    semantics.numeric !== undefined || semantics.scope.timeRangeNs !== undefined) {
    return candidate('source_location_proposition_unsupported');
  }
  if (claim.references.length || claim.artifactRefs?.length || claim.relationRefs?.length ||
    semantics.scope.subjectRefs?.length || semantics.scope.objectRefs?.length) {
    return candidate('source_location_trace_references_not_permitted');
  }
  const rootBindings = hasOwn(contract, 'sourceClaimBindings') ? contract.sourceClaimBindings : undefined;
  if (hasOwn(contract, 'sourceClaimBindings') && !isSourceClaimBindingsDeclaration(rootBindings)) {
    return reject('source_location_binding_invalid');
  }
  const bindings = rootBindings?.filter(binding => binding.claimId === claim.id) ?? [];
  const binding = bindings[0];
  if (bindings.length > 0 && (bindings.length !== 1 || binding.sourceReferenceIds.length !== 1 ||
    binding.sourceReferenceIds[0] !== semantics.source.sourceReferenceId ||
    binding.traceEvidenceRefIds.length !== 0)) {
    return reject('source_location_binding_invalid');
  }
  const decision = sanitizeSourceUseDecision(sourceUse);
  if (!decision) return candidate('source_location_current_ledger_unavailable');
  const originalReferences = (sourceUse?.references ?? []).filter(reference => reference?.id === semantics.source!.sourceReferenceId);
  if (originalReferences.length !== 1) return reject('source_location_reference_not_returned');
  const original = originalReferences[0];
  if (!decision.selectedCodebaseIds.includes(original.codebaseId) ||
    !decision.queriedCodebaseIds.includes(original.codebaseId)) {
    return reject('source_location_reference_outside_current_query');
  }
  const reference = decision.references.find(item => item.id === original.id);
  if (!reference || reference.filePath !== original.filePath ||
    reference.lineRange?.start !== original.lineRange?.start ||
    reference.lineRange?.end !== original.lineRange?.end) {
    return reject('source_location_reference_invalid');
  }
  if (!reference.lineRange) return candidate('source_location_reference_range_unavailable');
  if (semantics.source.filePath !== reference.filePath ||
    semantics.source.lineRange.start !== reference.lineRange.start ||
    semantics.source.lineRange.end !== reference.lineRange.end) {
    return reject('source_location_tuple_mismatch');
  }
  return sourceProof('proved', 'source_location_snapshot_proved');
}

function hasPriorError(result: ClaimVerificationClaimResult, issues: readonly ClaimVerificationIssue[]): boolean {
  return result.status === 'unsupported' || result.deterministicProof?.status === 'rejected' ||
    issues.some(issue => issue.severity === 'error' && (!issue.claimId || issue.claimId === result.claimId)) ||
    [...(result.referenceResults ?? []), ...(result.referenceCells ?? [])].some(reference =>
      reference.status !== 'matched' && reference.status !== 'not_checked');
}

/** Add a finite location draft; only the later complete semantic join may verify a claim. */
export function applySourceLocationProofs(input: SourceLocationProofInput): ClaimVerificationResult {
  const {contract, draft} = input;
  if (!contract || draft.schemaVersion !== 'claim_verifier@2') return draft;
  const proofs = new Map<string, DeterministicClaimProof>();
  const claimResults = draft.claimResults.map(result => {
    const declarations = contract.claims?.filter(claim => claim.id === result.claimId) ?? [];
    const claim = declarations.find(item => item.semantics?.predicate === 'source.location');
    if (!claim || hasPriorError(result, draft.issues)) return result;
    const prior = result.deterministicProof;
    if (prior?.kind !== 'source_location' || prior.status !== 'not_checked' ||
      prior.reason !== 'source_evidence_required') return result;
    const duplicateDraft = draft.claimResults.filter(item => item.claimId === result.claimId).length !== 1;
    const hasTraceDraft = Boolean(result.referenceResults?.length || result.referenceCells?.length ||
      prior.anchorIds.length || prior.evidenceRefIds.length);
    const proof = duplicateDraft
      ? sourceProof('rejected', 'source_location_claim_identity_invalid')
      : hasTraceDraft ? sourceProof('candidate', 'source_location_trace_references_not_permitted')
      : proveLocation(claim, contract, input.sourceUse);
    proofs.set(result.claimId, proof);
    return {...result, status: proof.status === 'rejected' ? 'unsupported' as const : 'partial' as const,
      deterministicProof: proof,
      propositionCoverage: {
        status: proof.status === 'proved' ? 'complete' as const : 'none' as const,
        covered: proof.status === 'proved'
          ? ['predicate', 'polarity', 'discourse', 'quantifier', 'modality', 'conditions', 'scope', 'source'] : [],
        uncovered: proof.status === 'proved' ? [] : ['typed_proposition'],
        reason: proof.reason,
      }};
  });
  if (!proofs.size) return draft;
  const issues = [...draft.issues];
  for (const [claimId, proof] of proofs) {
    if (proof.status === 'proved') continue;
    issues.push({claimId, severity: proof.status === 'rejected' ? 'error' : 'warning', code: proof.reason,
      message: `source location proof: ${proof.reason}`});
  }
  const unsupportedClaimCount = claimResults.filter(claim => claim.status === 'unsupported').length;
  const failed = draft.status === 'failed' || unsupportedClaimCount > 0 || issues.some(issue => issue.severity === 'error');
  return {...draft, status: failed ? 'failed' : 'partial', passed: false,
    checkedClaimCount: claimResults.length, unsupportedClaimCount, claimResults, issues};
}
