// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { IdentityTraceSide, ProcessScopeEvidenceV1 } from '../../types/identityContract';
import type { ProcessIdentityResolution, ProcessIdentityTarget } from './types';
import { buildIdentityResolutionFromProcessGate } from './identityContractMapper';

/** Runtime authority, never recovered from params, save_as, or serialized evidence. */
export interface EffectiveProcessScope {
  readonly mode: 'exact_upid' | 'named' | 'unscoped';
  readonly traceId: string;
  readonly traceSide: IdentityTraceSide;
  readonly upid?: number;
  readonly requestedName?: string;
  readonly identityRefId?: string;
}

const issuedScopes = new WeakSet<object>();
const verifiedIdentities = new WeakMap<object, { target: ProcessIdentityTarget; resolution: ProcessIdentityResolution }>();

export function createEffectiveProcessScope(
  traceId: string,
  traceSide: IdentityTraceSide,
  target?: ProcessIdentityTarget,
  resolution?: ProcessIdentityResolution,
): EffectiveProcessScope {
  const exact = target?.upid !== undefined;
  if (exact && (!Number.isSafeInteger(target.upid) || target.upid! <= 0 ||
      resolution?.status !== 'verified' || resolution.upids.length !== 1 ||
      resolution.upids[0] !== target.upid)) {
    throw new Error('An exact process scope requires one verified selected UPID');
  }
  const identity = buildIdentityResolutionFromProcessGate({ traceId, traceSide, target, resolution });
  const scope: EffectiveProcessScope = Object.freeze({
    mode: exact ? 'exact_upid' : target?.requestedName ? 'named' : 'unscoped',
    traceId,
    traceSide,
    ...(exact ? { upid: target.upid } : {}),
    ...(target?.requestedName ? { requestedName: target.requestedName } : {}),
    ...(identity ? { identityRefId: identity.identityRefId } : {}),
  });
  issuedScopes.add(scope);
  if (target && resolution) {
    const snapshot = structuredClone({ target, resolution });
    snapshot.resolution.candidates.forEach(Object.freeze);
    Object.freeze(snapshot.resolution.candidates);
    Object.freeze(snapshot.resolution.upids);
    Object.freeze(snapshot.resolution.warnings);
    Object.freeze(snapshot.resolution.evidenceSources);
    Object.freeze(snapshot.resolution);
    Object.freeze(snapshot.target);
    verifiedIdentities.set(scope, Object.freeze(snapshot));
  }
  return scope;
}

export function verifiedIdentityForScope(scope: EffectiveProcessScope): {
  target: ProcessIdentityTarget; resolution: ProcessIdentityResolution;
} | undefined {
  assertEffectiveProcessScope(scope, scope.traceId, scope.traceSide);
  const identity = verifiedIdentities.get(scope);
  return identity ? structuredClone(identity) : undefined;
}

export function processScopeEvidence(scope: EffectiveProcessScope): ProcessScopeEvidenceV1 {
  assertEffectiveProcessScope(scope, scope.traceId, scope.traceSide);
  return { ...scope };
}

export function assertEffectiveProcessScope(
  scope: EffectiveProcessScope,
  traceId: string,
  traceSide: IdentityTraceSide,
): void {
  if (!issuedScopes.has(scope) || scope.traceId !== traceId || scope.traceSide !== traceSide) {
    throw new Error('Process scope is untrusted or belongs to a different trace/side');
  }
}
