// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {isReadOnlySql, skillSqlContract} = require('../lib/skill-sql-contract.cjs');

test('root atomic SQL is executable instead of definition-only', () => {
  const contract = skillSqlContract({type: 'atomic', sql: 'SELECT 1'});
  assert.equal(contract.hasRootSql, true);
  assert.deepEqual(contract.sqlIds, ['root']);
  assert.deepEqual(contract.forcedSqlStepIds, []);
});

test('conditional probes include only read-only SQL and recurse into nested steps', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [
      {id: 'setup', type: 'atomic', sql: 'SELECT 1'},
      {
        id: 'parallel',
        type: 'parallel',
        steps: [
          {id: 'read_branch', type: 'atomic', condition: 'enabled', sql: 'WITH x AS (SELECT 1) SELECT * FROM x'},
          {id: 'write_branch', type: 'atomic', condition: 'replace', sql: 'DROP VIEW IF EXISTS x'},
        ],
      },
    ],
  });

  assert.deepEqual(contract.sqlIds, ['setup', 'read_branch', 'write_branch']);
  assert.deepEqual(contract.forcedSqlStepIds, ['read_branch']);
  assert.deepEqual(contract.conditionOnlySqlStepIds, ['write_branch']);
  assert.equal(contract.lastSqlTopLevelIndex, 1);
});

test('metadata-only definitions have no executable SQL contract', () => {
  const contract = skillSqlContract({type: 'pipeline_definition'});
  assert.equal(contract.hasRootSql, false);
  assert.deepEqual(contract.steps, []);
  assert.deepEqual(contract.sqlIds, []);
});

test('forces read-only SQL when its context is produced by an earlier step', () => {
  const contract = skillSqlContract({
    type: 'composite',
    inputs: [{name: 'limit', type: 'integer'}],
    steps: [
      {id: 'summary', type: 'atomic', sql: 'SELECT 1 AS value', save_as: 'summary'},
      {
        id: 'dependent_query',
        type: 'atomic',
        condition: 'summary.data.length > 0',
        sql: 'SELECT * FROM (${summary}) LIMIT ${limit}',
      },
    ],
  });
  assert.deepEqual(contract.forcedSqlStepIds, ['dependent_query']);
  assert.deepEqual(contract.conditionOnlySqlStepIds, []);
});

test('does not force conditional SQL with unresolved context', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [{
      id: 'dependent_query',
      type: 'atomic',
      condition: 'summary.data.length > 0',
      sql: 'SELECT * FROM (${summary.data[0].query})',
    }],
  });
  assert.deepEqual(contract.forcedSqlStepIds, []);
  assert.deepEqual(contract.conditionOnlySqlStepIds, ['dependent_query']);
});

test('recognizes declared runtime scope separately from ordinary input and result variables', () => {
  const steps = [
    {id: 'metadata', type: 'atomic', condition: 'false', process_scope: {role: 'identity_metadata'},
      sql: 'SELECT ${__process_scope.upid} AS selected_upid'},
    {id: 'native', type: 'atomic', condition: 'false', process_scope: {role: 'target', binding: 'native_upid'},
      sql: 'SELECT * FROM process WHERE upid = ${__process_scope.upid}'},
    {id: 'fragment', type: 'atomic', condition: 'false',
      process_scope: {role: 'target', binding: 'effective_target_processes'},
      sql_fragments: ['fragments/effective_target_processes.sql'],
      sql: 'SELECT * FROM effective_target_processes WHERE upid = ${__process_scope.upid}'},
    {id: 'fallback', type: 'atomic', condition: 'false',
      process_scope: {role: 'identity_metadata', exact_unavailable: 'No exact frame evidence'},
      sql: 'SELECT ${__process_scope.upid} IS NULL AS global_request'},
  ];
  const contract = skillSqlContract({type: 'composite', steps});
  assert.deepEqual(contract.forcedSqlStepIds, steps.map(step => step.id));
  assert.deepEqual(contract.conditionOnlySqlStepIds, []);
});

