// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Drill-Down Resolver Unit Tests
 */

import {
  resolveDrillDown,
  DrillDownResolved,
  DrillDownResolutionTrace,
} from '../drillDownResolver';
import {resolveRegisteredDrillDownSkillParams} from '../drillDownEntityResolver';
import { EnhancedSessionContext } from '../../context/enhancedSessionContext';
import type { Intent, ReferencedEntity } from '../../types';
import type { FollowUpResolution } from '../followUpHandler';
import Database from 'better-sqlite3';
import {createEffectiveProcessScope} from '../../../services/processIdentity/effectiveProcessScope';

describe('drillDownResolver', () => {
  let sessionContext: EnhancedSessionContext;

  beforeEach(() => {
    sessionContext = new EnhancedSessionContext('session-1', 'trace-1');
  });

  describe('resolveDrillDown', () => {
    describe('Priority 1: Explicit intervals from followUp', () => {
      test('returns followUp intervals when valid timestamps present', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          focusIntervals: [{
            id: 0,
            processName: 'com.example.app',
            startTs: '123456789000000',
            endTs: '123456889000000',
            priority: 1,
            label: '帧 1436069',
            metadata: {
              sourceEntityType: 'frame',
              sourceEntityId: 1436069,
            },
          }],
          confidence: 0.9,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('explicit');
      });

      test('skips invalid intervals with placeholder timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          focusIntervals: [{
            id: 0,
            processName: '',
            startTs: '0', // Invalid placeholder
            endTs: '0',
            priority: 1,
            metadata: { needsEnrichment: true },
          }],
          confidence: 0.5,
        };

        // Should fall through to cache/enrichment
        const result = await resolveDrillDown(intent, followUp, sessionContext);
        // Without cache data, returns null
        expect(result).toBeNull();
      });
    });

    describe('Priority 2: EntityStore cache', () => {
      test('resolves from cache when frame exists', async () => {
        // Pre-populate cache
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
          session_id: '1',
          jank_type: 'App Deadline Missed',
        });

        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('cache');
        expect(result!.traces[0].enriched).toBe(false);
        expect(result!.traces[0].reason).toContain('Cache hit');
      });

      test('resolves from cache when session exists', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertSession({
          session_id: '1',
          start_ts: '100000000000000',
          end_ts: '200000000000000',
          process_name: 'com.example.app',
          frame_count: 120,
          jank_count: 5,
        });

        const intent: Intent = {
          primaryGoal: '分析会话 1',
          aspects: ['scrolling'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'session', id: 1 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { session_id: 1 },
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('100000000000000');
        expect(result!.traces[0].entityType).toBe('session');
        expect(result!.traces[0].used).toContain('cache');
      });
    });

    describe('Priority 3: Resolved params from findings', () => {
      test('builds interval from resolved params with timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {
            frame_id: 1436069,
            start_ts: '123456789000000',
            end_ts: '123456889000000',
            process_name: 'com.example.app',
          },
          confidence: 0.7,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.traces[0].used).toContain('finding');
      });
    });

    describe('Priority 4: SQL enrichment', () => {
      test('enriches frame via SQL when cache miss', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        // Mock trace processor service
        const mockTps = {
          executeQuery: jest.fn().mockResolvedValue({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'upid', 'jank_type', 'layer_name'],
            rows: [
              [1436069, '123456789000000', '123456889000000', 100000000, 'com.example.app', 123, 'App Deadline Missed', 'SurfaceView'],
            ],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.intervals[0].startTs).toBe('123456789000000');
        expect(result!.traces[0].used).toContain('enrichment');
        expect(result!.traces[0].enriched).toBe(true);

        // Verify enrichment was cached
        const cachedFrame = sessionContext.getEntityStore().getFrame('1436069');
        expect(cachedFrame).toBeDefined();
        expect(cachedFrame?.source).toBe('enrichment');
      });

      test('returns null when enrichment fails', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 9999999',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 9999999 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 9999999 },
          confidence: 0.5,
        };

        // Mock returns no rows
        const mockTps = {
          executeQuery: jest.fn().mockResolvedValue({
            columns: [],
            rows: [],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).toBeNull();
      });

      test('enriches startup via SQL when startup entity is requested', async () => {
        const intent: Intent = {
          primaryGoal: '分析启动 12',
          aspects: ['startup'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'startup', id: 12 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { startup_id: 12 },
          confidence: 0.5,
        };

        const db = new Database(':memory:');
        try {
          db.exec(`
            CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT, startup_type TEXT);
            CREATE TABLE android_startup_time_to_display(startup_id INTEGER, time_to_initial_display INTEGER, time_to_full_display INTEGER);
            CREATE TABLE android_startup_processes(startup_id INTEGER, upid INTEGER);
            INSERT INTO android_startups VALUES (12, 1000000, 1800000, 'com.example.app', 'cold');
            INSERT INTO android_startup_time_to_display VALUES (12, 1500000, 1900000);
            INSERT INTO android_startup_processes VALUES (12, 42);
          `);
          const mockTps = {
            executeQuery: jest.fn(async (_traceId: string, sql: string) => {
              const statement = db.prepare<[], unknown[]>(sql);
              return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
            }),
          };
          const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

          expect(result).not.toBeNull();
          expect(result!.intervals).toHaveLength(1);
          expect(result!.intervals[0]).toMatchObject({startTs: '1000000', endTs: '2800000'});
          expect(result!.intervals[0].metadata?.startup_id).toBe('12');
          expect(result!.traces[0].entityType).toBe('startup');
          expect(result!.traces[0].used).toContain('enrichment');
          expect(mockTps.executeQuery).toHaveBeenCalledWith('trace-1', expect.any(String));
          expect(mockTps.executeQuery.mock.calls[0]?.[1]).not.toMatch(/\$(?:process_name|upid|startup_id)\b/);
        } finally {
          db.close();
        }
      });

      test('supports trace processor query(traceId, sql) API for enrichment', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1436069',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1436069 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1436069 },
          confidence: 0.5,
        };

        const mockTps = {
          query: jest.fn().mockResolvedValue({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'upid', 'jank_type', 'layer_name'],
            rows: [
              [1436069, '123456789000000', '123456889000000', 100000000, 'com.example.app', 123, 'App Deadline Missed', 'SurfaceView'],
            ],
          }),
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(mockTps.query).toHaveBeenCalledWith(
          'trace-1',
          expect.stringContaining('COALESCE(a.display_frame_token, a.surface_frame_token) = 1436069')
        );
      });

      test('falls back to doFrame alias enrichment when token and legacy lookups miss', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧 1435596',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'frame', id: 1435596 }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: { frame_id: 1435596 },
          confidence: 0.5,
        };

        const queryMock = jest.fn()
          // Token lookup miss.
          .mockResolvedValueOnce({ columns: [], rows: [] })
          // Legacy lookup miss.
          .mockResolvedValueOnce({ columns: [], rows: [] })
          // doFrame alias hit.
          .mockResolvedValueOnce({
            columns: ['frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'jank_type', 'layer_name'],
            rows: [
              [1435611, '223456789000000', '223456889000000', 100000000, 'com.example.app', 'App Deadline Missed', 'SurfaceView'],
            ],
          });

        const mockTps = {
          query: queryMock,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext, mockTps, 'trace-1');

        expect(result).not.toBeNull();
        expect(queryMock).toHaveBeenCalledTimes(3);
        expect(queryMock.mock.calls[2][1]).toContain('Choreographer#doFrame 1435596');
        expect(result!.intervals[0].startTs).toBe('223456789000000');
        expect(result!.intervals[0].endTs).toBe('223456889000000');
        expect(result!.intervals[0].metadata?.frame_id).toBe('1435611');
        expect(result!.intervals[0].metadata?.resolvedFrom).toBe('doframe_alias');
      });
    });

    describe('Multiple entities', () => {
      test('resolves multiple frame entities', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
        });
        store.upsertFrame({
          frame_id: '1436070',
          start_ts: '123456889000000',
          end_ts: '123456989000000',
          process_name: 'com.example.app',
        });

        const intent: Intent = {
          primaryGoal: '比较帧 1436069 和 1436070',
          aspects: ['jank'],
          expectedOutputType: 'comparison',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [
            { type: 'frame', id: 1436069 },
            { type: 'frame', id: 1436070 },
          ],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(2);
        expect(result!.traces).toHaveLength(2);
        expect(result!.traces.every(t => t.used.includes('cache'))).toBe(true);
      });
    });

    describe('Entity type filtering', () => {
      test('ignores unsupported non-drill-down entity types', async () => {
        const intent: Intent = {
          primaryGoal: '分析进程',
          aspects: ['process'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{ type: 'process', id: 'com.example.app' }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);
        expect(result).toBeNull();
      });
    });

    describe('ReferencedEntity.value handling', () => {
      test('uses value when id is not present', async () => {
        const store = sessionContext.getEntityStore();
        store.upsertFrame({
          frame_id: '1436069',
          start_ts: '123456789000000',
          end_ts: '123456889000000',
          process_name: 'com.example.app',
        });

        const intent: Intent = {
          primaryGoal: '分析帧',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{
            type: 'frame',
            value: 1436069, // Using value instead of id
          }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
      });

      test('builds interval from value object with timestamps', async () => {
        const intent: Intent = {
          primaryGoal: '分析帧',
          aspects: ['jank'],
          expectedOutputType: 'diagnosis',
          complexity: 'moderate',
          followUpType: 'drill_down',
          referencedEntities: [{
            type: 'frame',
            id: 1436069,
            value: {
              frame_id: 1436069,
              start_ts: '123456789000000',
              end_ts: '123456889000000',
              process_name: 'com.example.app',
            },
          }],
        };

        const followUp: FollowUpResolution = {
          isFollowUp: true,
          resolvedParams: {},
          confidence: 0.5,
        };

        const result = await resolveDrillDown(intent, followUp, sessionContext);

        expect(result).not.toBeNull();
        expect(result!.intervals).toHaveLength(1);
        expect(result!.traces[0].used).toContain('explicit');
      });
    });
  });
});

