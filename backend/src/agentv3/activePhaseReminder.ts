// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisPlanV3} from './types';
import type {SceneType} from './sceneClassifier';
import type {ReadonlyStrategyRegistrySnapshot} from '../services/selfEvolution/effectiveRuntimeRegistryContext';

export const REMINDER_PREFIX = '\n\n[计划提醒]';

/** Display only explicitly active plan state; strategy prose cannot add obligations. */
export function buildActivePhaseReminder(
  plan: AnalysisPlanV3 | null | undefined,
  _sceneType?: SceneType,
  _strategyRegistry?: ReadonlyStrategyRegistrySnapshot,
): string {
  const active = plan?.phases.filter(phase => phase.status === 'in_progress') ?? [];
  if (active.length !== 1) return '';
  return `${REMINDER_PREFIX} ${active[0].id}: ${active[0].goal}`.slice(0, 200);
}
