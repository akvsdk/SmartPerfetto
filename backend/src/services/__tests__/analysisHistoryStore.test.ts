// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it} from '@jest/globals';
import Database from 'better-sqlite3';
import {AnalysisHistoryStore, type AnalysisHistoryScope} from '../analysisHistoryStore';
import {toAnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import {applyEnterpriseMinimalSchema} from '../enterpriseSchema';

let db: Database.Database;
const scope: AnalysisHistoryScope = {tenantId: 't', workspaceId: 'w', userId: 'alice', sessionId: 's', traceId: 'trace', runId: 'run'};
const entry = () => toAnalysisHistoryTurn({id: 'run', turnIndex: 0, traceId: 'trace', timestamp: 1, query: 'why',
  result: {message: 'partial without headings', completion: {status: 'incomplete', reason: 'turn_limit'},
    conclusionContract: {uncertainties: ['missing GPU'], nextSteps: ['inspect fence']}}});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyEnterpriseMinimalSchema(db);
  db.exec(`INSERT INTO organizations(id,name,status,created_at,updated_at) VALUES('t','tenant','active',1,1);
    INSERT INTO workspaces(id,tenant_id,name,created_at,updated_at) VALUES('w','t','workspace',1,1);
    INSERT INTO users(id,tenant_id,email,created_at,updated_at) VALUES('alice','t','alice@example.test',1,1);
    INSERT INTO trace_assets(id,tenant_id,workspace_id,owner_user_id,local_path,status,created_at) VALUES('trace','t','w','alice','fixture','ready',1);
    INSERT INTO analysis_sessions(id,tenant_id,workspace_id,trace_id,created_by,visibility,status,created_at,updated_at)
      VALUES('s','t','w','trace','alice','private','completed',1,1);
    INSERT INTO analysis_runs(id,tenant_id,workspace_id,session_id,mode,status,question,started_at)
      VALUES('run','t','w','s','agent','completed','why',1);`);
});
afterEach(() => {db.close();});

describe('analysis history archive', () => {
  it('restores the full typed turn through a new store instance without promoting proof', () => {
    const first = new AnalysisHistoryStore(db);
    first.append(scope, entry());
    expect(new AnalysisHistoryStore(db).list(scope)).toEqual([entry()]);
    expect(new AnalysisHistoryStore(db).list(scope)[0]).not.toHaveProperty('witness');
  });

  it('retains the original source partition and complete selectors without manufacturing missing fingerprints', () => {
    const source = {...entry(), sourceDerived: true, analysisContextFingerprint: 'original-A',
      evidence: [{artifactId: 'art-1', rowSelector: {utid: 42}, sourceRef: 'source-ref'}]};
    const store = new AnalysisHistoryStore(db);
    store.append(scope, source);
    expect(new AnalysisHistoryStore(db).list(scope)).toEqual([source]);
    const {analysisContextFingerprint: _original, ...legacy} = source;
    store.append(scope, legacy);
    expect(store.list(scope)[0]).not.toHaveProperty('analysisContextFingerprint');
  });

  it.each([{userId: 'bob'}, {tenantId: 'other'}, {workspaceId: 'other'}, {traceId: 'other'}, {sessionId: 'other'}])(
    'does not read or append across scope %j', overrides => {
      const store = new AnalysisHistoryStore(db);
      store.append(scope, entry());
      expect(store.list({...scope, ...overrides})).toEqual([]);
      expect(() => store.append({...scope, ...overrides}, entry())).toThrow();
      expect(store.list(scope)).toEqual([entry()]);
    });

  it('requires a legal owner and exact run parent, and cannot steal another row id', () => {
    const store = new AnalysisHistoryStore(db);
    expect(() => store.list({...scope, userId: ''})).toThrow('scope_required');
    expect(() => store.append({...scope, runId: 'missing'}, entry())).toThrow('parent_not_authorized');
    db.prepare("INSERT INTO conversation_turns VALUES('run','t','w','s','run','message','{}',0)").run();
    expect(() => store.append(scope, entry())).toThrow('id_conflict');
  });

  it('participates in the caller transaction and propagates write failure', () => {
    const store = new AnalysisHistoryStore(db);
    expect(() => db.transaction(() => {store.append(scope, entry()); throw new Error('descriptor failed');})()).toThrow('descriptor failed');
    expect(store.list(scope)).toEqual([]);
    db.exec('DROP TABLE conversation_turns');
    expect(() => store.append(scope, entry())).toThrow();
  });
});
