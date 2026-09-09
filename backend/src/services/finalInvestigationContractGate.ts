// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {analysisDeliveryFingerprint, sameAnalysisCandidate,
  type AnalysisAssuranceStatus, type AnalysisDeliveryContext} from '../types/analysisDelivery';
import type {AnalysisInvestigationRequirement} from '../types/analysisInvestigation';
import type {FinalInvestigationAssessment, InvestigationAcquisitionStatus,
  InvestigationContentAssessment, InvestigationRequirementAssessment} from '../types/analysisInvestigationAssessment';
import {investigationEvidenceFingerprint, type InvestigationEvidenceSnapshot} from './evidence/investigationEvidenceLedger';

export interface FinalInvestigationContractResult {
  status: AnalysisAssuranceStatus;
  evidenceStatus: AnalysisAssuranceStatus;
  requirements: readonly InvestigationRequirementAssessment[];
  acceptedAssessment?: FinalInvestigationAssessment;
}

/** Counts only selected, producer-bound metrics; collection does not establish causality. */
export function assessInvestigationAcquisition(requirement: AnalysisInvestigationRequirement,
  row: InvestigationContentAssessment, ledger: InvestigationEvidenceSnapshot | undefined): InvestigationAcquisitionStatus {
  if (row.applicability === 'not_applicable') return 'not_applicable';
  if (row.applicability !== 'applicable') return 'unknown';
  // Methodology/recommendation obligations are checked as content and by the
  // existing claim verifier. They do not introduce a second acquisition proof.
  if (!requirement.evidenceMetrics?.length) return 'not_applicable';
  if (!ledger) return 'unknown';
  if (!row.evidenceRecordIds.length) return 'not_checked';
  if (new Set(row.evidenceRecordIds).size !== row.evidenceRecordIds.length) return 'unknown';
  const records = row.evidenceRecordIds.map(id => ledger.records.find(record => record.recordId === id));
  if (records.some(record => !record || record.domain !== requirement.domain)) return 'unknown';
  if (row.scopeMatch !== 'matched') return 'insufficient';
  const referenced = records.filter(record => record !== undefined);
  if (referenced.some(record => ledger.incompleteCaptureIds?.includes(record.captureId))) return 'unknown';
  // Coverage belongs to the producer's requested population. Selecting one good
  // CPU/task cannot hide missing siblings in the same capture and window.
  const selected = ledger.records.filter(record => referenced.some(reference =>
    record.captureId === reference.captureId && record.domain === reference.domain && record.traceSide === reference.traceSide &&
    record.windowId === reference.windowId &&
    record.metricId === reference.metricId && String(record.window.start) === String(reference.window.start) &&
    String(record.window.end) === String(reference.window.end)));
  if (requirement.evidenceMetrics?.some(metric => !selected.some(record => record.metricId === metric))) return 'insufficient';
  if (selected.some(record => record.status === 'unknown' || record.origin === 'unknown')) return 'unknown';
  if (selected.some(record => record.status !== 'observed') || ledger.issues.includes('ledger_record_budget_exhausted')) return 'insufficient';
  return 'observed';
}

