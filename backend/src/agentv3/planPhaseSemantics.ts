// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {phaseMatchesCall, type AnalysisPlanV3, type PlanPhase, type PlanSkipDisposition, type ToolCallRecord} from './types';

export interface PlanPhaseCallResolution {
  phase?: PlanPhase;
  attribution: 'explicit' | 'unique' | 'unknown_phase' | 'unmatched' | 'ambiguous';
}

/** Dispatch ownership is structural; outcome and phase prose cannot select a phase. */
export function resolvePlanPhaseForCall(
  plan: AnalysisPlanV3,
  call: ToolCallRecord,
  explicitPhaseId?: string,
): PlanPhaseCallResolution {
  if (explicitPhaseId !== undefined) {
    const matches = plan.phases.filter(phase => phase.id === explicitPhaseId);
    if (matches.length !== 1) return {attribution: matches.length ? 'ambiguous' : 'unknown_phase'};
    return phaseMatchesCall(matches[0], call)
      ? {phase: matches[0], attribution: 'explicit'}
      : {attribution: 'unmatched'};
  }
  const matches = plan.phases.filter(phase => phaseMatchesCall(phase, call));
  return matches.length === 1
    ? {phase: matches[0], attribution: 'unique'}
    : {attribution: matches.length ? 'ambiguous' : 'unmatched'};
}

export function isPlanSkipDisposition(value: unknown): value is PlanSkipDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const disposition = value as Record<string, unknown>;
  return typeof disposition.kind === 'string' &&
    ['not_applicable', 'evidence_unavailable', 'deferred'].includes(disposition.kind) &&
    (disposition.failureToolCallIds === undefined ||
      (Array.isArray(disposition.failureToolCallIds) && disposition.failureToolCallIds.every(id =>
        typeof id === 'string' && id.trim().length > 0)));
}

export function hasValidPlanSkipDisposition(plan: AnalysisPlanV3, phase: PlanPhase): boolean {
  if (!isPlanSkipDisposition(phase.skipDisposition)) return false;
  return (phase.skipDisposition.failureToolCallIds ?? []).every(id =>
    (plan.toolCallLog ?? []).some(call => call.toolCallId === id && call.success === false && call.matchedPhaseId === phase.id));
}
