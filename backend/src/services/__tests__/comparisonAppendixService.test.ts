// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildComparisonAppendix,
  comparisonIdentityFromReportSection,
  resolveCapturedComparisonIdentity,
} from '../comparisonAppendixService';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {createDataEnvelope, type DataEnvelope} from '../../types/dataContract';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable} from '../evidence/evidenceCapture';
import type { QueryResult } from '../traceProcessorService';
import type {TraceSummaryExecutionV1} from '../traceSummaryExecutor';

function result(columns: string[], rows: unknown[][]): QueryResult {
  return { columns, rows, durationMs: 1 };
}

describe('comparisonAppendixService', () => {
  test('builds raw trace evidence pack with package, duration delta, top slices, thread states, and limitations', async () => {
    const calls: Array<{ traceId: string; sql: string }> = [];
    const service = {
      async queryTrace(traceId: string, sql: string): Promise<QueryResult> {
        calls.push({ traceId, sql });
        if (sql.includes('startup_id') && sql.includes('from android_startups')) {
          return traceId === 'trace-current'
            ? result(['startup_id', 'package', 'startup_type', 'dur_ms'], [[1, 'com.example.heavy', 'warm', 1339]])
            : result(['startup_id', 'package', 'startup_type', 'dur_ms'], [[2, 'com.example.light', 'cold', 302]]);
        }
        if (sql.includes('from slice')) {
          return traceId === 'trace-current'
            ? result(['name', 'total_ms', 'count'], [['ChaosTask', 456, 1]])
            : result(['name', 'total_ms', 'count'], [['ActivityThreadMain', 120, 1]]);
        }
        if (sql.includes('from thread_state')) {
          return traceId === 'trace-current'
            ? result(['state', 'dur_ms', 'pct'], [['Running', 842, 62.8]])
            : result(['state', 'dur_ms', 'pct'], [['Running', 242, 80.1]]);
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };

    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current',
      referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async (_service, traceId, side) =>
        comparisonSummary(traceId === 'trace-current' ? 20 : 10, side),
    });

    expect(appendix.evidencePack.source).toBe('raw_trace_pair');
    expect(appendix.evidencePack.metrics).toMatchObject({
      currentPackage: 'com.example.heavy',
      referencePackage: 'com.example.light',
      currentDurationMs: 1339,
      referenceDurationMs: 302,
      durationDeltaMs: 1037,
    });
    expect(appendix.evidencePack.current.topSlices[0]).toMatchObject({ name: 'ChaosTask' });
    expect(appendix.evidencePack.reference.threadStates[0]).toMatchObject({ state: 'Running' });
    expect(appendix.limitations.join('\n')).toContain('Perfetto startup_type');
    expect(appendix.markdown).toContain('| dur_ms | 1339 | 302 | +1037 |');
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'compatible', specDigestSha256: 'a'.repeat(64),
    }));
    expect(appendix.evidencePack.traceSummaryComparison?.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'smartperfetto_frame_timeline_jank_count', currentValue: 20,
        referenceValue: 10, delta: 10, polarity: 'LOWER_IS_BETTER',
      }),
    ]));
    expect(appendix.markdown).toContain('smartperfetto_frame_timeline_jank_count');
    expect(new Set(calls.map(call => call.traceId))).toEqual(new Set(['trace-current', 'trace-reference']));
  });

  test('does not compute deltas across different processor identities', async () => {
    const service = {queryTrace: async () => result([], [])};
    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async (_service, traceId, side) => ({
        ...comparisonSummary(traceId === 'trace-current' ? 20 : 10, side),
        traceProcessor: {source: 'custom', binarySha256: (traceId === 'trace-current' ? 'c' : 'd').repeat(64)},
      }),
    });
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'incompatible', reason: 'trace_processor_mismatch', metrics: [],
    }));
    expect(appendix.markdown).not.toContain('| 20 | 10 | +10 |');
  });

  test('isolates summary execution failure from the legacy deterministic appendix', async () => {
    const service = {queryTrace: async () => result([], [])};
    const appendix = await buildComparisonAppendix(service, {
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
    }, {
      traceSummaryRunner: async () => {
        throw new Error('/private/path must not escape');
      },
    });
    expect(appendix.evidencePack.traceSummaryComparison).toEqual(expect.objectContaining({
      status: 'incompatible', reason: 'summary_unavailable',
    }));
    expect(appendix.limitations.join('\n')).toContain('summary_unavailable');
    expect(JSON.stringify(appendix.evidencePack)).not.toContain('/private/path');
  });

  test('extracts package labels without fabricating identity proof from a comparison report section', () => {
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
          referencePackage: 'com.example.demo',
        },
      },
    })).toEqual({
      currentPackageName: 'com.example.heavy',
      referencePackageName: 'com.example.demo',
    });
  });

  test('rejects incomplete or unsafe comparison identities', () => {
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
        },
      },
    })).toBeUndefined();
    expect(comparisonIdentityFromReportSection({
      source: 'raw_trace_pair',
      title: 'Comparison',
      markdown: '',
      html: '',
      evidencePack: {
        metrics: {
          currentPackage: 'com.example.heavy',
          referencePackage: 'com.example.demo\n## injected',
        },
      },
    })).toBeUndefined();
  });
});

