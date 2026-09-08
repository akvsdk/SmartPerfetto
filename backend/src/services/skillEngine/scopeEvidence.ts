// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { mergeScopeProvenance, scopeMetadata, type EvidenceScopeEntryV1,
  type EvidenceScopeProvenanceV1, type ProcessScopeEvidenceV1 } from '../../types/identityContract';
import { processScopeEvidence } from '../processIdentity/effectiveProcessScope';
import type { SkillExecutionContext, StepResult } from './types';
import type { ScopedSqlSource } from './processScopeSql';

export function sqlScopeEvidence(source: ScopedSqlSource, context: SkillExecutionContext,
  stepId: string, data?: unknown, unavailable = false): Partial<StepResult> {
  const declaration = source.process_scope;
  if (!declaration) return {};
  const target = context.processScope ? processScopeEvidence(context.processScope) : undefined;
  const global: ProcessScopeEvidenceV1 = { mode: 'unscoped', traceId: context.traceId,
    traceSide: target?.traceSide || (context.inherited.__traceSide === 'reference' ? 'reference' : 'current') };
  const contexts = Object.entries(declaration.context_fields || {});
  const contextFields = new Set(contexts.flatMap(([, fields]) => fields || []));
  const row = Array.isArray(data) ? data[0] : data;
  const fields = row && typeof row === 'object' ? Object.keys(row) : [];
  const entries: EvidenceScopeEntryV1[] = [{
    role: declaration.role,
    scope: declaration.role === 'target' && target ? target : global,
    sourceStepId: stepId,
    ...(contexts.length ? { fields: fields.filter(field => !contextFields.has(field)) } : {}),
    availability: unavailable ? 'unavailable' : 'available',
    ...(unavailable ? { reason: declaration.exact_unavailable } : {}),
    ...(declaration.role !== 'target' && target ? { relativeTo: target } : {}),
  }];
  for (const [role, contextColumns] of contexts) entries.push({
    role: role as EvidenceScopeEntryV1['role'], scope: global, sourceStepId: stepId,
    fields: contextColumns, availability: 'available', ...(target ? { relativeTo: target } : {}),
  });
  return {
    ...scopeMetadata({ version: 'process_scope_evidence@1', entries }),
    ...(declaration.limitations?.length ? { scopeLimitations: [...declaration.limitations] } : {}),
  };
}

/** Only propagate existing evidence entries; never derive authority from rows. */
export function resultScopeProvenance(result: any): EvidenceScopeProvenanceV1 | undefined {
  if (!result || typeof result !== 'object') return undefined;
  if (result.scopeProvenance !== undefined) return mergeScopeProvenance([result.scopeProvenance]);
  if (result.rawResults) return mergeScopeProvenance(Object.values(result.rawResults).map(resultScopeProvenance));
  if (Array.isArray(result.displayResults)) return mergeScopeProvenance(result.displayResults.map(resultScopeProvenance));
  return undefined;
}

export function resultScopeLimitations(result: any): string[] {
  if (!result || typeof result !== 'object') return [];
  const nested = result.rawResults ? Object.values(result.rawResults) : [];
  return [...new Set<string>([...(result.scopeLimitations || []),
    ...(result.code === 'exact_scope_unavailable' && result.error ? [result.error] : []),
    ...nested.flatMap(resultScopeLimitations)])];
}
