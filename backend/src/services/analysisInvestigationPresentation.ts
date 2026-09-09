// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {localize, type OutputLanguage} from '../agentv3/outputLanguage';
import type {AnalysisDeliveryAssurance, AnalysisAssuranceStatus} from '../types/analysisDelivery';

/** Presentation only: missing historical fields never become successful checks. */
export function investigationStatusLines(
  assurance: Pick<AnalysisDeliveryAssurance, 'investigation' | 'investigationEvidence'> | undefined,
  language: OutputLanguage,
): string[] {
  const label = (status: AnalysisAssuranceStatus | undefined): string => {
    switch (status) {
      case 'passed': return localize(language, '已核验', 'Checked');
      case 'not_applicable': return localize(language, '本轮不适用', 'Not applicable to this turn');
      case 'coverage_incomplete': return localize(language, '仍有必需维度缺失', 'Required dimensions remain incomplete');
      case 'unavailable': return localize(language, '核验不可用', 'Assessment unavailable');
      case 'failed': return localize(language, '未通过核验', 'Assessment failed');
      default: return localize(language, '尚未核验', 'Not checked');
    }
  };
  return [
    `${localize(language, '系统调查覆盖', 'System investigation coverage')}: ${label(assurance?.investigation)}`,
    `${localize(language, '系统证据覆盖', 'System evidence coverage')}: ${label(assurance?.investigationEvidence)}`,
  ];
}