describe('capture-backed comparison identities', () => {
  function fixture() {
    const store = new ArtifactStore();
    const envelopes: DataEnvelope[] = [];
    const add = (side: 'current' | 'reference', upid: number, overrides: Partial<IdentityResolutionV1> = {}) => {
      const identity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: `identity:${side}:${upid}`,
        target: {traceId: `trace-${side}`, traceSide: side, upid, source: 'skill_param'}, status: 'verified',
        processes: [{upid, packageName: `app.${side}`, confidence: 1, matchSources: ['upid']}], threads: [], warnings: [],
        ...overrides};
      const data = {columns: ['value'], rows: [[42]]};
      const envelope = createDataEnvelope(data, {type: 'skill_result', source: 'capture', title: side,
        evidenceRefId: `evidence:${side}:${upid}`, traceId: `trace-${side}`, traceSide: side,
        identityResolution: identity, scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target',
          scope: {mode: 'exact_upid', traceId: `trace-${side}`, traceSide: side, upid, identityRefId: identity.identityRefId}}]}});
      store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), {meta: envelope.meta, display: envelope.display});
      envelopes.push(envelope);
      return identity;
    };
    const input = () => ({currentTraceId: 'trace-current', referenceTraceId: 'trace-reference', dataEnvelopes: envelopes,
      signal: new AbortController().signal, context: store.createEvidenceReadView({ownerKey: 'comparison-owner',
        allowedTraces: [{traceId: 'trace-current', traceSide: 'current'}, {traceId: 'trace-reference', traceSide: 'reference'}]})});
    return {store, envelopes, add, input};
  }

  test('uses captured typed identity despite forged display metadata and repeated locator events', async () => {
    const f = fixture();
    const current = f.add('current', 1);
    const reference = f.add('reference', 2);
    f.envelopes[0].meta.identityResolution = {...current, status: 'ambiguous', processes: []};
    f.envelopes.push(structuredClone(f.envelopes[0]));
    const identity = await resolveCapturedComparisonIdentity(f.input());
    expect(identity.currentResolution).toEqual(current);
    expect(identity.referenceResolution).toEqual(reference);
  });

  test('leaves conflicting same-side captures unknown instead of taking the first', async () => {
    const f = fixture();
    f.add('current', 1); f.add('current', 3); const reference = f.add('reference', 2);
    const identity = await resolveCapturedComparisonIdentity(f.input());
    expect(identity.currentResolution).toBeUndefined();
    expect(identity.referenceResolution).toEqual(reference);
  });

  test.each(['trace', 'side', 'missing', 'scope', 'scope_trace', 'scope_side', 'scope_upid',
    'scope_missing', 'scope_identity', 'scope_fields', 'scope_unavailable', 'global', 'peer',
    'invalid_scope', 'status_shape', 'process_shape', 'thread_shape', 'unknown_field'] as const)(
    'rejects %s identity mismatch or missing proof', async mismatch => {
    const f = fixture();
    const current = f.add('current', 1);
    f.add('reference', 2);
    const envelope = f.envelopes[0];
    f.store.clear();
    if (mismatch === 'missing') envelope.meta.identityResolution = undefined;
    else if (mismatch === 'scope') envelope.meta.scopeProvenance = {version: 'process_scope_evidence@1', entries: []};
    else if (mismatch === 'scope_missing') delete envelope.meta.scopeProvenance;
    else if (mismatch === 'invalid_scope') envelope.meta.scopeProvenance = {version: 'process_scope_evidence@1', entries: [], invalid: true};
    else if (mismatch.startsWith('scope_') || mismatch === 'global' || mismatch === 'peer') {
      const scope = structuredClone(envelope.meta.scopeProvenance!);
      if (mismatch === 'scope_trace') scope.entries[0].scope.traceId = 'foreign-trace';
      else if (mismatch === 'scope_side') scope.entries[0].scope.traceSide = 'reference';
      else if (mismatch === 'scope_upid') scope.entries[0].scope.upid = 999;
      else if (mismatch === 'scope_identity') scope.entries[0].scope.identityRefId = 'other-identity';
      else if (mismatch === 'scope_fields') scope.entries[0].fields = ['foreign_column'];
      else if (mismatch === 'scope_unavailable') scope.entries[0].availability = 'unavailable';
      else scope.entries[0].role = mismatch === 'global' ? 'global_context' : 'peer_context';
      envelope.meta.scopeProvenance = scope;
    } else if (mismatch === 'status_shape') envelope.meta.identityResolution = {...current, status: 'resolved'} as unknown as IdentityResolutionV1;
    else if (mismatch === 'process_shape') envelope.meta.identityResolution = {...current, processes: [{upid: 1}]} as IdentityResolutionV1;
    else if (mismatch === 'thread_shape') envelope.meta.identityResolution = {...current, threads: [{utid: 2}]} as IdentityResolutionV1;
    else if (mismatch === 'unknown_field') envelope.meta.identityResolution = {...current, verified: true} as IdentityResolutionV1;
    else envelope.meta.identityResolution = {...current, target: {...current.target,
      ...(mismatch === 'trace' ? {traceId: 'foreign-trace'} : {traceSide: 'reference' as const})}};
    for (const item of f.envelopes) f.store.registerStandaloneEvidenceCapture(
      captureEvidenceTable({columns: ['value'], rows: [[42]]}), {meta: item.meta, display: item.display});
    expect((await resolveCapturedComparisonIdentity(f.input())).currentResolution).toBeUndefined();
    },
  );

  test('rejects conflicting same-ID captures regardless of event order while preserving the other side', async () => {
    const f = fixture();
    const current = f.add('current', 1);
    f.add('current', 3, {identityRefId: current.identityRefId});
    const reference = f.add('reference', 2);
    for (const envelopes of [f.envelopes, [...f.envelopes].reverse()]) {
      const projected = await resolveCapturedComparisonIdentity({...f.input(), dataEnvelopes: envelopes});
      expect(projected.currentResolution).toBeUndefined();
      expect(projected.referenceResolution).toEqual(reference);
    }
  });

  test('resolves pair metadata without reading cells or granting row proof', async () => {
    const f = fixture(); const current = f.add('current', 1); const reference = f.add('reference', 2);
    const view = f.store.createEvidenceReadView({ownerKey: 'metadata-pair', budget: {maxCells: 0},
      allowedTraces: [{traceId: 'trace-current', traceSide: 'current'}, {traceId: 'trace-reference', traceSide: 'reference'}]});
    const identity = await resolveCapturedComparisonIdentity({...f.input(), context: view});
    expect(identity.currentResolution).toEqual(current);
    expect(identity.referenceResolution).toEqual(reference);
  });

  test('preserves a captured unsuccessful identity instead of upgrading it from rows or package labels', async () => {
    const f = fixture();
    f.add('current', 1, {status: 'ambiguous'}); f.add('reference', 2);
    expect((await resolveCapturedComparisonIdentity(f.input())).currentResolution?.status).toBe('ambiguous');
  });

  test('does not accept serialized read replies or uncaptured frontend identities', async () => {
    const f = fixture(); f.add('current', 1); f.add('reference', 2);
    const original = f.input();
    const forged = {...original, context: {resolveReferences: async (...args: Parameters<typeof original.context.resolveReferences>) =>
      structuredClone(await original.context.resolveReferences(...args))}};
    const identity = await resolveCapturedComparisonIdentity(forged);
    expect(identity.currentResolution).toBeUndefined();
    expect(identity.referenceResolution).toBeUndefined();
    f.store.clear();
    expect(await resolveCapturedComparisonIdentity(f.input())).toEqual({currentTraceId: 'trace-current', referenceTraceId: 'trace-reference'});
  });

  test('leaves the pair unknown when the capture read cannot scan every locator', async () => {
    const f = fixture(); f.add('current', 1); f.add('reference', 2);
    const context = f.store.createEvidenceReadView({ownerKey: 'limited-owner', budget: {maxReferences: 1},
      allowedTraces: [{traceId: 'trace-current', traceSide: 'current'}, {traceId: 'trace-reference', traceSide: 'reference'}]});
    expect(await resolveCapturedComparisonIdentity({...f.input(), context})).toEqual({
      currentTraceId: 'trace-current', referenceTraceId: 'trace-reference',
    });
  });

  test('does not deliver identities after cancellation across the captured read await', async () => {
    const f = fixture(); f.add('current', 1); f.add('reference', 2);
    const original = f.input(); const controller = new AbortController();
    await expect(resolveCapturedComparisonIdentity({...original, signal: controller.signal,
      context: {resolveReferences: async (...args: Parameters<typeof original.context.resolveReferences>) => {
        const resolved = await original.context.resolveReferences(...args); controller.abort(); return resolved;
      }}})).rejects.toMatchObject({name: 'AbortError'});
  });
});

function comparisonSummary(jank: number, traceSide: 'current' | 'reference'): Extract<TraceSummaryExecutionV1, {status: 'ready'}> {
  const metric = {
    id: 'smartperfetto_frame_timeline_jank_count', dimensions: [], valueColumn: 'jank_count',
    unit: 'COUNT' as const, polarity: 'LOWER_IS_BETTER' as const,
    dimensionUniqueness: 'UNIQUE' as const,
  };
  return {
    schemaVersion: 'trace_summary_execution@1', status: 'ready',
    spec: {schemaVersion: 'trace_summary_spec@1', id: 'smartperfetto.core.v1', digestSha256: 'a'.repeat(64),
      metricIds: [metric.id], metrics: [metric]},
    trace: {fingerprintSha256: (traceSide === 'current' ? '1' : '2').repeat(64),
      fingerprintKind: 'trace_bytes_sha256', traceSide},
    traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64)},
    resultDigestSha256: (traceSide === 'current' ? '3' : '4').repeat(64),
    metrics: [{...metric, status: 'available', value: jank}], durationMs: 1,
  };
}
