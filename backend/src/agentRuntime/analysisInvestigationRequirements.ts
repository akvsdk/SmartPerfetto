// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisTurnIntent} from './analysisTurnIntent';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';
import type {ResolvedAnalysisInvestigationRequirements} from '../types/analysisInvestigation';
import {canonicalContentHash} from '../services/selfEvolution/canonicalJson';

/** Pure shared prompt/finalization resolver: reads only this run's pinned registry. */
export function resolveAnalysisInvestigationRequirements(input: {
  intent?: AnalysisTurnIntent;
  strategyRegistry?: ReadonlyStrategyRegistrySnapshot;
}): ResolvedAnalysisInvestigationRequirements {
  const {intent, strategyRegistry: registry} = input;
  const result: ResolvedAnalysisInvestigationRequirements = {
    schemaVersion: 1, status: 'not_checked', requirements: [], legacyRequirements: [],
    ...(intent ? {sceneId: intent.sceneId, registryFingerprint: intent.registryFingerprint,
      scope: intent.scope, evidenceAccess: intent.evidenceAccess} : {}),
  };
  if (!intent || !registry) return {...result, reason: 'missing_intent_or_registry'};
  if (intent.registryFingerprint !== registry.registryFingerprint) {
    return {...result, reason: 'registry_fingerprint_mismatch'};
  }
  if (intent.status !== 'resolved') return {...result, reason: 'intent_unavailable'};
  if (intent.taskKind === 'fact' || intent.taskKind === 'acknowledgement') {
    return {...result, status: 'not_applicable', reason: 'task_kind_exempt'};
  }
  const strategy = registry.getStrategy(intent.sceneId);
  if (!strategy) return {...result, reason: 'strategy_unavailable'};
  const contract = strategy.investigationContract;
  result.legacyRequirements = strategy.investigationRequirements ?? [];
  if (!contract) return {...result, reason: result.legacyRequirements.length
    ? 'legacy_requirements_only' : 'contract_unavailable'};
  result.contractFingerprint = canonicalContentHash(contract);
  if (contract.notApplicableReason) return {...result, status: 'not_applicable', reason: contract.notApplicableReason};
  if (strategy.strategyKind === 'contract_only') return {...result, reason: 'contract_only_strategy'};
  if (!contract.requirements.length) return {...result, reason: 'requirements_unavailable'};
  return {...result, status: 'resolved', requirements: contract.requirements};
}
