// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {QuickRunRequestedMode} from '../agent/core/orchestratorTypes';

/** Historical routing-receipt shape. Current execution uses RuntimeTurnPolicy. */
export interface RuntimeQuickModeResolution {
  requestedMode: QuickRunRequestedMode;
  quickMode: boolean;
  localReason?: string;
  quickAcknowledgementDirectAnswer: boolean;
  quickFocusAppPreEvidence: boolean;
  quickProcessIdentityPreEvidence: boolean;
  quickTraceFactPreEvidence: boolean;
  quickScrollingTriagePreEvidence: boolean;
  skipFocusDetection: boolean;
  skipTracePreflightDetection: boolean;
}
