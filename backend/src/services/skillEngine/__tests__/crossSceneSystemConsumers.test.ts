// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import yaml from 'js-yaml';

function load(name: string, id: string): any {
  const skill = yaml.load(fs.readFileSync(path.join(process.cwd(), 'skills/composite', `${name}.skill.yaml`), 'utf8')) as any;
  return skill.steps.find((s: any) => s.id === id);
}

function query(db: Database.Database, name: string, id: string, extra: Record<string, string> = {}): any[] {
  const step = load(name, id);
  let sql = step.sql as string;
  for (const fragment of step.sql_fragments || []) {
    sql = sql.replace(/\bWITH\s+/i, `WITH ${fs.readFileSync(path.join(process.cwd(), 'skills', fragment), 'utf8')}\n,\n`);
  }
  const params: Record<string, string> = {
    start_ts: '10000000', end_ts: '40000000', main_start_ts: 'NULL', main_end_ts: 'NULL',
    render_start_ts: 'NULL', render_end_ts: 'NULL', event_ts: '10000000', event_end_ts: '40000000',
    anr_ts: '40000000', timeout_ns: '30000000', upid: '42', pid: '100',
    '__process_scope.upid': '42', package: 'com.example.app', process_name: 'com.example.app', ...extra,
  };
  sql = sql.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
    if (!(key in params)) throw new Error(`Unbound parameter ${key}`);
    return params[key];
  });
  return db.prepare(sql).all();
}

