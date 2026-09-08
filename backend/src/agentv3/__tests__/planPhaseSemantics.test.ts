// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {hasValidPlanSkipDisposition, resolvePlanPhaseForCall} from '../planPhaseSemantics';
import {expectedCallMatchesRecord, type AnalysisPlanV3, type PlanPhase} from '../types';

function phase(id: string, skillId: string, status: PlanPhase['status'] = 'pending'): PlanPhase {
  return {id, name: 'Arbitrary phase', goal: 'Arbitrary goal', status,
    expectedTools: ['invoke_skill'], expectedCalls: [{tool: 'invoke_skill', skillId}]};
}
function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {phases, successCriteria: 'Resolve', submittedAt: 1, toolCallLog: []};
}

describe('structural plan phase attribution', () => {
  it.each(['Final conclusion', 'comparison synthesis', '最终报告', '根因深钻', 'unrelated'])('does not infer ownership or completion from %s', name => {
    const state = plan([{...phase('a', 'skill-a'), name, goal: name}, phase('b', 'skill-b')]);
    expect(resolvePlanPhaseForCall(state, {toolName: 'invoke_skill', skillId: 'skill-b', timestamp: 1}).phase?.id).toBe('b');
    expect(resolvePlanPhaseForCall(state, {toolName: 'invoke_skill', skillId: 'skill-b', timestamp: 1}, 'a').phase).toBeUndefined();
  });
  it.each([true, false, undefined])('keeps structural ownership independent of success=%s', success => {
    const state = plan([phase('a', 'skill-a')]);
    const call = {toolName: 'invoke_skill', skillId: 'skill-a', success, timestamp: 1};
    expect(expectedCallMatchesRecord({tool: 'invoke_skill', skillId: 'skill-a'}, call)).toBe(true);
    expect(resolvePlanPhaseForCall(state, call).phase?.id).toBe('a');
  });
  it('does not break ambiguity with state priority or filled requirements', () => {
    const state = plan([phase('a', 'shared', 'completed'), phase('b', 'shared', 'in_progress')]);
    const call = {toolName: 'invoke_skill', skillId: 'shared', success: true, timestamp: 1};
    state.toolCallLog.push({...call, matchedPhaseId: 'a'});
    expect(resolvePlanPhaseForCall(state, call)).toEqual({attribution: 'ambiguous'});
    expect(resolvePlanPhaseForCall(state, call, 'b').phase?.id).toBe('b');
    expect(resolvePlanPhaseForCall(state, call, 'unknown')).toEqual({attribution: 'unknown_phase'});
  });
  it('does not substitute an identity resolver for the declared skill', () => {
    expect(resolvePlanPhaseForCall(plan([phase('a', 'skill-a')]), {
      toolName: 'invoke_skill', skillId: 'process_identity_resolver', timestamp: 1,
    })).toEqual({attribution: 'unmatched'});
  });
  it('validates optional skip receipt references against actual phase-bound failures', () => {
    const p = {...phase('a', 'skill-a'), skipDisposition: {kind: 'evidence_unavailable' as const, failureToolCallIds: ['failed']}};
    const state = plan([p]);
    expect(hasValidPlanSkipDisposition(state, p)).toBe(false);
    state.toolCallLog.push({toolName: 'invoke_skill', toolCallId: 'failed', skillId: 'skill-a', timestamp: 1, success: false, matchedPhaseId: 'b'});
    expect(hasValidPlanSkipDisposition(state, p)).toBe(false);
    state.toolCallLog[0].matchedPhaseId = 'a';
    expect(hasValidPlanSkipDisposition(state, p)).toBe(true);
    state.toolCallLog[0].success = true;
    expect(hasValidPlanSkipDisposition(state, p)).toBe(false);
  });
});
