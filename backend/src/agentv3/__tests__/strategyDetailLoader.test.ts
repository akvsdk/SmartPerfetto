// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import {
  buildStrategyRegistrySnapshotFromDefinitions,
  getRegisteredScenes,
  getStrategyContent,
  getStrategyDetails,
  getStrategyDetailByRef,
} from '../strategyLoader';

describe('strategy detail loader', () => {
  it('keeps every normal strategy split into core plus on-demand detail', () => {
    for (const scene of getRegisteredScenes().map(def => def.scene)) {
      const core = getStrategyContent(scene) || '';
      const details = getStrategyDetails(scene);
      expect(core).toContain('Core Strategy');
      expect(core).not.toContain('<!-- strategy-detail');
      expect(details.length).toBeGreaterThan(0);
    }
  });

  it('resolves explicit detail references from the supplied registry pin', () => {
    const definitions = getRegisteredScenes();
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions, overlayGeneration: 'explicit-detail'});
    for (const definition of registry.getAllStrategies()) {
      for (const detail of definition.detailSections) {
        expect(getStrategyDetailByRef(detail.ref, undefined, registry)).toEqual(detail);
        expect(getStrategyDetailByRef(detail.id, definition.scene, registry)).toEqual(detail);
      }
    }
    const empty = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'empty-detail-pin'});
    const existingRef = definitions.find(definition => definition.detailSections.length)!.detailSections[0].ref;
    expect(getStrategyDetailByRef(existingRef, undefined, empty)).toBeUndefined();
  });

});
