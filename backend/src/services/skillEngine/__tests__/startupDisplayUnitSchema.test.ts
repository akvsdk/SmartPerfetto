// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import Database from 'better-sqlite3';
import {describe, it, expect} from '@jest/globals';
import {createSkillExecutor} from '../skillExecutor';
import {ArtifactStore} from '../../../agentv3/artifactStore';

describe('startup display unit contracts', () => {
  const loadYaml = (relativePath: string) => {
    const skillPath = path.join(process.cwd(), relativePath);
    return yaml.load(fs.readFileSync(skillPath, 'utf-8')) as any;
  };

  const getColumn = (columns: any[], name: string) => {
    const column = columns?.find((c: any) => c.name === name);
    expect(column).toBeDefined();
    return column;
  };

  it('startup_events_in_range exposes ms display and ns jump fields consistently', () => {
    const skill = loadYaml('skills/atomic/startup_events_in_range.skill.yaml');
    const columns = skill.display?.columns || [];

    // dur_ms is the visible human-readable column; dur_ns is hidden, used by
    // start_ts.clickAction navigate_range. Original spec had this swapped, but
    // commit 0bae10a5 fixed dur_ns 32-bit overflow by showing dur_ms instead.
    const durMs = getColumn(columns, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');
    expect(durMs.hidden).not.toBe(true);

    const startTs = getColumn(columns, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');
    expect(startTs.clickAction).toBe('navigate_range');
    expect(startTs.durationColumn).toBe('dur_ns');

    const durNs = getColumn(columns, 'dur_ns');
    expect(durNs.type).toBe('duration');
    expect(durNs.format).toBe('duration_ms');
    expect(durNs.unit).toBe('ns');
    expect(durNs.hidden).toBe(true);

    const ttid = getColumn(columns, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const ttfd = getColumn(columns, 'ttfd_ms');
    expect(ttfd.type).toBe('duration');
    expect(ttfd.format).toBe('duration_ms');
    expect(ttfd.unit).toBe('ms');
  });

  it('startup_detail uses ms display units for startup and CPU/quadrant durations', () => {
    const skill = loadYaml('skills/composite/startup_detail.skill.yaml');
    const getStep = (id: string) => {
      const step = skill.steps?.find((s: any) => s.id === id);
      expect(step).toBeDefined();
      return step;
    };

    const startupInfoCols = getStep('startup_info').display?.columns || [];
    const durMs = getColumn(startupInfoCols, 'dur_ms');
    expect(durMs.type).toBe('duration');
    expect(durMs.format).toBe('duration_ms');
    expect(durMs.unit).toBe('ms');

    const ttid = getColumn(startupInfoCols, 'ttid_ms');
    expect(ttid.type).toBe('duration');
    expect(ttid.format).toBe('duration_ms');
    expect(ttid.unit).toBe('ms');

    const startTs = getColumn(startupInfoCols, 'start_ts');
    expect(startTs.type).toBe('timestamp');
    expect(startTs.unit).toBe('ns');

    const cpuCoreCols = getStep('cpu_core_analysis').display?.columns || [];
    for (const name of ['big_core_ms', 'little_core_ms', 'total_running_ms']) {
      const col = getColumn(cpuCoreCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    // quadrant_analysis exposes per-quadrant *_ms columns + per-quadrant *_pct
    // columns (Q1 big-running / Q2 little-running / Q3 runnable / Q4a io / Q4b sleep)
    // — there is no generic dur_ms / quadrant / percentage column.
    const quadrantCols = getStep('quadrant_analysis').display?.columns || [];
    for (const name of ['q1_big_running_ms', 'q2_little_running_ms', 'q3_runnable_ms', 'q4a_io_blocked_ms', 'q4b_sleeping_ms', 'total_ms']) {
      const col = getColumn(quadrantCols, name);
      expect(col.type).toBe('duration');
      expect(col.format).toBe('duration_ms');
      expect(col.unit).toBe('ms');
    }

    const threadType = getColumn(quadrantCols, 'thread_type');
    expect(threadType.type).toBe('string');

    const q1Pct = getColumn(quadrantCols, 'q1_pct');
    expect(q1Pct.type).toBe('percentage');
    expect(q1Pct.format).toBe('percentage');
  });

  // Execute the maintained YAML queries, including their real target fragment.
  // Only fixture parameter substitution is local to this test.
  const query = (db: Database.Database, target: string, options: {
    start?: number; end?: number; upid?: number | null; packageName?: string;
  } = {}) => {
    db.exec('UPDATE thread_state SET ucpu=cpu; UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu');
    const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
    const node = target === 'critical_tasks'
      ? loadYaml('skills/atomic/startup_critical_tasks.skill.yaml')
      : detail.steps.find((step: any) => step.id === target);
    expect(node).toBeDefined();
    let sql = node.sql as string;
    for (const fragment of node.sql_fragments || []) {
      const text = fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8');
      sql = sql.replace(/\bWITH\s+/i, `WITH ${text}\n,\n`);
    }
    const parameters: Record<string, string> = {
      start_ts: String(options.start ?? 10000000),
      end_ts: String(options.end ?? 40000000),
      '__process_scope.upid': String(options.upid === null ? 'NULL' : options.upid ?? 42),
      package: options.packageName ?? 'com.example.app',
      'top_k|15': '15',
    };
    sql = sql.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      expect(parameters[key]).toBeDefined();
      return parameters[key];
    });
    return db.prepare(sql).all() as Array<Record<string, any>>;
  };

  const fixture = () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE process(upid INTEGER PRIMARY KEY, pid INTEGER, name TEXT);
      CREATE TABLE thread(utid INTEGER PRIMARY KEY, tid INTEGER, upid INTEGER, name TEXT,is_idle INTEGER DEFAULT 0);
      CREATE TABLE sched_slice(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER,
        ucpu INTEGER, utid INTEGER, end_state TEXT, priority INTEGER);
      CREATE TABLE thread_state(id INTEGER PRIMARY KEY, ts INTEGER, dur INTEGER, cpu INTEGER,
        utid INTEGER, state TEXT,ucpu INTEGER,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER,irq_context INTEGER);
      CREATE TABLE cpu_frequency_counters(cpu INTEGER, ts INTEGER, dur INTEGER, freq INTEGER,id INTEGER,track_id INTEGER,ucpu INTEGER);
      CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
      INSERT INTO trace_bounds VALUES(0,100000000);
      CREATE TABLE cpu(id INTEGER,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
      INSERT INTO cpu VALUES(0,0,NULL,0,300),(7,7,NULL,1,1024),(10,10,NULL,2,512);
      CREATE TABLE _cpu_topology(cpu_id INTEGER PRIMARY KEY, core_type TEXT, topology_source TEXT);
      INSERT INTO process VALUES (42,100,'com.example.app'),(43,101,'com.example.app'),
        (99,900,'system_server');
      INSERT INTO thread(utid,tid,upid,name) VALUES (1,100,42,'main'),(2,102,42,'worker'),
        (3,900,99,'system_server'),(4,101,43,'other incarnation');
      INSERT INTO thread VALUES(0,0,NULL,'swapper',1);
      INSERT INTO _cpu_topology VALUES (0,'little','capacity_scale'),(7,'big','capacity_scale');
    `);
    return db;
  };

  it('weights frequency only over the true intersection of running, counter and selected window', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,12000000,7,7,1,'S',120),
          (2,30000000,20000000,7,7,1,'S',120),
          (3,12000000,18000000,7,7,3,'S',100),
          (4,10000000,30000000,0,0,4,'S',120);
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (7,0,35000000,1000000),
          (7,35000000,65000000,2000000);
      `);
      expect(query(db, 'cpu_freq_analysis', {packageName: 'stale.display.name'})).toEqual([
        expect.objectContaining({core_type: 'big', avg_freq_mhz: 1417, min_freq_mhz: 1000, max_freq_mhz: 2000}),
      ]);
      const rows = query(db, 'per_cpu_system_context', {packageName: 'stale.display.name'});
      expect(rows.every(row => row.upid === 42 && row.utid === 1)).toBe(true);
      expect(rows.find(row => row.cpu === 7)).toMatchObject({
        avg_freq_mhz: 1166.67, freq_coverage_ms: 30, freq_coverage_pct: 100,
        sched_coverage_ms: 30, system_busy_ms: 30, system_busy_pct: 100,
        target_main_running_ms: 12, topology_source: 'recorded_capacity',
        evidence_scope: 'system_context_not_causal_attribution',
      });
      // The peer's CPU work survives exact target binding; other incarnations
      // are system context, not target work.
      expect(rows.find(row => row.cpu === 0)).toMatchObject({system_busy_ms: 30, target_main_running_ms: 0});
    } finally { db.close(); }
  });

  it('preserves missing frequency, missing scheduler data and unknown topology without fabricating zero load', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,10000000,30000000,0,0,0,'S',120);
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (10,20000000,10000000,1500000);
      `);
      expect(query(db, 'cpu_freq_analysis')).toEqual([]);
      const rows = query(db, 'per_cpu_system_context');
      expect(rows.find(row => row.cpu === 0)).toMatchObject({
        avg_freq_mhz: null, min_freq_mhz: null, max_freq_mhz: null,
        freq_coverage_ms: 0, freq_coverage_pct: 0,
        sched_coverage_ms: 30, system_busy_ms: 0, target_main_running_ms: 0,
      });
      expect(rows.find(row => row.cpu === 10)).toMatchObject({
        core_type: 'unknown', topology_source: 'capacity_incomplete', avg_freq_mhz: 1500,
        freq_coverage_ms: 10, freq_coverage_pct: 33.33,
        sched_coverage_ms: 0, system_busy_ms: null, system_busy_pct: null,
        target_main_running_ms: null,
      });
      // A known CPU without any observation in this window remains visible
      // as unknown; absence of data is not an idle/offline observation.
      expect(rows.find(row => row.cpu === 7)).toMatchObject({
        core_type: 'unknown', topology_source: 'capacity_incomplete', capacity: 1024, avg_freq_mhz: null,
        freq_coverage_ms: 0, sched_coverage_ms: 0, system_busy_ms: null,
        target_main_running_ms: null,
      });
    } finally { db.close(); }
  });

  it('links only R+ actual switch points to the exact next task on the same ucpu and preserves peer identity', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES
          (1,0,15000000,7,7,1,'R+',120),
          (2,15000000,5000000,7,7,3,'S',90),
          (3,15000000,5000000,0,0,3,'S',80),
          (4,20000000,2000000,7,7,1,'R',110),
          (5,11000000,5000000,0,0,2,'R+',NULL),
          (6,17000000,1000000,0,0,3,'S',95),
          (7,25000000,15000000,7,7,1,'R+',110),
          (8,10000000,5000000,4,4,4,'R+',90),
          (9,26000000,-1,0,0,2,'R+',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,15000000,25000000,NULL,1,'R+');
      `);
      const rows = query(db, 'preemption', {end: 30000000, packageName: 'stale.display.name'});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({sched_id: 1, switch_ts: '15000000', upid: 42, utid: 1,
        next_sched_id: 2, next_upid: 99, next_utid: 3, next_process_name: 'system_server',
        priority: 120, next_priority: 90, observed_wait_ms: 15,
        wait_evidence: 'observed_runnable_preempted',
        handoff_evidence: 'exact_same_cpu_handoff_not_causal_duration',
        scheduling_policy_evidence: 'not_recorded_in_sched_slice'});
      expect(rows[1]).toMatchObject({sched_id: 5, switch_ts: '16000000', priority: null,
        next_sched_id: null, observed_wait_ms: null,
        wait_evidence: 'missing_runnable_state', handoff_evidence: 'next_task_not_observed'});
      // The selected end at 30ms is not the actual R+ switch at 40ms.
      expect(rows.some(row => row.sched_id === 7)).toBe(false);
    } finally { db.close(); }
  });

  it('does not substitute ordinary Runnable or incomplete state duration for observed R+ waiting', () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,10000000,7,7,1,'R+',120),
          (2,20000000,5000000,7,7,1,'R+',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,10000000,10000000,NULL,1,'R'),
          (2,25000000,-1,NULL,1,'R+');
      `);
      const rows = query(db, 'preemption');
      expect(rows[0]).toMatchObject({switch_ts: '10000000', observed_wait_ms: null, wait_evidence: 'missing_runnable_state'});
      expect(rows[1]).toMatchObject({observed_wait_ms: null, wait_evidence: 'incomplete_runnable_state'});
    } finally { db.close(); }
  });

  it('keeps critical-task priorities as observations and clips R+ states without inventing a scheduling policy', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL,cluster_id=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,0,15000000,7,7,1,'R+',120),
          (2,40000000,10000000,0,0,1,'S',90),
          (3,10000000,5000000,10,10,2,'S',NULL),
          (4,20000000,5000000,7,7,2,'S',NULL);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,15000000,7,1,'Running'),
          (2,15000000,25000000,NULL,1,'R+'),(3,40000000,10000000,0,1,'Running'),
          (4,50000000,50000000,NULL,1,'S'),(5,10000000,5000000,10,2,'Running'),
          (6,20000000,5000000,7,2,'Running'),(7,10000000,50000000,7,4,'Running');
      `);
      const rows = query(db, 'critical_tasks', {end: 60000000, packageName: 'stale.display.name'});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({upid: 42, pid: 100, utid: 1, tid: 100,
        window_start_ts: 10000000, window_end_ts: 60000000, total_observed_threads: 2,
        total_cpu_ms: 15, q3_runnable_ms: 25, runnable_preempted_ms: 25, total_ms: 50,
        priority_min: 90, priority_max: 120, priority_value_count: 2, preemption_count: 1,
        priority_evidence: 'observed_kernel_priority_only', scheduling_policy_evidence: 'not_recorded_in_sched_slice'});
      expect(rows[1]).toMatchObject({utid: 2, priority_min: null, priority_max: null,
        priority_value_count: 0, preemption_count: 0, priority_evidence: 'kernel_priority_unavailable',
        unknown_running_ms: 10, cross_cluster_migrations: null, observed_cross_cluster_migrations: 0,
        unknown_cluster_migrations: 1, migration_evidence: 'partial_cluster_identity'});
    } finally { db.close(); }
  });

  it('retains the main thread and long-waiting tasks when no CPU slice or priority was recorded', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,50000000,NULL,1,'R+'),
        (2,5000000,50000000,NULL,2,'R');`);
      const rows = query(db, 'critical_tasks');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({utid: 1, total_cpu_ms: 0, q3_runnable_ms: 30,
        runnable_preempted_ms: 30, priority_min: null, priority_max: null,
        preemption_count: null, priority_evidence: 'sched_slice_unavailable'});
      expect(rows[1]).toMatchObject({utid: 2, q3_runnable_ms: 30, runnable_preempted_ms: 0});
    } finally { db.close(); }
  });

  it('does not prescribe FIFO or assert contention/cache damage from parallel CPU totals or migrations alone', () => {
    const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
    const rules = detail.steps.find((step: any) => step.id === 'startup_diagnosis').rules;
    expect(JSON.stringify(rules)).not.toContain('考虑使用 SCHED_FIFO');
    expect(JSON.stringify(rules)).not.toContain('L2 Cache 反复失效导致性能损失');
    expect(JSON.stringify(rules)).not.toContain('CPU 争抢激烈');
    expect(detail.steps.find((step: any) => step.id === 'preemption').process_scope.context_fields.peer_context)
      .toContain('next_upid');
    expect(detail.steps.find((step: any) => step.id === 'per_cpu_system_context').process_scope.context_fields.global_context)
      .toContain('system_busy_ms');
  });

  it('accounts for unknown running and other observed states without assigning them to little cores', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE cpu SET capacity=NULL WHERE id=10;
        INSERT INTO sched_slice VALUES (1,10000000,10000000,10,10,1,'R',120);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,10000000,10000000,10,1,'Running'),
          (2,20000000,10000000,NULL,1,'R'),(3,30000000,10000000,NULL,1,'T');
      `);
      expect(query(db, 'cpu_core_analysis')).toEqual([
        expect.objectContaining({big_core_ms: 0, little_core_ms: 0, total_running_ms: 10,
          unknown_core_ms: 10, unknown_core_pct: 100, classify_method: 'capacity_incomplete'}),
      ]);
      const quadrant = query(db, 'quadrant_analysis')[0];
      expect(quadrant).toMatchObject({q1_big_running_ms: 0, q2_little_running_ms: 0,
        q3_runnable_ms: 10, unknown_running_ms: 10, other_state_ms: 10, total_ms: 30});
      expect(quadrant.q1_big_running_ms + quadrant.q2_little_running_ms + quadrant.q3_runnable_ms +
        quadrant.q4a_io_blocked_ms + quadrant.q4b_sleeping_ms + quadrant.unknown_running_ms + quadrant.other_state_ms)
        .toBe(quadrant.total_ms);
      expect(query(db, 'critical_tasks')).toEqual([
        expect.objectContaining({total_cpu_ms: 10, q1_big_running_ms: 0, q2_little_running_ms: 0,
          unknown_running_ms: 10, other_state_ms: 10, q3_runnable_ms: 10, total_ms: 30}),
      ]);
    } finally { db.close(); }
  });

  it('preserves every system evidence locator through production display projection and restored artifact fetch', async () => {
    const db = fixture();
    try {
      db.exec(`
        INSERT INTO sched_slice VALUES (1,0,15000000,7,7,1,'R+',120),
          (2,15000000,15000000,7,7,3,'S',90),
          (3,30000000,10000000,7,7,1,'S',110),
          (4,10000000,5000000,0,0,2,'S',NULL);
        INSERT INTO thread_state (id,ts,dur,cpu,utid,state) VALUES (1,0,15000000,7,1,'Running'),
          (2,15000000,15000000,NULL,1,'R+'),(3,30000000,10000000,7,1,'Running'),
          (4,10000000,5000000,0,2,'Running');
        INSERT INTO cpu_frequency_counters(cpu,ts,dur,freq) VALUES (7,0,100000000,1500000);
      `);
      const sources = ['per_cpu_system_context', 'preemption', 'critical_tasks'];
      const rawRows = Object.fromEntries(sources.map(id => [id, query(db, id)]));
      const detail = loadYaml('skills/composite/startup_detail.skill.yaml');
      const critical = loadYaml('skills/atomic/startup_critical_tasks.skill.yaml');
      // Validate both projection directions: a declared evidence column must
      // exist in SQL rows, not merely preserve whichever columns SQL returned.
      for (const column of critical.display.columns) {
        expect(Object.prototype.hasOwnProperty.call(rawRows.critical_tasks[0], column.name)).toBe(true);
      }
      // The fixture processor returns the SQL rows already tested above.
      // Keep production parent/child display contracts and execute the real
      // nested Skill path, where unlisted columns would otherwise be dropped.
      const executor = createSkillExecutor({
        query: async (_traceId: string, sql: string) => {
          const id = sources.find(source => sql.includes(`'${source}'`));
          expect(id).toBeDefined();
          const rows = rawRows[id!];
          const columns = Object.keys(rows[0]);
          return {columns, rows: rows.map(row => columns.map(column => row[column]))};
        },
        touchTrace: () => undefined,
      });
      executor.registerSkill(JSON.parse(JSON.stringify({...critical, identity: undefined, prerequisites: undefined,
        sql_fragments: undefined, sql: "SELECT 'critical_tasks' AS fixture_source"})));
      executor.registerSkill(JSON.parse(JSON.stringify({...detail, identity: undefined, prerequisites: undefined,
        steps: detail.steps.filter((step: any) => sources.includes(step.id)).map((step: any) =>
          step.type === 'skill' ? step : {...step, sql_fragments: undefined,
            sql: `SELECT '${step.id}' AS fixture_source`})})));
      const result = await executor.execute('startup_detail', 'system-evidence-delivery', {
        startup_id: 1, package: 'com.example.app', startup_type: 'cold',
        start_ts: 10000000, end_ts: 40000000, dur_ms: 30,
      });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(Object.fromEntries(Object.entries(result.rawResults || {}).map(([id, step]) => [id,
        {success: step.success, error: step.error}]))).toEqual(Object.fromEntries(sources.map(id => [id,
          {success: true, error: undefined}])));
      const store = new ArtifactStore();
      for (const source of sources) {
        const display = result.displayResults.find(item => item.stepId === source);
        expect(display).toBeDefined();
        const data = display!.data as {columns: string[]; rows: unknown[][]};
        // Store dr.data exactly as the MCP artifact adapter does; fetching raw
        // result.data here would conceal projection regressions.
        const id = store.store({skillId: detail.name, stepId: source, data});
        const restored = ArtifactStore.fromSnapshot(JSON.parse(JSON.stringify(store.serialize())));
        const fetched = restored.fetch(id, 'rows');
        expect(data.rows).toHaveLength(rawRows[source].length);
        expect(fetched.rows).toHaveLength(rawRows[source].length);
        for (const [index, raw] of rawRows[source].entries()) {
          for (const [column, value] of Object.entries(raw)) {
            expect(data.columns).toContain(column);
            expect(fetched.columns).toContain(column);
            // The established display formatter renders null as '-'. Explicit
            // evidence status survives so unavailable never means numeric zero.
            const displayedValue = value === null ? '-' : value;
            expect(data.rows[index][data.columns.indexOf(column)]).toBe(displayedValue);
            expect(fetched.rows[index][fetched.columns.indexOf(column)]).toBe(displayedValue);
          }
        }
      }
    } finally { db.close(); }
  });
});
