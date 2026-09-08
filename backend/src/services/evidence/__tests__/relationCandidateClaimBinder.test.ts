// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {runInNewContext} from 'node:vm';
import type {ConclusionContract} from '../../../agent/core/conclusionContract';
import type {EvidenceRelationCandidateV1} from '../../../types/evidenceContract';
import {bindRelationCandidatesToClaims} from '../relationCandidateClaimBinder';

function contract(): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'focused_answer',
    conclusions: [],
    clusters: [],
    evidenceChain: [],
    claims: [{
      id: 'object-row',
      kind: 'causal',
      text: 'Binder overlaps startup',
      references: [{evidenceRefId: 'data:binder', rowIndex: 3, column: 'server_process'}],
      relationRefs: ['model-invented-relation'],
    }, {
      id: 'subject-row',
      kind: 'causal',
      text: 'Startup exists',
      references: [{evidenceRefId: 'data:startup', rowIndex: 1, column: 'start_ts'}],
    }, {
      id: 'proof-row',
      kind: 'causal',
      text: 'Proof exists',
      references: [{evidenceRefId: 'data:proof', rowIndex: 2, column: 'subject_utid'}],
    }, {
      id: 'source-ref-only',
      kind: 'causal',
      text: 'Title matches',
      references: [{sourceRef: 'data:binder', rowIndex: 3, column: 'server_process'}],
    }, {
      id: 'numeric-object-row',
      kind: 'numeric',
      text: 'Binder duration',
      references: [{evidenceRefId: 'data:binder', rowIndex: 3, column: 'dur_str'}],
    }],
    uncertainties: [],
    nextSteps: [],
  };
}

function candidate(): EvidenceRelationCandidateV1 {
  return {
    schemaVersion: 'evidence_relation_candidate@1',
    id: 'relation:startup-binder-overlap:1234',
    kind: 'overlap',
    direction: 'subject_to_object',
    subject: {evidenceRefId: 'data:startup', rowIndex: 1},
    object: {evidenceRefId: 'data:binder', rowIndex: 3},
    proof: {evidenceRefId: 'data:proof', rowIndex: 2},
  };
}

