// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isDeepStrictEqual} from 'node:util';
import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {EvidenceRelationCandidateV1} from '../../types/evidenceContract';
import {isPlainJsonObject} from '../../utils/isPlainJsonObject';

export interface BoundRelationCandidateClaims {
  conclusionContract: ConclusionContract;
  relationActivationClaimIds: string[];
}

const nativeArrayConstructorSource = Function.prototype.toString.call(Array);

function isOrdinaryArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!prototype) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return false;
  const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return Boolean(constructorPrototype && 'value' in constructorPrototype && constructorPrototype.value === prototype &&
    Function.prototype.toString.call(constructor.value) === nativeArrayConstructorSource);
}

/** Ignore only ordinary JSON realm prototypes, never declaration fields. */
function sameRelationDeclaration(
  left: unknown,
  right: unknown,
  leftAncestors = new Set<object>(),
  rightAncestors = new Set<object>(),
): boolean {
  if (Object.is(left, right)) return true;
  const ordinaryArrays = isOrdinaryArray(left) && isOrdinaryArray(right);
  const ordinaryObjects = isPlainJsonObject(left) && isPlainJsonObject(right);
  if (!ordinaryArrays && !ordinaryObjects) return isDeepStrictEqual(left, right);
  const leftObject = left as object;
  const rightObject = right as object;
  if (leftAncestors.has(leftObject) || rightAncestors.has(rightObject)) return false;
  const leftKeys = Reflect.ownKeys(leftObject);
  const rightKeys = new Set(Reflect.ownKeys(rightObject));
  if (leftKeys.length !== rightKeys.size) return false;
  leftAncestors.add(leftObject);
  rightAncestors.add(rightObject);
  try {
    return leftKeys.every(key => {
      if (!rightKeys.has(key)) return false;
      const leftProperty = Object.getOwnPropertyDescriptor(leftObject, key);
      const rightProperty = Object.getOwnPropertyDescriptor(rightObject, key);
      return Boolean(leftProperty && rightProperty && 'value' in leftProperty && 'value' in rightProperty &&
        leftProperty.enumerable === rightProperty.enumerable &&
        sameRelationDeclaration(leftProperty.value, rightProperty.value, leftAncestors, rightAncestors));
    });
  } finally {
    leftAncestors.delete(leftObject);
    rightAncestors.delete(rightObject);
  }
}

/** Select explicit declarations for verification without inventing relation references. */
export function bindRelationCandidatesToClaims(
  conclusionContract: ConclusionContract,
  relationCandidates: EvidenceRelationCandidateV1[],
): BoundRelationCandidateClaims {
  const conclusionContractClone = structuredClone(conclusionContract);
  const candidatesById = new Map<string, EvidenceRelationCandidateV1[]>();
  for (const candidate of relationCandidates) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id.trim()) continue;
    const candidates = candidatesById.get(candidate.id) ?? [];
    candidates.push(candidate);
    candidatesById.set(candidate.id, candidates);
  }
  const unambiguousCandidateIds = new Set([...candidatesById]
    .filter(([, candidates]) => candidates.every(candidate => sameRelationDeclaration(candidate, candidates[0])))
    .map(([id]) => id));
  const claims = conclusionContractClone.claims ?? [];
  const claimIdCounts = new Map<string, number>();
  for (const claim of claims) {
    if (typeof claim.id === 'string') claimIdCounts.set(claim.id, (claimIdCounts.get(claim.id) ?? 0) + 1);
  }
  const relationActivationClaimIds = claims.flatMap(claim => {
    if (typeof claim.id !== 'string' || !claim.id.trim() || claimIdCounts.get(claim.id) !== 1) return [];
    return Array.isArray(claim.relationRefs) && claim.relationRefs.some(id => unambiguousCandidateIds.has(id))
      ? [claim.id] : [];
  });

  return {conclusionContract: conclusionContractClone, relationActivationClaimIds};
}