test('does not accept scope authority from declared inputs, prior results, or malformed declarations', () => {
  for (const process_scope of [undefined, {}, [], {role: 'unknown'}, {role: 'target'},
    {role: 'target', binding: 'unknown'}, {role: 'target', binding: 'effective_target_processes'},
    {role: 'identity_metadata', binding: 'native_upid'}, {role: 'identity_metadata', verified: true},
    {role: 'identity_metadata', exact_unavailable: ''}, {role: 'identity_metadata', context_fields: {target: ['upid']}}]) {
    const contract = skillSqlContract({type: 'composite', inputs: [{name: '__process_scope', type: 'object'}],
      steps: [{id: 'setup', type: 'atomic', sql: 'SELECT 42 AS upid', save_as: '__process_scope'},
        {id: 'scope_query', type: 'atomic', condition: 'false', process_scope,
          sql: 'SELECT ${__process_scope.upid} AS selected_upid'}]});
    assert.deepEqual(contract.forcedSqlStepIds, []);
    assert.deepEqual(contract.conditionOnlySqlStepIds, ['scope_query']);
  }
});

test('refuses unknown reserved paths, defaults, and state-changing scoped probes', () => {
  for (const token of ['${__process_scope}', '${__process_scope.other}', '${__process_scope[upid]}',
    '${__process_scope.upid|42}', '${ __process_scope.upid }']) {
    const contract = skillSqlContract({type: 'composite', steps: [{id: 'query', type: 'atomic', condition: 'false',
      process_scope: {role: 'identity_metadata'}, sql: `SELECT ${token}`} ]});
    assert.deepEqual(contract.forcedSqlStepIds, []);
    assert.deepEqual(contract.conditionOnlySqlStepIds, ['query']);
  }
  const write = skillSqlContract({type: 'composite', steps: [{id: 'write', type: 'atomic', condition: 'false',
    process_scope: {role: 'target', binding: 'native_upid'}, sql: 'DELETE FROM process WHERE upid = ${__process_scope.upid}'}]});
  assert.deepEqual(write.forcedSqlStepIds, []);
  assert.deepEqual(write.conditionOnlySqlStepIds, ['write']);
});

test('does not classify data-changing CTE statements as read-only', () => {
  assert.equal(isReadOnlySql('WITH doomed AS (SELECT id FROM x) DELETE FROM x WHERE id IN doomed'), false);
  assert.equal(isReadOnlySql('WITH rows AS (SELECT 1) SELECT * FROM rows'), true);
});

test('keeps root and step SQL visible so hybrid definitions can be rejected', () => {
  const contract = skillSqlContract({
    type: 'atomic',
    sql: 'SELECT 1',
    steps: [{id: 'hidden_step', type: 'atomic', sql: 'SELECT 2'}],
  });
  assert.equal(contract.hasRootSql, true);
  assert.equal(contract.hasStepSql, true);
  assert.deepEqual(contract.sqlIds, ['root', 'hidden_step']);
});

test('records exact SQL hashes, declared modules, and result columns from source', () => {
  const rootSql = 'SELECT 1 AS status';
  const contract = skillSqlContract({
    type: 'atomic',
    prerequisites: {modules: ['android.frames.timeline']},
    display: {
      columns: [
        {name: 'status', type: 'number'},
        {name: 'label', type: 'string'},
      ],
    },
    sql: rootSql,
  });

  assert.deepEqual(contract.declaredModules, ['android.frames.timeline']);
  assert.deepEqual(contract.sqlSourceSteps, [{
    id: 'root',
    sha256: crypto.createHash('sha256').update(rootSql).digest('hex'),
    requiredColumns: ['status', 'label'],
  }]);
});

test('derives result columns from the outer SQL projection when display metadata is absent', () => {
  const contract = skillSqlContract({
    type: 'composite',
    steps: [{
      id: 'summary',
      type: 'atomic',
      sql: `
        WITH source AS (
          SELECT id, value FROM counter
        )
        SELECT
          source.id,
          ROUND(AVG(value), 2) AS avg_value,
          COUNT(*) call_count,
          'stable' AS status
        FROM source
        GROUP BY source.id
      `,
    }],
  });

  assert.deepEqual(
    contract.sqlSourceSteps[0].requiredColumns,
    ['id', 'avg_value', 'call_count', 'status'],
  );
});
