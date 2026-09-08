// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  analysisDeliveryFingerprint,
  reportRequirementsFingerprint,
  type AnalysisCaseRetrievalState,
  type AnalysisDeliveryContext,
} from '../../types/analysisDelivery';
import {assessFinalReportContract, assessFinalReportContractCompleteness} from '../finalReportContractGate';

const conclusion = 'Current trace evidence is summarized here.';

function context(retrieval: AnalysisCaseRetrievalState): Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
  const acceptedCandidate = {candidateRef: 'candidate-case', runId: 'run-case', attemptId: 'attempt-case',
    conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
  const turnIntent = {schemaVersion: 1 as const, status: 'resolved' as const, source: 'semantic' as const,
    registryFingerprint: 'registry-case', taskKind: 'investigation' as const, sceneId: 'scrolling',
    scope: 'scene_wide' as const, recommendedComplexity: 'full' as const,
    deliverable: 'report' as const, evidenceAccess: 'read_new' as const};
  const reportRequirements = {sceneId: 'scrolling', registryFingerprint: 'registry-case', requirements: [{
    id: 'case_recommendations', label: 'Similar cases', required: true,
    description: 'Cite a curated case only when retrieval found a strong evidence match.',
    condition: {kind: 'strong_case_retrieval' as const},
  }]};
  return {entry: 'new_finalization', acceptedCandidate, turnIntent, reportRequirements, caseRetrieval: retrieval,
    evidenceFingerprint: 'evidence-case',
    reportAssessment: {schemaVersion: 1, status: 'checked', binding: {...acceptedCandidate,
      registryFingerprint: 'registry-case', intentFingerprint: analysisDeliveryFingerprint(turnIntent),
      evidenceFingerprint: 'evidence-case', conclusionContractFingerprint: analysisDeliveryFingerprint(undefined),
      requirementsFingerprint: reportRequirementsFingerprint(reportRequirements),
      caseRetrievalFingerprint: analysisDeliveryFingerprint(retrieval),
    }, requirements: [{requirementId: 'case_recommendations', applicability: 'not_applicable', coverage: 'unknown'}]}};
}

describe('final report contract case recommendations gate', () => {
  it('does not turn arbitrary result fields or query words into applicability proof', () => {
    const input = {conclusion, query: 'Find strong similar cases', sceneType: 'scrolling',
      caseRecommendations: [{caseId: 'case-provider', matchStrength: 'strong'}]};
    expect(assessFinalReportContract(input).status).toBe('not_checked');
    expect(assessFinalReportContractCompleteness(input)).toBeUndefined();
  });

  it('does not require a conditional case citation after checked retrieval found none', () => {
    const current = context({status: 'checked', recommendations: []});
    expect(assessFinalReportContract({conclusion, context: current}).status).toBe('not_applicable');
  });

  it('requires a conditional citation for an actual strong retrieval hit', () => {
    const current = context({status: 'checked', recommendations: [{caseId: 'case-1', title: 'Curated case',
      matchStrength: 'strong', evidenceRefs: ['data:case-match'], recommendations: {app: [], oem: []}}]});
    // The semantic reviewer cannot waive a condition proved true by this run.
    expect(assessFinalReportContract({conclusion, context: current}).status).toBe('coverage_incomplete');
    current.reportAssessment!.requirements = [{requirementId: 'case_recommendations',
      applicability: 'applicable', coverage: 'missing'}];
    expect(assessFinalReportContractCompleteness({conclusion, context: current})?.missingLabels)
      .toEqual(['Similar cases']);
  });

  it('does not treat unavailable or unchecked retrieval as a checked empty result', () => {
    for (const status of ['unavailable', 'not_checked'] as const) {
      const current = context({status, recommendations: []});
      expect(assessFinalReportContract({conclusion, context: current}).status).toBe('coverage_incomplete');
    }
  });

  it('invalidates applicability when its retrieval evidence changes', () => {
    const current = context({status: 'checked', recommendations: []});
    current.caseRetrieval = {status: 'unavailable', recommendations: []};
    expect(assessFinalReportContract({conclusion, context: current}).status).toBe('not_checked');
  });
});
