// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { buildIdentityResolutionFromProcessGate, mapProcessIdentityStatus } from '../identityContractMapper';
import type { ProcessIdentityResolution } from '../types';

function resolution(overrides: Partial<ProcessIdentityResolution> = {}): ProcessIdentityResolution {
  return {
    status: 'verified',
    requestedName: 'com.example',
    canonicalPackageName: 'com.example',
    recommendedProcessNameParam: 'com.example:provider',
    upids: [42],
    confidenceScore: 90,
    rawStatus: 'confirmed',
    evidenceSources: ['android_process_metadata.package_name'],
    warnings: [],
    candidates: [{
      rank: 1,
      confidenceScore: 90,
      rawStatus: 'confirmed',
      canonicalPackageName: 'com.example',
      recommendedProcessNameParam: 'com.example:provider',
      upid: 42,
      pid: 4242,
      processName: 'com.example:provider',
      targetMatchSources: 'android_process_metadata.package_name',
      supportingSources: 'frame_timeline.upid',
      threadUtid: 7,
      threadTid: 4242,
      threadName: 'main',
      threadRole: 'app_main',
      threadTargetMatched: true,
    }],
    ...overrides,
  };
}

describe('identityContractMapper', () => {
  it('keeps unselected candidates out of verified process and thread sidecars', () => {
    const selected = resolution();
    const sidecar = buildIdentityResolutionFromProcessGate({
      traceId: 'trace-a', target: { upid: 42 },
      resolution: { ...selected, candidates: [...selected.candidates,
        { ...selected.candidates[0], upid: 43, threadUtid: 8 }] },
    });
    expect(sidecar?.processes.map(process => process.upid)).toEqual([42]);
    expect(sidecar?.threads.map(thread => thread.owningUpid)).toEqual([42]);
  });

  it('maps resolver weak and error statuses into v1 status vocabulary', () => {
    expect(mapProcessIdentityStatus(resolution())).toBe('verified');
    expect(mapProcessIdentityStatus(resolution({
      status: 'ambiguous',
      rawStatus: 'weak_match',
      confidenceScore: 20,
    }))).toBe('weak');
    expect(mapProcessIdentityStatus(resolution({
      status: 'unresolved',
      resolverError: 'warming up',
    }))).toBe('error');
    expect(mapProcessIdentityStatus(resolution({ status: 'not_found', candidates: [], upids: [] }))).toBe('missing');
  });

  it('builds a stable identity sidecar with recommended params', () => {
    const sidecar = buildIdentityResolutionFromProcessGate({
      traceId: 'trace-a',
      traceSide: 'current',
      target: { requestedName: 'com.example', threadName: 'main', startTs: 10, endTs: 20 },
      resolution: resolution(),
    });

    expect(sidecar?.version).toBe('identity_contract@1');
    expect(sidecar?.identityRefId).toMatch(/^identity:/);
    expect(sidecar?.status).toBe('verified');
    expect(sidecar?.target).toEqual(expect.objectContaining({
      traceId: 'trace-a',
      processName: 'com.example',
      threadName: 'main',
    }));
    expect(sidecar?.processes[0]).toEqual(expect.objectContaining({
      upid: 42,
      pid: 4242,
      processName: 'com.example:provider',
    }));
    expect(sidecar?.threads[0]).toEqual(expect.objectContaining({
      utid: 7,
      tid: 4242,
      threadName: 'main',
      role: 'app_main',
      owningUpid: 42,
    }));
    expect(sidecar?.recommendedParams).toEqual(expect.objectContaining({
      process_name: 'com.example:provider',
      upid: 42,
    }));
  });

  it('does not return fallback threads when a requested thread name did not match', () => {
    const sidecar = buildIdentityResolutionFromProcessGate({
      traceId: 'trace-a',
      traceSide: 'current',
      target: { requestedName: 'com.example', threadName: 'RenderThread' },
      resolution: resolution({
        candidates: [{
          ...resolution().candidates[0],
          threadName: 'main',
          threadRole: 'app_main',
          threadTargetMatched: false,
        }],
      }),
    });

    expect(sidecar?.target.threadName).toBe('RenderThread');
    expect(sidecar?.threads).toEqual([]);
  });

  it('preserves reference trace side on identity sidecars', () => {
    const sidecar = buildIdentityResolutionFromProcessGate({
      traceId: 'trace-b',
      traceSide: 'reference',
      target: { requestedName: 'com.example' },
      resolution: resolution(),
    });

    expect(sidecar?.target.traceSide).toBe('reference');
  });

  it('can mark required identity with no resolver result as missing', () => {
    const sidecar = buildIdentityResolutionFromProcessGate({
      traceId: 'trace-a',
      target: {},
      statusOverride: 'missing',
      warnings: ['Process identity is required'],
    });

    expect(sidecar?.status).toBe('missing');
    expect(sidecar?.warnings).toContain('Process identity is required');
  });
});
