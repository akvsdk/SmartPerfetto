// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildQuickRunReceipt, resolveQuickRunProfile, resolveQuickTurnBudget} from '../quickBudget';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';

const intent: AnalysisTurnIntent = {
  schemaVersion: 1, status: 'resolved', source: 'semantic', registryFingerprint: 'test',
  taskKind: 'investigation', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'full', deliverable: 'answer', evidenceAccess: 'read_new',
};

const budget = resolveQuickTurnBudget({targetTurns: 2, hardCapTurns: 4});
const base = {requestedMode: 'auto' as const, budget, actualTurns: 1, elapsedMs: 10, stopReason: 'answered' as const};

describe('typed quick run profile', () => {
  it.each(['investigation', 'comparison'] as const)('labels a resolved scene-wide %s as triage', taskKind => {
    expect(resolveQuickRunProfile({turnIntent: {...intent, taskKind, scope: 'scene_wide'}, extended: false})).toBe('triage');
  });

  it('keeps a bounded investigation on the normal or extended budget track', () => {
    expect(resolveQuickRunProfile({turnIntent: intent, extended: false})).toBe('normal');
    expect(resolveQuickRunProfile({turnIntent: intent, extended: true})).toBe('extended');
  });

  it('does not infer scope from missing or failed semantic decisions', () => {
    for (const turnIntent of [undefined, {...intent, status: 'unavailable' as const, scope: 'scene_wide' as const}]) {
      expect(resolveQuickRunProfile({turnIntent, extended: false})).toBe('normal');
      expect(resolveQuickRunProfile({turnIntent, extended: true})).toBe('extended');
    }
  });

  it('does not turn a whole-trace fact lookup into diagnostic triage', () => {
    expect(resolveQuickRunProfile({turnIntent: {...intent, scope: 'scene_wide', taskKind: 'fact'}, extended: false})).toBe('normal');
  });

  it('uses the same typed scope despite quoted topics, negations or entity spelling in legacy query text', () => {
    for (const query of ['为什么滑动卡', '不是滑动问题', 'why is "scrolling" slow', 'CustomScrollAdapter_continuousLoad', '']) {
      for (const conversationTurns of [0, 4]) {
        expect(buildQuickRunReceipt({...base, query, turnIntent: intent,
          contextInjected: {conversationTurns}}).profile).toBe('normal');
        expect(buildQuickRunReceipt({...base, query, turnIntent: {...intent, scope: 'scene_wide'},
          contextInjected: {conversationTurns}}).profile).toBe('triage');
      }
    }
  });

  it('records actual budget extension independently from wording and scope', () => {
    const receipt = buildQuickRunReceipt({...base, turnIntent: intent, actualTurns: 3});
    expect(receipt).toMatchObject({profile: 'extended', targetTurns: 2, hardCapTurns: 4, actualTurns: 3});
    expect(buildQuickRunReceipt({...base, actualTurns: 3}).profile).toBe('extended');
  });

  it('preserves a backend supplied profile and defaults legacy receipts to normal', () => {
    expect(buildQuickRunReceipt({...base, profile: 'triage'}).profile).toBe('triage');
    expect(buildQuickRunReceipt(base).profile).toBe('normal');
  });
});
