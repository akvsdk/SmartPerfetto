// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import type {AnalysisReportBinding} from './analysisDelivery';
import type {InvestigationEvidenceRecord} from '../services/evidence/investigationEvidenceLedger';

/** Content interpretation is separate from the producer's acquisition record. */
export interface InvestigationContentAssessment {
  requirementId: string;
  applicability: 'applicable' | 'not_applicable' | 'unknown';
  coverage: 'covered' | 'missing' | 'unknown';
  contentLocations: readonly {start: number; end: number}[];
  evidenceRecordIds: readonly string[];
  scopeMatch: 'matched' | 'mismatched' | 'unknown';
  /** What the answer says about the evidence; the gate checks it against capture. */
  evidenceStatus: InvestigationAcquisitionStatus;
}

export type InvestigationAcquisitionStatus =
  | 'observed' | 'insufficient' | 'not_checked' | 'failed' | 'not_applicable' | 'unknown';

export interface InvestigationRequirementAssessment extends InvestigationContentAssessment {
  domain: string;
  acquisition: InvestigationAcquisitionStatus;
}

export interface FinalInvestigationAssessment {
  schemaVersion: 1;
  binding: AnalysisReportBinding & {ledgerFingerprint: string; evidenceRecordsFingerprint?: string};
  status: 'not_checked' | 'unavailable' | 'coverage_incomplete' | 'checked';
  requirements: readonly InvestigationRequirementAssessment[];
  /** Full retained producer records, including dimensions not used by final claims.
   * This serialized projection cannot recreate a live execution witness. */
  evidenceRecords?: readonly InvestigationEvidenceRecord[];
}
