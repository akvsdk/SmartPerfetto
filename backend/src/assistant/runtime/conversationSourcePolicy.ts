// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {hasAuthorizedCodebase} from '../../services/codebase/analysisSourceActivationPolicy';

export type PrimaryConversationSourceUse = 'dormant' | 'explicit';

export function resolvePrimaryConversationSourceUse(input: {
  query: string;
  hasAuthorizedCodebase?: boolean;
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: readonly string[];
}): PrimaryConversationSourceUse {
  return hasAuthorizedCodebase(input) ? 'explicit' : 'dormant';
}