describe('resolveRegisteredDrillDownSkillParams', () => {
  test('preserves parameters for external skills outside the drill-down registry', async () => {
    const query = jest.fn();
    const params = {
      frameId: 'vendor-frame',
      startTs: '10',
      endTs: '20',
    };

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId: 'external_workspace_skill',
      params,
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(result).toEqual({params, enriched: false});
    expect(result.params).not.toBe(params);
    expect(query).not.toHaveBeenCalled();
  });

  test('resolves a frame_ts-only frame drill-down to one complete interval', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['match_count', 'frame_id', 'start_ts', 'end_ts', 'dur', 'process_name', 'jank_type'],
      rows: [[1, '8032532', '74829612835103', '74829621168436', '8333333', 'com.example.app', 'App Deadline Missed']],
    });

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '74829612835103', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.enriched).toBe(true);
    expect(result.params).toEqual(expect.objectContaining({
      frame_id: '8032532',
      frame_ts: '74829612835103',
      start_ts: '74829612835103',
      end_ts: '74829621168436',
      process_name: 'com.example.app',
    }));
    expect(result.resolution).toMatchObject({
      entityType: 'frame',
      resolvedEntityId: '8032532',
      resolveSource: 'actual_frame_ts',
    });
  });

  test('fails closed when frame_id and frame_ts resolve to different frames', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['frame_id', 'start_ts', 'end_ts', 'process_name', 'jank_type'],
      rows: [['8032532', '100', '200', 'com.example.app', 'App Deadline Missed']],
    });

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {
        frame_id: '8032532',
        frame_ts: '101',
        process_name: 'com.example.app',
      },
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/frame_ts conflicts with the resolved frame interval/i);
  });

  test('fails closed when jank_frame_detail has no frame entity or interval', async () => {
    const query = jest.fn();

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/requires an entity id, frame timestamp, or complete start_ts\/end_ts interval/i);
    expect(query).not.toHaveBeenCalled();
  });

  test.each([
    'jank_frame_detail',
    'frame_blocking_calls',
    'blocking_chain_analysis',
  ])('accepts a complete explicit interval for %s without an entity lookup', async skillId => {
    const query = jest.fn();
    const params = {process_name: 'com.example.app', start_ts: '100', end_ts: '200'};

    const result = await resolveRegisteredDrillDownSkillParams({
      skillId,
      params,
      traceId: 'trace-1',
      traceProcessorService: {query},
    });

    expect(result).toEqual({
      params: {process_name: 'com.example.app', start_ts: '100', end_ts: '200'},
      enriched: false,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test('fails closed when frame_ts resolves to more than one process-scoped frame', async () => {
    const query = jest.fn().mockResolvedValue({
      columns: ['match_count', 'frame_id', 'start_ts', 'end_ts', 'process_name'],
      rows: [[2, '8032532', '100', '200', 'com.example.app']],
    });

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '100', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/unique frame interval/i);
  });

  test('fails closed when frame_ts does not resolve to a frame', async () => {
    const query = jest.fn().mockResolvedValue({columns: [], rows: []});

    await expect(resolveRegisteredDrillDownSkillParams({
      skillId: 'jank_frame_detail',
      params: {frame_ts: '100', process_name: 'com.example.app'},
      traceId: 'trace-1',
      traceProcessorService: {query},
    })).rejects.toThrow(/unable to resolve/i);
  });
});

describe('drill-down exact process identity', () => {
  it('enriches only startups owned by the exact UPID while preserving named and unscoped lookups', async () => {
    const db = new Database(':memory:');
    const scope = createEffectiveProcessScope('trace', 'current', {upid: 42}, {
      status: 'verified', upids: [42], confidenceScore: 100, evidenceSources: ['upid'], warnings: [],
      candidates: [{rank: 1, confidenceScore: 100, upid: 42, processName: 'com.example'}],
    });
    try {
      db.exec(`
        CREATE TABLE android_startups(startup_id INTEGER, ts INTEGER, dur INTEGER, package TEXT, startup_type TEXT);
        CREATE TABLE android_startup_time_to_display(startup_id INTEGER, time_to_initial_display INTEGER, time_to_full_display INTEGER);
        CREATE TABLE android_startup_processes(startup_id INTEGER, upid INTEGER);
        INSERT INTO android_startups VALUES
          (12, 100, 20, 'com.example', 'cold'),
          (13, 200, 30, 'com.example', 'warm'),
          (14, 300, 40, 'com.example:child', 'cold'),
          (15, 400, 50, 'com.example.similar', 'cold');
        INSERT INTO android_startup_processes VALUES (12,42), (13,43), (14,44), (15,45);
      `);
      const query = jest.fn(async (_traceId: string, sql: string) => {
        const statement = db.prepare<[], unknown[]>(sql);
        return {columns: statement.columns().map(column => column.name), rows: statement.raw().all()};
      });
      const resolve = (startupId: number, processScope = scope, packageName = 'com.example') =>
        resolveRegisteredDrillDownSkillParams({skillId: 'startup_detail',
          params: {startup_id: startupId, package: packageName}, traceId: 'trace',
          traceProcessorService: {query}, processScope});

      const exact = await resolve(12);
      expect(exact.params).toMatchObject({startup_id: '12', start_ts: 100, end_ts: 120});
      for (const startupId of [13, 14, 15]) {
        await expect(resolve(startupId)).rejects.toThrow('Unable to resolve a complete startup interval');
      }

      const namedScope = createEffectiveProcessScope('trace', 'current', {requestedName: 'com.example'});
      for (const [startupId, startTs, endTs] of [[12, 100, 120], [13, 200, 230], [14, 300, 340]]) {
        const named = await resolve(startupId, namedScope);
        expect(named.params).toMatchObject({start_ts: startTs, end_ts: endTs});
      }
      await expect(resolve(15, namedScope)).rejects.toThrow('Unable to resolve a complete startup interval');

      const unscoped = await resolveRegisteredDrillDownSkillParams({skillId: 'startup_detail',
        params: {startup_id: 15}, traceId: 'trace', traceProcessorService: {query}});
      expect(unscoped.params).toMatchObject({startup_id: '15', start_ts: 400, end_ts: 450});
      for (const [, sql] of query.mock.calls) {
        expect(sql).not.toMatch(/\$(?:process_name|upid|startup_id)\b/);
      }
    } finally {
      db.close();
    }
  });

  it('resolves the frame inside the trusted UPID and rejects cross-trace reuse before querying', async () => {
    const Database = require('better-sqlite3');
    const { createEffectiveProcessScope } = require('../../../services/processIdentity/effectiveProcessScope');
    const db = new Database(':memory:');
    const scope = createEffectiveProcessScope('trace', 'current', { upid: 42 }, {
      status: 'verified', upids: [42], confidenceScore: 100, evidenceSources: ['upid'], warnings: [],
      candidates: [{ rank: 1, confidenceScore: 100, upid: 42, processName: 'com.example' }],
    });
    try {
      db.exec(`CREATE TABLE process(upid INTEGER, name TEXT);
        CREATE TABLE actual_frame_timeline_slice(upid INTEGER, display_frame_token INTEGER,
          surface_frame_token INTEGER, ts INTEGER, dur INTEGER, jank_type TEXT, layer_name TEXT);
        INSERT INTO process VALUES (42,'com.example'),(43,'com.example');
        INSERT INTO actual_frame_timeline_slice VALUES (42,7,NULL,100,20,'None','same'),
          (43,7,NULL,10,900,'None','same');`);
      const query = jest.fn(async (_trace: string, sql: string) => {
        const statement = db.prepare(sql);
        return { columns: statement.columns().map((column: {name: string}) => column.name), rows: statement.raw().all() };
      });
      const result = await resolveRegisteredDrillDownSkillParams({ skillId: 'frame_blocking_calls',
        params: { frame_id: 7 }, traceId: 'trace', traceProcessorService: { query }, processScope: scope });
      expect(result.params).toMatchObject({ start_ts: 100, end_ts: 120 });
      expect(result.resolution?.row.upid).toBe(42);
      await expect(resolveRegisteredDrillDownSkillParams({ skillId: 'frame_blocking_calls',
        params: { frame_id: 7 }, traceId: 'reference', traceProcessorService: { query }, processScope: scope }))
        .rejects.toThrow('different trace/side');
      expect(query).toHaveBeenCalledTimes(1);
    } finally { db.close(); }
  });
});
