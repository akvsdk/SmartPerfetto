// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {buildActivePhaseReminder, REMINDER_PREFIX} from '../activePhaseReminder';
import type {AnalysisPlanV3} from '../types';

const state = (): AnalysisPlanV3 => ({phases: [{id: 'p1', name: 'Final conclusion', goal: 'Inspect the selected evidence',
  expectedTools: [], status: 'in_progress'}], successCriteria: 'Resolve', submittedAt: 1, toolCallLog: []});

describe('explicit active phase reminder', () => {
  it('renders the explicit ID and goal without selecting a strategy hint', () => {
    const getStrategy = jest.fn(() => {throw new Error('Strategy matching must not run');});
    const pin = {registryFingerprint: 'pin', overlayGeneration: 'pin', getStrategy, getAllStrategies: () => []};
    const plan = state();
    expect(buildActivePhaseReminder(plan, 'scrolling', pin)).toBe(`${REMINDER_PREFIX} p1: Inspect the selected evidence`);
    expect(getStrategy).not.toHaveBeenCalled();
    plan.phases[0].name = 'architecture root drill synthesis';
    expect(buildActivePhaseReminder(plan)).toBe(`${REMINDER_PREFIX} p1: Inspect the selected evidence`);
  });
  it('does not guess an active phase from no plan, pending phases, or multiple active phases', () => {
    expect(buildActivePhaseReminder(null)).toBe('');
    const plan = state();
    plan.phases[0].status = 'pending';
    expect(buildActivePhaseReminder(plan)).toBe('');
    plan.phases[0].status = 'in_progress';
    plan.phases.push({...plan.phases[0], id: 'p2'});
    expect(buildActivePhaseReminder(plan)).toBe('');
  });
  it('bounds display text without mutating plan state or creating completion proof', () => {
    const plan = state();
    plan.phases[0].goal = 'x'.repeat(1000);
    expect(buildActivePhaseReminder(plan).length).toBeLessThanOrEqual(200);
    expect(plan.phases[0].status).toBe('in_progress');
    expect(plan.phases[0].summary).toBeUndefined();
  });
});
