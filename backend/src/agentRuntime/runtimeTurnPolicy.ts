// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveTurnIntentComplexity, type AnalysisTurnIntent} from './analysisTurnIntent';

export interface RuntimeTurnPolicy {
  readonly budgetMode: 'quick' | 'full';
  readonly onDemandContext: boolean;
  /** Additional restriction only; all existing authorization checks still apply. */
  readonly allowNewEvidence: boolean;
  readonly allowAutomaticPrefetch: boolean;
  readonly requiresReport: boolean;
}

/** No prose, phase name or tool selection is an input to execution policy. */
export function resolveRuntimeTurnPolicy(
  intent: AnalysisTurnIntent,
  requestedMode: 'auto' | 'fast' | 'full' = 'auto',
): RuntimeTurnPolicy {
  const onDemandContext = intent.status === 'unavailable' || intent.scope === 'bounded_question';
  const allowNewEvidence = intent.evidenceAccess === 'read_new';
  return Object.freeze({
    budgetMode: resolveTurnIntentComplexity(intent, requestedMode),
    onDemandContext,
    allowNewEvidence,
    allowAutomaticPrefetch: !onDemandContext && allowNewEvidence,
    requiresReport: intent.deliverable === 'report',
  });
}
