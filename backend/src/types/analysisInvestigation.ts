// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisTurnIntent} from '../agentRuntime/analysisTurnIntent';

/** Strategy-owned evidence obligations, independent of report presentation. */
export interface AnalysisInvestigationRequirement {
  id: string;
  domain: string;
  description: string;
  required: boolean;
  condition?: {kind: 'semantic'; description: string};
  profileId?: string;
  profileVersion?: number;
  /** Trusted producer metric IDs, never inferred from column names or prose.
   * Absent: content obligation uses existing claim verification, without a
   * separate acquisition verdict. */
  evidenceMetrics?: readonly string[];
}

export interface AnalysisInvestigationContract {
  schemaVersion: 1;
  profileRefs: Array<{id: string; version: number}>;
  requirements: AnalysisInvestigationRequirement[];
  notApplicableReason?: string;
}

export interface ResolvedAnalysisInvestigationRequirements {
  schemaVersion: 1;
  status: 'resolved' | 'not_applicable' | 'not_checked';
  reason?: string;
  sceneId?: string;
  registryFingerprint?: string;
  contractFingerprint?: string;
  scope?: AnalysisTurnIntent['scope'];
  evidenceAccess?: AnalysisTurnIntent['evidenceAccess'];
  requirements: readonly AnalysisInvestigationRequirement[];
  legacyRequirements: readonly string[];
}