describe('relationCandidateClaimBinder', () => {
  it('preserves the original contract without attaching candidates from matching cells or causal prose', () => {
    const original = contract();
    const before = structuredClone(original);
    const bound = bindRelationCandidatesToClaims(original, [candidate()]);

    expect(original).toEqual(before);
    expect(bound.conclusionContract).not.toBe(original);
    expect(bound.conclusionContract).toEqual(before);
    expect(bound.relationActivationClaimIds).toEqual([]);
  });

  it.each([
    'Binder caused the startup delay',
    '启动延迟由 Binder 引起',
    'Binder did not cause the startup delay',
    'This row records one Binder interval',
  ])('does not infer a relation from the sentence: %s', text => {
    const original = contract();
    original.claims![0].text = text;
    delete original.claims![0].kind;
    expect(bindRelationCandidatesToClaims(original, [candidate()])).toEqual({
      conclusionContract: original, relationActivationClaimIds: [],
    });
  });

  it('activates only an explicit relation reference without rewriting claim labels, cells, or refs', () => {
    const original = contract();
    original.claims![0].relationRefs = [candidate().id, 'unknown-model-reference'];
    original.claims![0].kind = 'numeric';
    original.claims![0].references = [{evidenceRefId: 'different-evidence', rowIndex: 99, column: 'different-cell'}];
    const before = structuredClone(original);

    const bound = bindRelationCandidatesToClaims(original, [candidate()]);

    // Activation requests verification; endpoint/semantic validity belongs to the proof verifier.
    expect(bound.relationActivationClaimIds).toEqual(['object-row']);
    expect(bound.conclusionContract).toEqual(before);
    expect(original).toEqual(before);
  });

  it('keeps unknown explicit refs visible without activating a different candidate', () => {
    const original = contract();
    const bound = bindRelationCandidatesToClaims(original, [candidate()]);
    expect(bound.relationActivationClaimIds).toEqual([]);
    expect(bound.conclusionContract.claims![0].relationRefs).toEqual(['model-invented-relation']);
  });

  it('does not invent IDs for otherwise explicit claims', () => {
    const original = contract();
    original.claims![0].relationRefs = [candidate().id];
    delete original.claims![0].id;
    const bound = bindRelationCandidatesToClaims(original, [candidate()]);
    expect(bound.relationActivationClaimIds).toEqual([]);
    expect(bound.conclusionContract).toEqual(original);
    expect(bound.conclusionContract.claims![0]).not.toHaveProperty('id');
  });

  it('accepts identical repeated declarations but refuses any conflicting candidate with the same ID', () => {
    const original = contract();
    original.claims![0].relationRefs = [candidate().id];
    const same = [candidate(), structuredClone(candidate())];
    expect(bindRelationCandidatesToClaims(original, same).relationActivationClaimIds).toEqual(['object-row']);
    const conflicting = [...same, {...candidate(), object: {evidenceRefId: 'other', rowIndex: 3}}];
    expect(bindRelationCandidatesToClaims(original, conflicting)).toEqual({
      conclusionContract: original, relationActivationClaimIds: [],
    });
    expect(conflicting).toHaveLength(3);
  });

  it('accepts equal JSON declarations across realms and property insertion orders', () => {
    const original = contract(); original.claims![0].relationRefs = [candidate().id];
    const first = {...candidate(), metadata: {label: 'captured', nested: {a: 1, b: [null, true, 'value']}}};
    const reordered = {...candidate(), metadata: {nested: {b: [null, true, 'value'], a: 1}, label: 'captured'}};
    const foreign = runInNewContext('JSON.parse(input)', {input: JSON.stringify(reordered)}) as typeof first;
    expect(bindRelationCandidatesToClaims(original, [first, foreign, structuredClone(first)]).relationActivationClaimIds)
      .toEqual(['object-row']);
  });

  it.each([
    [{nested: {unknown: 'left'}}, {nested: {unknown: 'right'}}],
    [{unknown: undefined}, {}],
    [{unknown: NaN}, {unknown: null}],
    [{unknown: Infinity}, {unknown: null}],
    [{unknown: -0}, {unknown: 0}],
    [{unknown: [1, 2]}, {unknown: [2, 1]}],
    [{unknown: Array(1)}, {unknown: [undefined]}],
  ])('preserves conflicts in all unknown declaration metadata (%j / %j)', (left, right) => {
    const original = contract(); original.claims![0].relationRefs = [candidate().id];
    const declarations = [{...candidate(), metadata: left}, {...candidate(), metadata: right}];
    expect(bindRelationCandidatesToClaims(original, declarations).relationActivationClaimIds).toEqual([]);
    expect(declarations[0].metadata).toBe(left); expect(declarations[1].metadata).toBe(right);
  });

  it('does not ignore array subclasses or custom object prototypes', () => {
    class FirstArray extends Array<number> {}
    class SecondArray extends Array<number> {}
    class Metadata {value = 1;}
    const original = contract(); original.claims![0].relationRefs = [candidate().id];
    const pairs = [[FirstArray.of(1), [1]], [FirstArray.of(1), SecondArray.of(1)], [new Metadata(), {value: 1}]];
    for (const [left, right] of pairs) {
      const declarations = [{...candidate(), metadata: left}, {...candidate(), metadata: right}];
      expect(bindRelationCandidatesToClaims(original, declarations)
        .relationActivationClaimIds).toEqual([]);
    }
  });

  it('keeps extra array, symbol, and non-enumerable metadata visible to conflict detection', () => {
    const original = contract(); original.claims![0].relationRefs = [candidate().id];
    const symbol = Symbol('metadata');
    const pairs = [
      [Object.assign([1], {extra: 'first'}), Object.assign([1], {extra: 'second'})],
      [{[symbol]: 1}, {[symbol]: 2}],
      [Object.defineProperty({}, 'hidden', {value: 1}), Object.defineProperty({}, 'hidden', {value: 2})],
    ];
    for (const [left, right] of pairs) {
      const declarations = [{...candidate(), metadata: left}, {...candidate(), metadata: right}];
      expect(bindRelationCandidatesToClaims(original, declarations)
        .relationActivationClaimIds).toEqual([]);
    }
  });

  it('does not evaluate accessors or accept separate cyclic declarations as JSON duplicates', () => {
    const original = contract(); original.claims![0].relationRefs = [candidate().id];
    let reads = 0;
    const accessor = () => Object.defineProperty({}, 'value', {enumerable: true, get() {reads++; return 1;}});
    const accessors = [{...candidate(), metadata: accessor()}, {...candidate(), metadata: accessor()}];
    expect(bindRelationCandidatesToClaims(original, accessors)
      .relationActivationClaimIds).toEqual([]);
    expect(reads).toBe(0);
    const left: {self?: unknown} = {}; left.self = left;
    const right: {self?: unknown} = {}; right.self = right;
    const cycles = [{...candidate(), metadata: left}, {...candidate(), metadata: right}];
    expect(bindRelationCandidatesToClaims(original, cycles)
      .relationActivationClaimIds).toEqual([]);
  });

  it('does not activate ambiguous duplicate claim IDs', () => {
    const original = contract();
    original.claims![0].relationRefs = [candidate().id];
    original.claims![1].id = original.claims![0].id;
    expect(bindRelationCandidatesToClaims(original, [candidate()])).toEqual({
      conclusionContract: original, relationActivationClaimIds: [],
    });
  });
});
