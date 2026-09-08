// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../agent/core/orchestratorTypes';

export type AnalysisMode = NonNullable<AnalysisOptions['analysisMode']>;

export interface AnalysisModeContext {
  referenceTraceId?: string;
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
  assistantSurface?: AnalysisOptions['assistantSurface'];
}

/** Budget preference is independent of evidence capabilities and authorization. */
export function resolveEffectiveAnalysisMode(
  requested: AnalysisOptions['analysisMode'],
  context: AnalysisModeContext,
): AnalysisMode {
  return requested ?? (context.assistantSurface === 'conversation' ? 'fast' : 'auto');
}

export interface SmartDeepDiveAnalysisContext {
  analysisMode: 'fast' | 'full';
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
  knowledgeSourceIds?: readonly string[];
}

/**
 * Preserve the exact private-context allowlists when Smart Profile hands its
 * selected scenes to the agent runtime. Smart deep dives default to full;
 * an explicit fast request remains fast with the same authorized capabilities.
 */
export function buildSmartDeepDiveAnalysisContext(
  requested: AnalysisOptions['analysisMode'],
  context: AnalysisModeContext,
): SmartDeepDiveAnalysisContext {
  const effectiveMode = resolveEffectiveAnalysisMode(requested ?? 'full', context);
  return {
    analysisMode: effectiveMode === 'fast' ? 'fast' : 'full',
    ...(context.codeAwareMode ? {codeAwareMode: context.codeAwareMode} : {}),
    ...(context.codebaseIds ? {codebaseIds: context.codebaseIds} : {}),
    ...(context.knowledgeSourceIds ? {knowledgeSourceIds: context.knowledgeSourceIds} : {}),
  };
}
