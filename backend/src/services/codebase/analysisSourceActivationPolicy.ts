// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {loadStrategyYaml} from '../../agentv3/strategyLoader';

const POLICY_ASSET_NAME = 'analysis-source-activation-policy';
const POLICY_SCHEMA_VERSION = 'analysis_source_activation_policy@2' as const;

export type AnalysisSourceActivation =
  | 'dormant'
  | 'bounded_explicit'
  | 'deep_supplement';

export interface AnalysisSourceBudget {
  readonly maxSearchCalls: number;
  readonly maxReadCalls: number;
  readonly maxDurationMs: number;
}

export interface AnalysisSourceActivationPolicy {
  readonly schemaVersion: typeof POLICY_SCHEMA_VERSION;
  readonly boundedExplicit: AnalysisSourceBudget;
  readonly safeReplay: {
    readonly maxTurns: number;
    readonly maxCharsPerEntry: number;
  };
}

interface AnalysisSourcePolicyInput {
  query: string;
  analysisMode?: AnalysisOptions['analysisMode'];
  hasAuthorizedCodebase?: boolean;
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function positiveInteger(value: unknown, errorCode: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(errorCode);
  return Number(value);
}

export function parseAnalysisSourceActivationPolicy(value: unknown): AnalysisSourceActivationPolicy {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema_version', 'bounded_explicit', 'safe_replay']) ||
    value.schema_version !== POLICY_SCHEMA_VERSION
  ) {
    throw new Error('analysis_source_activation_policy_invalid_root');
  }
  if (
    !isRecord(value.bounded_explicit) ||
    !exactKeys(value.bounded_explicit, [
      'max_search_calls',
      'max_read_calls',
      'max_duration_ms',
    ])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_budget');
  }
  if (
    !isRecord(value.safe_replay) ||
    !exactKeys(value.safe_replay, ['max_turns', 'max_chars_per_entry'])
  ) {
    throw new Error('analysis_source_activation_policy_invalid_safe_replay');
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    boundedExplicit: Object.freeze({
      maxSearchCalls: positiveInteger(
        value.bounded_explicit.max_search_calls,
        'analysis_source_activation_policy_invalid_budget',
      ),
      maxReadCalls: positiveInteger(
        value.bounded_explicit.max_read_calls,
        'analysis_source_activation_policy_invalid_budget',
      ),
      maxDurationMs: positiveInteger(
        value.bounded_explicit.max_duration_ms,
        'analysis_source_activation_policy_invalid_budget',
      ),
    }),
    safeReplay: Object.freeze({
      maxTurns: positiveInteger(
        value.safe_replay.max_turns,
        'analysis_source_activation_policy_invalid_safe_replay',
      ),
      maxCharsPerEntry: positiveInteger(
        value.safe_replay.max_chars_per_entry,
        'analysis_source_activation_policy_invalid_safe_replay',
      ),
    }),
  });
}

export function loadAnalysisSourceActivationPolicy(): AnalysisSourceActivationPolicy {
  const policy = loadStrategyYaml(
    POLICY_ASSET_NAME,
    parseAnalysisSourceActivationPolicy,
  );
  if (!policy) throw new Error('analysis_source_activation_policy_missing');
  return policy;
}

export function hasAuthorizedCodebase(input: Pick<
  AnalysisSourcePolicyInput,
  'hasAuthorizedCodebase' | 'codeAwareMode' | 'codebaseIds'
>): boolean {
  return input.hasAuthorizedCodebase !== false &&
    (input.codeAwareMode === 'metadata_only' || input.codeAwareMode === 'provider_send') &&
    Boolean(input.codebaseIds?.length);
}

export function resolveAnalysisSourceActivation(
  input: AnalysisSourcePolicyInput,
): AnalysisSourceActivation {
  return hasAuthorizedCodebase(input) ? 'bounded_explicit' : 'dormant';
}

export function boundedAnalysisSourceUsePolicy(): NonNullable<AnalysisOptions['sourceUsePolicy']> {
  return {
    phase: 'explicit',
    ...loadAnalysisSourceActivationPolicy().boundedExplicit,
  };
}

export function projectPrimaryAnalysisOptions<T extends AnalysisOptions>(
  options: T,
  _activation: AnalysisSourceActivation,
): T {
  // Source selection is caller authorization, independent of analysis wording or mode.
  // Keep caller policy intact: adding a policy also changes the MCP tool surface.
  return options;
}
