// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {buildStrategyRegistrySnapshotFromDefinitions, getPlanTemplate, getRegisteredScenes} from '../strategyLoader';

describe('registry-owned optional plan advice', () => {
  it('reads exactly the advice declared by each registered scene without adding fallback aspects', () => {
    const definitions = getRegisteredScenes();
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'plan-advice-test'});
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      const advice = getPlanTemplate(definition.scene, registry);
      expect(advice).toEqual(definition.planTemplate);
      if (!advice) continue;
      const ids = advice.mandatoryAspects.map(aspect => aspect.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const aspect of advice.mandatoryAspects) {
        expect(aspect.id.trim().length).toBeGreaterThan(0);
        expect(typeof aspect.suggestion).toBe('string');
      }
    }
  });

  it('preserves a pinned absence instead of looking up the current global advice', () => {
    const definition = getRegisteredScenes().find(scene => scene.planTemplate?.mandatoryAspects.length)!;
    expect(definition).toBeDefined();
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: [{...definition, planTemplate: null}], overlayGeneration: 'no-plan-advice',
    });
    expect(getPlanTemplate(definition.scene)).not.toBeNull();
    expect(getPlanTemplate(definition.scene, registry)).toBeNull();
    expect(getPlanTemplate('absent-registry-scene', registry)).toBeNull();
  });

  it('returns immutable pinned advice without interpreting words or tool choices', () => {
    const definition = getRegisteredScenes()[0];
    const advice = {mandatoryAspects: [{id: 'optional-investigation', matchKeywords: [],
      suggestion: 'Choose the evidence that answers the question.', requiredExpectedCalls: [],
      alternativeExpectedCalls: [], waivable: true}]};
    const registry = buildStrategyRegistrySnapshotFromDefinitions({
      definitions: [{...definition, planTemplate: advice}], overlayGeneration: 'custom-plan-advice',
    });
    advice.mandatoryAspects[0].suggestion = 'Changed after capture';
    const pinned = getPlanTemplate(definition.scene, registry)!;
    expect(pinned.mandatoryAspects[0].suggestion).toBe('Choose the evidence that answers the question.');
    expect(pinned.mandatoryAspects[0].matchKeywords).toEqual([]);
    expect(pinned.mandatoryAspects[0].requiredExpectedCalls).toEqual([]);
    expect(Object.isFrozen(pinned)).toBe(true);
  });
});
