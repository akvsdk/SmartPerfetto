// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {resolveRuntimeTurnPolicy} from '../runtimeTurnPolicy';

const intent: AnalysisTurnIntent = Object.freeze({
  schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'test',
  taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'read_new',
});

describe('runtime turn policy', () => {
  it('uses Full for budget without imposing prefetch or a report on a bounded answer', () => {
    expect(resolveRuntimeTurnPolicy(intent, 'full')).toEqual({
      budgetMode: 'full', onDemandContext: true, allowNewEvidence: true,
      allowAutomaticPrefetch: false, requiresReport: false,
    });
  });

  it('preserves evidence and report requirements when the user selects Fast', () => {
    const report = {...intent, taskKind: 'comparison' as const, scope: 'scene_wide' as const, deliverable: 'report' as const};
    const fast = resolveRuntimeTurnPolicy(report, 'fast');
    const full = resolveRuntimeTurnPolicy(report, 'full');
    expect(fast).toEqual({...full, budgetMode: 'quick'});
    expect(fast).toMatchObject({allowNewEvidence: true, allowAutomaticPrefetch: true, requiresReport: true});
    expect(Object.isFrozen(fast)).toBe(true);
  });

  it.each(['fast', 'full', 'auto'] as const)('never prefetches for existing_only with %s budget', mode => {
    const policy = resolveRuntimeTurnPolicy({...intent, scope: 'scene_wide', evidenceAccess: 'existing_only'}, mode);
    expect(policy.allowNewEvidence).toBe(false);
    expect(policy.allowAutomaticPrefetch).toBe(false);
  });

  it('keeps unavailable classification on demand even with explicit Full', () => {
    const policy = resolveRuntimeTurnPolicy({...intent, status: 'unavailable', source: 'fallback'}, 'full');
    expect(policy).toMatchObject({budgetMode: 'full', onDemandContext: true, allowAutomaticPrefetch: false, requiresReport: false});
  });

  it('does not let explanatory text change policy', () => {
    const expected = resolveRuntimeTurnPolicy(intent);
    for (const reason of ['full report', 'do not inspect anything', 'confirm-like follow-up: thanks']) {
      expect(resolveRuntimeTurnPolicy({...intent, reason})).toEqual(expected);
    }
  });
});
