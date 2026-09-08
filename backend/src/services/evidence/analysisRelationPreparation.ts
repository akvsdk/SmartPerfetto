// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {DataEnvelope} from '../../types/dataContract';
import type {EvidenceRelationCandidateV1} from '../../types/evidenceContract';
import {
  runClaimVerification,
  type ClaimVerificationRunnerInput,
  type ClaimVerificationRunnerResult,
} from '../verifier/claimVerificationRunner';
import {produceAnrRelationCandidates} from './anrRelationCandidateProducer';
import {produceInputRelationCandidates} from './inputRelationCandidateProducer';
import {bindRelationCandidatesToClaims} from './relationCandidateClaimBinder';
import {produceScrollingRelationCandidates} from './scrollingRelationCandidateProducer';
import {produceStartupRelationCandidates} from './startupRelationCandidateProducer';

export interface AnalysisRelationPreparationInput {
  conclusionContract?: ConclusionContract | null;
  dataEnvelopes?: DataEnvelope[];
  relationCandidates?: readonly EvidenceRelationCandidateV1[];
}

export interface AnalysisRelationPreparationResult {
  conclusionContract?: ConclusionContract | null;
  relationCandidates?: EvidenceRelationCandidateV1[];
  relationActivationClaimIds?: string[];
}

export function prepareAnalysisRelations(
  input: AnalysisRelationPreparationInput,
): AnalysisRelationPreparationResult {
  const dataEnvelopes = input.dataEnvelopes || [];
  const relationCandidates = [
    ...(input.conclusionContract?.relationProposals ?? []),
    ...(input.relationCandidates ?? []),
    ...produceStartupRelationCandidates(dataEnvelopes),
    ...produceScrollingRelationCandidates(dataEnvelopes),
    ...produceInputRelationCandidates(dataEnvelopes),
    ...produceAnrRelationCandidates(dataEnvelopes),
  ];
  if (relationCandidates.length === 0) {
    return {conclusionContract: input.conclusionContract};
  }
  if (!input.conclusionContract) {
    return {
      conclusionContract: input.conclusionContract,
      relationCandidates,
      relationActivationClaimIds: [],
    };
  }
  return {
    ...bindRelationCandidatesToClaims(input.conclusionContract, relationCandidates),
    relationCandidates,
  };
}

export function runPreparedAnalysisClaimVerification(
  input: ClaimVerificationRunnerInput,
): ClaimVerificationRunnerResult {
  // Prepared evidence is bound to the exact contract and relation list. Even an
  // invalid supplied handle belongs to the runner's rejection path, not a fallback.
  if (input.preparedEvidence !== undefined) return runClaimVerification(input);
  const prepared = prepareAnalysisRelations({
    conclusionContract: input.conclusionContract,
    dataEnvelopes: input.dataEnvelopes,
    relationCandidates: input.relationCandidates,
  });
  return runClaimVerification({...input, ...prepared});
}