/** Bound content coverage and acquisition remain independent of report/completion/claims. */
export function assessFinalInvestigationContract(input: {
  conclusion: string; conclusionContract?: unknown; context?: AnalysisDeliveryContext;
}): FinalInvestigationContractResult {
  const empty = (status: AnalysisAssuranceStatus): FinalInvestigationContractResult =>
    ({status, evidenceStatus: status, requirements: []});
  const context = input.context;
  if (!context || context.entry === 'historical_restore') return empty('not_checked');
  const pin = context.investigationRequirements;
  const intent = context.turnIntent;
  if (!pin || !intent || intent.status !== 'resolved' || pin.registryFingerprint !== intent.registryFingerprint ||
    pin.sceneId !== intent.sceneId) return empty('not_checked');
  if (pin.status === 'not_applicable') return empty('not_applicable');
  if (pin.status !== 'resolved' || !pin.requirements.length) return empty('not_checked');
  const assessment = context.investigationAssessment;
  const ledger = context.investigationEvidence;
  if (!assessment || assessment.schemaVersion !== 1 ||
    !sameAnalysisCandidate(assessment.binding, context.acceptedCandidate, input.conclusion) ||
    assessment.binding.registryFingerprint !== pin.registryFingerprint ||
    assessment.binding.intentFingerprint !== analysisDeliveryFingerprint(intent) ||
    assessment.binding.requirementsFingerprint !== analysisDeliveryFingerprint(pin) ||
    assessment.binding.conclusionContractFingerprint !== analysisDeliveryFingerprint(input.conclusionContract) ||
    !context.evidenceFingerprint || assessment.binding.evidenceFingerprint !== context.evidenceFingerprint ||
    assessment.binding.ledgerFingerprint !== analysisDeliveryFingerprint(ledger ?? null) ||
    (assessment.evidenceRecords && (assessment.binding.evidenceRecordsFingerprint !== analysisDeliveryFingerprint(assessment.evidenceRecords) ||
      assessment.binding.evidenceRecordsFingerprint !== analysisDeliveryFingerprint(ledger?.records ?? []))) ||
    (ledger && ledger.fingerprint !== investigationEvidenceFingerprint(ledger))) return empty('not_checked');
  if (assessment.status === 'not_checked' || assessment.status === 'unavailable') {
    return {...empty(assessment.status), acceptedAssessment: assessment};
  }
  const ids = new Set(pin.requirements.map(requirement => requirement.id));
  if (ids.size !== pin.requirements.length || assessment.requirements.length !== ids.size ||
    new Set(assessment.requirements.map(row => row.requirementId)).size !== ids.size ||
    assessment.requirements.some(row => !ids.has(row.requirementId))) return empty('not_checked');
  const requirements = pin.requirements.map(requirement => {
    const row = assessment.requirements.find(item => item.requirementId === requirement.id)!;
    const validLocations = row.contentLocations.length > 0 && row.contentLocations.every(location =>
      Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) && location.start >= 0 &&
      location.end > location.start && location.end <= input.conclusion.length);
    const fixedApplicable = intent.scope === 'scene_wide' && !requirement.condition;
    const applicability = fixedApplicable ? 'applicable' : row.applicability;
    const acquisition = assessInvestigationAcquisition(requirement, {...row, applicability}, ledger);
    const evidenceConsistent = row.evidenceStatus === acquisition;
    const coverage = row.coverage === 'covered' && (!validLocations || !evidenceConsistent) ? 'unknown' : row.coverage;
    return {...row, domain: requirement.domain, applicability,
      ...(row.applicability === 'not_applicable' && !validLocations
        ? {applicability: 'unknown' as const} : {}),
      coverage, acquisition};
  });
  const required = requirements.filter(row => pin.requirements.find(definition => definition.id === row.requirementId)!.required);
  const active = required.filter(row => row.applicability === 'applicable');
  const evidenceActive = active.filter(row => row.acquisition !== 'not_applicable');
  const unknown = required.some(row => row.applicability === 'unknown') || assessment.status === 'coverage_incomplete';
  const status: AnalysisAssuranceStatus = unknown || active.some(row => row.coverage === 'unknown') ? 'coverage_incomplete' :
    active.some(row => row.coverage === 'missing') ? 'failed' : !active.length ? 'not_applicable' : 'passed';
  const evidenceStatus: AnalysisAssuranceStatus = unknown ? 'coverage_incomplete' : !evidenceActive.length ? 'not_applicable' :
    evidenceActive.every(row => row.acquisition === 'observed') ? 'passed' :
    evidenceActive.every(row => row.acquisition === 'not_checked') ? 'not_checked' :
    evidenceActive.some(row => row.acquisition === 'failed') ? 'failed' : 'coverage_incomplete';
  return {status, evidenceStatus, requirements, acceptedAssessment: {...assessment, requirements}};
}
