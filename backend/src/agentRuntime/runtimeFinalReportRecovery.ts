// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisPlanV3, Hypothesis} from '../agentv3/types';
import {renderRequiredLocalizedStrategyTemplate} from '../agentv3/localizedStrategyTemplate';
import {assessFinalReportContract} from '../services/finalReportContractGate';
import {
  sameAnalysisCandidate,
  type AnalysisCompletion,
  type AnalysisDeliveryContext,
  type AnalysisMissingReportSection,
  type AnalysisRecoveryKind,
  type AnalysisRuntimeAppendix,
} from '../types/analysisDelivery';

interface VerificationIssueLike {
  type?: string;
  message?: string;
  recoveryKind?: AnalysisRecoveryKind;
  missingSections?: readonly AnalysisMissingReportSection[];
}

export interface FinalReportRecoveryInput {
  conclusion: string;
  deliveryContext: AnalysisDeliveryContext;
  recoveryKind: AnalysisRecoveryKind;
  missingSections?: readonly AnalysisMissingReportSection[];
  conclusionContract?: unknown;
  outputLanguage: OutputLanguage;
}

export interface FinalReportRecoveryResult {
  /** The original model body, including its final line and whitespace. */
  conclusion: string;
  /** This recovery cannot change an incomplete receipt into success. */
  completion: AnalysisCompletion;
  runtimeAppendix: AnalysisRuntimeAppendix;
}

/**
 * Add a separate runtime explanation for an actually interrupted candidate or
 * content confirmed missing by a bound semantic assessment. It neither repairs
 * facts nor proves that the deliverable is complete.
 */
export function recoverFinalReport(input: FinalReportRecoveryInput): FinalReportRecoveryResult | undefined {
  const context = input.deliveryContext;
  if (!input.conclusion.trim() || context.entry === 'historical_restore') return undefined;
  const completion = context.completion;
  const candidate = context.acceptedCandidate;
  if (!candidate || completion?.schemaVersion !== 1 ||
    !sameAnalysisCandidate(completion, context.acceptedCandidate, input.conclusion) ||
    (context.outputOrigin !== 'sdk_final' && context.outputOrigin !== 'assistant_stream')) return undefined;

  let missingSections: readonly AnalysisMissingReportSection[] = [];
  if (input.recoveryKind === 'continue_output') {
    if (completion.status !== 'incomplete') return undefined;
  } else if (input.recoveryKind === 'complete_report_content') {
    const report = assessFinalReportContract({
      conclusion: input.conclusion, conclusionContract: input.conclusionContract, context,
    });
    if (report.missingSections.length === 0) return undefined;
    // A requested subset may narrow known missing content, never introduce it.
    const requestedIds = input.missingSections?.map(section => section.id);
    if (requestedIds && (requestedIds.length === 0 || requestedIds.some(id =>
      !report.missingSections.some(section => section.id === id)))) return undefined;
    missingSections = requestedIds
      ? report.missingSections.filter(section => requestedIds.includes(section.id))
      : report.missingSections;
  } else {
    // Evidence errors need a newly checked model candidate, not a runtime copy.
    return undefined;
  }

  const text = renderRequiredLocalizedStrategyTemplate(
    'report-runtime-delivery-appendix', input.outputLanguage,
    {missing_requirements: missingSections.map(section => `- ${section.label}`).join('\n')},
  ).trim();
  return {
    conclusion: input.conclusion,
    completion: {...completion},
    runtimeAppendix: {
      schemaVersion: 1,
      origin: 'runtime_fallback',
      sourceCandidate: {...candidate},
      text,
      ...(completion.reason ? {reason: completion.reason} : {}),
    },
  };
}

/** Legacy issue names or localized prose cannot authorize output continuation. */
export function isTruncationVerificationIssue(issue: VerificationIssueLike | undefined): boolean {
  return issue?.recoveryKind === 'continue_output';
}

export function findTruncationVerificationIssue(
  issues: readonly VerificationIssueLike[],
): VerificationIssueLike | undefined {
  return issues.find(isTruncationVerificationIssue);
}

interface TruncatedFinalReportRepairInput {
  conclusion: string;
  plan: AnalysisPlanV3 | null;
  hypotheses?: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
  missingContractSections?: ReadonlyArray<AnalysisMissingReportSection & {
    recoveryText?: {zh: string[]; en: string[]};
  }>;
  recoveryKind?: 'truncation' | 'missing_contract';
}

/**
 * @deprecated Use recoverFinalReport with the current candidate receipt.
 * A string-only repair would hide provenance and let legacy callers clear an
 * error after adding synthesized text. Keep this compatibility path a no-op.
 */
export function repairTruncatedFinalReport(
  _input: TruncatedFinalReportRepairInput,
): string | undefined {
  return undefined;
}

export interface InterruptedFinalReportRecoveryInput {
  partialConclusion?: string;
  plan: AnalysisPlanV3 | null;
  hypotheses?: readonly Hypothesis[];
  outputLanguage: OutputLanguage;
}

/**
 * @deprecated Use recoverFinalReport for a separately attributed appendix.
 * Legacy callers may retain an existing partial body, but never manufacture or
 * certify a report from plan or hypothesis text.
 */
export function recoverInterruptedFinalReport(
  input: InterruptedFinalReportRecoveryInput,
): string | undefined {
  return input.partialConclusion?.trim() ? input.partialConclusion : undefined;
}
