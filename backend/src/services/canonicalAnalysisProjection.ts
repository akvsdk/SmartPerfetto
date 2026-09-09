// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {analysisDeliveryFingerprint, sameAnalysisCandidate, type AnalysisCandidateIdentity} from '../types/analysisDelivery';
import type {ConclusionContract} from '../agent/core/conclusionContract';
import type {NativeConclusionDeclaration} from './security/conclusionProtocolProjection';

/** Internal receipt; neither this object nor its private manifest enters result JSON. */
export interface CanonicalAnalysisProjection {
  readonly disposition: 'preserved' | 'protocol_projection';
  readonly inputFingerprint: string;
  readonly outputFingerprint: string;
  readonly sourceCandidate?: Readonly<AnalysisCandidateIdentity>;
  readonly candidate?: Readonly<AnalysisCandidateIdentity>;
}

type ProsePath = readonly (string | number)[];
interface ProseField {readonly path: ProsePath; readonly text: string; readonly parent: string}
interface ProseState {
  readonly sessionId: string;
  readonly nativeDeclaration: NativeConclusionDeclaration;
  readonly canonicalBody: string;
  readonly fields: ReadonlyMap<string, ProseField>;
}
const issued = new WeakMap<CanonicalAnalysisProjection, ProseState | undefined>();
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fieldIdentity = (value: object, key: string) => own(value, key)
  ? {present: true, value: (value as Record<string, unknown>)[key]} : {present: false};

/** Explicit paths only: protocol values, machine references and unknown fields have no prose role. */
function proseFields(contract: ConclusionContract): Map<string, ProseField> {
  const fields = new Map<string, ProseField>();
  const add = (path: ProsePath, text: unknown, parent: unknown) => {
    if (typeof text === 'string') fields.set(JSON.stringify(path), {
      path: Object.freeze([...path]), text, parent: analysisDeliveryFingerprint(parent),
    });
  };
  for (const [index, claim] of (contract.claims ?? []).entries()) {
    if (!claim || typeof claim.id !== 'string' || !claim.id.trim() ||
      contract.claims?.filter(other => other?.id === claim.id).length !== 1) continue;
    const parent = {id: claim.id, kind: fieldIdentity(claim, 'kind'), conclusionId: fieldIdentity(claim, 'conclusionId')};
    if (own(claim, 'text')) add(['claims', index, 'text'], claim.text, parent);
    claim.semantics?.conditions?.forEach((text, condition) =>
      add(['claims', index, 'semantics', 'conditions', condition], text, parent));
  }
  contract.conclusions.forEach((item, index) => {
    for (const key of ['statement', 'trigger', 'supply', 'amplification'] as const) {
      if (own(item, key)) add(['conclusions', index, key], item[key], {rank: fieldIdentity(item, 'rank')});
    }
  });
  contract.clusters.forEach((item, index) => {
    for (const key of ['cluster', 'description'] as const) {
      if (own(item, key)) add(['clusters', index, key], item[key], {cluster: fieldIdentity(item, 'cluster')});
    }
  });
  contract.evidenceChain.forEach((item, index) => {
    if (own(item, 'text')) add(['evidenceChain', index, 'text'], item.text, {conclusionId: fieldIdentity(item, 'conclusionId')});
  });
  for (const key of ['uncertainties', 'nextSteps'] as const) {
    contract[key].forEach((text, index) => add([key, index], text, key));
  }
  return fields;
}

export function isIssuedCanonicalAnalysisProjection(value: unknown): value is CanonicalAnalysisProjection {
  return typeof value === 'object' && value !== null && issued.has(value as CanonicalAnalysisProjection);
}

/** Called only by canonicalization after original parser selection and candidate binding. */
export function issueCanonicalAnalysisProjection(input: CanonicalAnalysisProjection, prose?: {
  sessionId: string; nativeDeclaration: NativeConclusionDeclaration; canonicalBody: string; contract: ConclusionContract;
}): CanonicalAnalysisProjection {
  const projection = Object.freeze({...input,
    ...(input.sourceCandidate ? {sourceCandidate: Object.freeze({...input.sourceCandidate})} : {}),
    ...(input.candidate ? {candidate: Object.freeze({...input.candidate})} : {}),
  });
  issued.set(projection, prose ? {sessionId: prose.sessionId, nativeDeclaration: prose.nativeDeclaration,
    canonicalBody: prose.canonicalBody, fields: proseFields(prose.contract)} : undefined);
  return projection;
}

/** The caller separately checks the live native receipt and its original runtime display identity. */
export function matchingCanonicalAnalysisProseFields(input: {
  projection: CanonicalAnalysisProjection; sessionId: string; nativeDeclaration: NativeConclusionDeclaration;
  sourceCandidate: AnalysisCandidateIdentity; candidate: AnalysisCandidateIdentity; body: string; contract: ConclusionContract;
}): readonly ProsePath[] {
  const state = issued.get(input.projection);
  if (!state || state.sessionId !== input.sessionId || state.nativeDeclaration !== input.nativeDeclaration ||
    state.canonicalBody !== input.body || input.projection.outputFingerprint !== analysisDeliveryFingerprint(input.body) ||
    analysisDeliveryFingerprint(input.projection.sourceCandidate) !== analysisDeliveryFingerprint(input.sourceCandidate) ||
    !sameAnalysisCandidate(input.projection.candidate, input.candidate, input.body)) return [];
  const matches: ProsePath[] = [];
  for (const [key, current] of proseFields(input.contract)) {
    const original = state.fields.get(key);
    if (original && original.parent === current.parent && original.text === current.text) matches.push(original.path);
  }
  return matches;
}