function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trace_bounds(start_ts INTEGER,end_ts INTEGER);
    INSERT INTO trace_bounds VALUES(0,50000000);
    CREATE TABLE process(upid INTEGER PRIMARY KEY,pid INTEGER,name TEXT);
    INSERT INTO process VALUES(42,100,'com.example.app'),(43,101,'com.example.app:remote');
    CREATE TABLE thread(utid INTEGER PRIMARY KEY,upid INTEGER,tid INTEGER,name TEXT,is_idle INTEGER);
    INSERT INTO thread VALUES(1,42,100,'main',0),(2,42,102,'RenderThread',0),(3,43,101,'remote',0),(0,NULL,0,'swapper',1);
    CREATE TABLE cpu(id INTEGER PRIMARY KEY,cpu INTEGER,machine_id INTEGER,cluster_id INTEGER,capacity INTEGER);
    INSERT INTO cpu VALUES(0,0,0,0,300),(1,1,0,1,700),(2,2,0,2,1024),(3,3,1,3,NULL);
    CREATE TABLE thread_state(id INTEGER PRIMARY KEY,utid INTEGER,ts INTEGER,dur INTEGER,state TEXT,cpu INTEGER,ucpu INTEGER,io_wait INTEGER,blocked_function TEXT,waker_utid INTEGER);
    INSERT INTO thread_state VALUES
      (1,1,5000000,10000000,'Running',1,1,NULL,NULL,NULL),
      (2,1,15000000,5000000,'R+',1,1,NULL,NULL,NULL),
      (3,1,20000000,5000000,'Running',3,3,NULL,NULL,NULL),
      (4,1,25000000,5000000,'DK',NULL,NULL,NULL,NULL,NULL),
      (5,1,30000000,-1,'S',NULL,NULL,NULL,NULL,NULL),
      (6,3,10000000,30000000,'Running',2,2,NULL,NULL,NULL),
      (7,2,10000000,30000000,'R',NULL,NULL,NULL,NULL,NULL);
    ALTER TABLE thread_state ADD COLUMN irq_context INTEGER;
    CREATE TABLE sched_slice(id INTEGER PRIMARY KEY,utid INTEGER,ts INTEGER,dur INTEGER,cpu INTEGER,ucpu INTEGER,end_state TEXT,priority INTEGER);
    INSERT INTO sched_slice VALUES(1,1,5000000,10000000,1,1,'R+',120),(2,1,20000000,5000000,3,3,'DK',90),(3,3,10000000,30000000,2,2,'S',120);
    CREATE TABLE cpu_frequency_counters(cpu INTEGER,ts INTEGER,dur INTEGER,freq INTEGER);
    INSERT INTO cpu_frequency_counters VALUES(2,0,20000000,1000000),(2,20000000,5000000,3000000),(2,25000000,15000000,2000000);
    ALTER TABLE cpu_frequency_counters ADD COLUMN id INTEGER;
    ALTER TABLE cpu_frequency_counters ADD COLUMN track_id INTEGER;
    ALTER TABLE cpu_frequency_counters ADD COLUMN ucpu INTEGER;
    UPDATE cpu_frequency_counters SET id=rowid,track_id=cpu,ucpu=cpu;
  `);
  return db;
}

describe('cross-scene canonical system consumers', () => {
  it.each([
    ['anr_detail', 'main_thread_quadrant'], ['click_response_detail', 'quadrant_analysis'],
  ])('%s clips states, keeps R+ and DK, and does not turn unknown topology into little', (name, id) => {
    const db = fixture();
    try {
      const rows = query(db, name, id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({upid: 42, utid: 1, q1_big_running_ms: 5, q2_little_running_ms: 0,
        unknown_running_ms: 5, q3_runnable_ms: 5, uninterruptible_ms: 5, interruptible_sleep_ms: 10,
        total_ms: 30, running_pct: 33.3, state_coverage_pct: 100});
    } finally { db.close(); }
  });

  it('retains unknown and pure waiting threads in session and individual-frame evidence', () => {
    const db = fixture();
    try {
      const session = query(db, 'scrolling_analysis', 'session_quadrant_summary');
      expect(session.find(r => r.utid === 1)).toMatchObject({q1_big_pct: 16.7, q2_little_pct: 0, q3_runnable_pct: 16.7, unknown_running_pct: 16.7, total_ms: 30});
      expect(session.find(r => r.utid === 2)).toMatchObject({q3_runnable_pct: 100, total_ms: 30});
      const deep = query(db, 'jank_frame_detail', 'quadrant_analysis');
      expect(deep.find(r => r.utid === 1 && r.quadrant.includes('Unknown'))).toMatchObject({dur_ms: 5, percentage: 16.7});
      expect(deep.find(r => r.utid === 2)).toMatchObject({dur_ms: 30, percentage: 100});
    } finally { db.close(); }
  });

  it.each([['scrolling_analysis', 'session_cpu_freq'], ['jank_frame_detail', 'cpu_freq_analysis']])('%s frequency uses residence time including the pre-window sample', (name, id) => {
    const db = fixture();
    try {
      expect(query(db, name, id)).toEqual([expect.objectContaining({core_type: 'big', avg_freq_mhz: 1833,
        min_freq_mhz: 1000, max_freq_mhz: 3000, frequency_covered_ns: 30000000, frequency_coverage_pct: 100})]);
      db.exec('INSERT INTO cpu VALUES(4,4,0,2,1024)');
      expect(query(db, name, id)[0]).toMatchObject({frequency_coverage_pct:50});
      db.exec('INSERT INTO cpu VALUES(9,2,1,0,1024)');
      // The pinned relation carries UCPU, so repeated per-machine CPU numbers
      // preserve the exact machine's reading rather than invalidating it.
      expect(query(db, name, id)[0]).toMatchObject({avg_freq_mhz:1833,frequency_coverage_pct:50});
      db.exec('UPDATE cpu_frequency_counters SET ucpu=NULL');
      expect(query(db, name, id)).toEqual([]); // Never guess a missing UCPU from its ordinal.
    } finally { db.close(); }
  });

  it('click placement keeps UPID, unknown capacity and kernel priority without inferring policy', () => {
    const db = fixture();
    try {
      expect(query(db, 'click_response_detail', 'cpu_core_analysis')).toEqual([expect.objectContaining({upid:42,utid:1,
        big_core_ms:5,little_core_ms:0,unknown_running_ms:5,total_running_ms:10,priority_min:90,priority_max:120,
        scheduling_policy_evidence:'not_recorded_in_sched_slice'})]);
    } finally { db.close(); }
  });

  it.each([[5000000,10000000],[35000000,10000000],[35000000,-1]])('clips deep IO and Runnable metrics for ts=%i dur=%i without inventing event endpoints', (ts, dur) => {
    const db = fixture();
    try {
      db.exec('DELETE FROM thread_state WHERE utid=1');
      db.prepare("INSERT INTO thread_state(id,utid,ts,dur,state,cpu,ucpu,io_wait,blocked_function) VALUES(50,1,?,?,'D',NULL,NULL,1,'filemap_fault')").run(ts,dur);
      const io = query(db, 'jank_frame_detail', 'io_blocking');
      expect(io).toEqual([expect.objectContaining({upid:42,utid:1,total_ms:5,max_ms:5,blocked_count:1,
        raw_max_wait_ms:dur === -1 ? null : 10,unfinished_wait_count:dur === -1 ? 1 : 0})]);
      const source = String(load('jank_frame_detail', 'root_cause_summary').sql);
      const ctes = source.slice(source.indexOf('system_target_threads AS ('),source.indexOf('-- 8. GPU Fence')).trim().replace(/,\s*$/, '');
      const fragment = fs.readFileSync(path.join(process.cwd(),'skills/fragments/system_thread_state_spans.sql'),'utf8');
      const sql = `WITH system_windows(window_id,window_start_ts,window_end_ts) AS (VALUES('frame',10000000,40000000)),
        target_threads(utid,thread_type) AS (VALUES(1,'MainThread')), ${fragment}, ${ctes}
        SELECT * FROM io_block CROSS JOIN sched_latency`;
      expect(db.prepare(sql).get()).toMatchObject({io_block_ms:5,max_sched_ms:0,total_sched_ms:0});
      db.exec("UPDATE thread_state SET state='R+' WHERE id=50");
      expect(db.prepare(sql).get()).toMatchObject({io_block_ms:0,max_sched_ms:5,total_sched_ms:5});
    } finally { db.close(); }
  });

  it('ANR wakeup counts native successor events while unfinished waits retain only clipped occupancy', () => {
    const db = fixture();
    try {
      db.exec(`DELETE FROM thread_state WHERE utid=1;
        INSERT INTO thread_state(id,utid,ts,dur,state,blocked_function,waker_utid) VALUES
          (50,1,5000000,15000000,'S','futex_wait',NULL),
          (51,1,20000000,5000000,'R',NULL,3),
          (52,1,35000000,-1,'DK','filemap_fault',NULL);`);
      const rows = query(db,'anr_detail','wakeup_chain');
      expect(rows).toEqual([
        expect.objectContaining({upid:42,utid:1,waker_thread:'remote',waker_process:'com.example.app:remote',
          wakeup_count:1,wait_span_count:1,total_sleep_ms:10,raw_max_sleep_ms:15,left_censored_wait_count:1}),
        expect.objectContaining({upid:42,utid:1,waker_thread:'unknown',waker_process:'unknown',
          wakeup_count:0,wait_span_count:1,total_sleep_ms:5,raw_max_sleep_ms:null,unfinished_wait_count:1}),
      ]);
    } finally { db.close(); }
  });

  it('startup migration compares native CPU identities and never derives cluster identity from core type', () => {
    const db = fixture();
    try {
      // One CPU's ordinal differs from UCPU. Two other CPUs share a recorded
      // cluster but have distinct capacities; capacity labels are not clusters.
      db.exec(`UPDATE cpu SET cpu=7 WHERE id=1;
        UPDATE cpu SET cluster_id=1 WHERE id=2;
        DELETE FROM sched_slice WHERE utid=1;
        INSERT INTO sched_slice VALUES
          (10,1,5000000,10000000,7,1,'S',120),
          (11,1,16000000,2000000,7,1,'S',120),
          (12,1,20000000,2000000,2,2,'S',120),
          (13,1,25000000,2000000,0,0,'S',120);`);
      const source = yaml.load(fs.readFileSync(path.join(process.cwd(),'skills/atomic/startup_critical_tasks.skill.yaml'),'utf8')) as any;
      let sql = source.sql as string;
      for (const fragment of source.sql_fragments) sql=sql.replace(/\bWITH\s+/i,`WITH ${fs.readFileSync(path.join(process.cwd(),'skills',fragment),'utf8')},\n`);
      const params: Record<string,string>={start_ts:'10000000',end_ts:'40000000','__process_scope.upid':'42',package:'com.example.app','top_k|15':'15'};
      sql=sql.replace(/\$\{([^}]+)\}/g,(_,key:string)=>params[key]);
      expect((db.prepare(sql).all() as any[]).find(r=>r.utid===1)).toMatchObject({migrations:2,cross_cluster_migrations:1,unknown_cluster_migrations:0});
      db.exec('UPDATE cpu SET cluster_id=NULL WHERE id=0');
      expect((db.prepare(sql).all() as any[]).find(r=>r.utid===1)).toMatchObject({migrations:2,cross_cluster_migrations:null,observed_cross_cluster_migrations:0,unknown_cluster_migrations:1,migration_evidence:'partial_cluster_identity'});
    } finally { db.close(); }
  });

  it('frequency event views preserve source times and isolate repeated CPU ordinals by native UCPU', () => {
    const db = fixture();
    try {
      db.exec(`INSERT INTO cpu VALUES(9,2,1,0,1024);
        INSERT INTO cpu_frequency_counters VALUES(2,22000000,8000000,9000000,4,9,9);`);
      const events = query(db, 'jank_frame_detail', 'cpu_freq_timeline');
      expect(events).toEqual([
        expect.objectContaining({ts:'20000000',ucpu:2,counter_id:2,freq_mhz:3000,prev_freq_mhz:1000,change_direction:'up'}),
        expect.objectContaining({ts:'22000000',ucpu:9,counter_id:4,core_type:'unknown',freq_mhz:9000,prev_freq_mhz:null,change_direction:'unknown'}),
        expect.objectContaining({ts:'25000000',ucpu:2,counter_id:3,freq_mhz:2000,prev_freq_mhz:3000,change_direction:'down'}),
      ]);
      const source = String(load('scrolling_analysis', 'batch_frame_root_cause').sql);
      const ctes = source.slice(source.indexOf('frame_frequency_events AS ('), source.indexOf('-- 10c.')).trim().replace(/,\s*$/, '');
      const fragments = ['system_sched_spans.sql','system_cpu_frequency_spans.sql']
        .map(file => fs.readFileSync(path.join(process.cwd(),'skills/fragments',file),'utf8')).join(',\n');
      const rows = db.prepare(`WITH system_windows(window_id,window_start_ts,window_end_ts) AS
        (VALUES('wide',10000000,40000000),('narrow',22000000,24000000)), ${fragments}, ${ctes}
        SELECT * FROM per_frame_freq_changes ORDER BY frame_key`).all() as any[];
      expect(JSON.parse(rows[0].freq_timeline_json)).toEqual([expect.objectContaining({source_ts:22000000,ucpu:9,counter_id:4,change:'unknown'})]);
      expect(JSON.parse(rows[1].freq_timeline_json)).toHaveLength(3);
    } finally { db.close(); }
  });

  it('session batch executes the maintained query and preserves task identity and clipped denominators', () => {
    const db = fixture();
    try {
      db.aggregate<number[]>('PERCENTILE', {varargs: true, start: () => [],
        step: (values, value) => typeof value === 'number' ? [...values, value] : values,
        result: () => null});
      db.exec(`
        UPDATE trace_bounds SET end_ts=300000000;
        CREATE TABLE counter(ts INTEGER,track_id INTEGER,value INTEGER);
        CREATE TABLE counter_track(id INTEGER,name TEXT);
        CREATE TABLE actual_frame_timeline_slice(ts INTEGER,dur INTEGER,upid INTEGER,display_frame_token INTEGER,surface_frame_token INTEGER);
      `);
      const insert = db.prepare('INSERT INTO actual_frame_timeline_slice VALUES(?,15000000,42,?,?)');
      for (let i = 0; i < 12; i++) insert.run(5000000 + i * 25000000, i, i);
      const rows = query(db, 'scrolling_analysis', 'session_stats_batch', {start_ts:'0',end_ts:'300000000'});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({upid:42,session_id:1,start_ts:'5000000'});
      const quadrants = JSON.parse(rows[0].quadrant_json);
      expect(quadrants).toContainEqual(expect.objectContaining({upid:42,utid:1,total_ms:290,unknown_running_ms:5}));
      expect(quadrants).toContainEqual(expect.objectContaining({upid:42,utid:2,q3_runnable_pct:100,total_ms:30}));
      const affinity = JSON.parse(rows[0].core_affinity_json);
      expect(affinity).toContainEqual(expect.objectContaining({upid:42,utid:1,core_type:'unknown',run_ms:5}));
      expect(affinity.some((r: any) => r.upid !== 42)).toBe(false);
    } finally { db.close(); }
  });

  it('ANR CPU health excludes observed idle and reports partial scheduler coverage', () => {
    const db = fixture();
    try {
      db.exec("INSERT INTO sched_slice VALUES(20,0,10000000,30000000,0,0,'S',120)");
      const rows = query(db, 'anr_analysis', 'system_cpu_health', {
        'anr_ctx.data[0].anr_ts':'40000000','anr_ctx.data[0].timeout_ns':'30000000',
      });
      expect(rows.find(r => r.core_type === 'little')).toMatchObject({total_active_ms:0,avg_util_pct:0,status:'normal',sched_covered_ns:30000000});
      expect(rows.find(r => r.core_type === 'medium')).toMatchObject({total_active_ms:5,status:'insufficient_coverage'});
    } finally { db.close(); }
  });

  it('a frequency decline cannot establish thermal throttling in scrolling context', () => {
    const db = fixture();
    try {
      db.exec(`
        UPDATE trace_bounds SET end_ts=10000000000;
        INSERT INTO cpu_frequency_counters VALUES(2,9000000000,1000000000,500000,4,2,2);
        CREATE TABLE thread_track(id INTEGER,utid INTEGER);
        CREATE TABLE slice(track_id INTEGER,ts INTEGER,dur INTEGER,name TEXT);
        CREATE TABLE actual_frame_timeline_slice(ts INTEGER,upid INTEGER,display_frame_token INTEGER);
      `);
      expect(query(db, 'scrolling_analysis', 'global_context_flags', {start_ts:'0',end_ts:'10000000000'}))
        .toEqual([expect.objectContaining({frequency_decline_observed:1,thermal_trending:null,
          thermal_evidence:'temperature_or_throttle_evidence_required'})]);
    } finally { db.close(); }
  });

  it('batch and session consumers share the canonical relation instead of invoking primitives per frame', () => {
    for (const id of ['session_stats_batch','batch_frame_root_cause','session_quadrant_summary']) {
      const step = load('scrolling_analysis', id);
      expect(step.type).toBe('atomic');
      expect(step.sql_fragments).toContain('fragments/system_thread_state_spans.sql');
      expect(step.sql).toContain('system_windows AS');
      expect(step.sql).toContain('system_target_threads AS');
      expect(step.sql).not.toContain("state = 'R'");
      expect(step.sql).not.toContain("core_type NOT IN ('prime', 'big')");
    }
  });
});
