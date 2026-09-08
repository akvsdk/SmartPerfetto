// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type {
  AnalysisIdentityTargetV1,
  IdentityResolutionStatus,
  IdentityResolutionV1,
  IdentityTraceSide,
  ResolvedProcessIdentityV1,
  ResolvedThreadIdentityV1,
} from '../../types/identityContract';
import type {
  ProcessIdentityCandidate,
  ProcessIdentityResolution,
  ProcessIdentityTarget,
} from './types';

export interface BuildIdentityResolutionFromProcessGateInput {
  traceId: string;
  traceSide?: IdentityTraceSide;
  target?: ProcessIdentityTarget;
  resolution?: ProcessIdentityResolution;
  source?: AnalysisIdentityTargetV1['source'];
  statusOverride?: IdentityResolutionStatus;
  warnings?: string[];
}

function stableHash(value: unknown): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item))
    .digest('hex')
    .slice(0, 12);
}

export function mapProcessIdentityStatus(
  resolution: ProcessIdentityResolution | undefined,
): IdentityResolutionStatus {
  if (!resolution) return 'not_required';
  if (resolution.resolverError) return 'error';
  if (resolution.status === 'verified') return 'verified';
  if (resolution.status === 'not_found') return 'missing';
  if (resolution.status === 'unresolved') return 'missing';

  const raw = String(resolution.rawStatus || '').toLowerCase();
  const warningText = resolution.warnings.join(' ').toLowerCase();
  if (raw.includes('weak') || warningText.includes('weak')) return 'weak';
  if (resolution.confidenceScore > 0 && resolution.confidenceScore < 50) return 'weak';
  return 'ambiguous';
}

function buildTarget(
  traceId: string,
  traceSide: IdentityTraceSide | undefined,
  target: ProcessIdentityTarget | undefined,
  source: AnalysisIdentityTargetV1['source'],
): AnalysisIdentityTargetV1 {
  const timeRange = target?.startTs !== undefined && target?.endTs !== undefined
    ? { startTs: target.startTs, endTs: target.endTs }
    : undefined;
  return {
    traceId,
    traceSide: traceSide || 'current',
    packageName: target?.requestedName,
    processName: target?.requestedName,
    threadName: target?.threadName,
    upid: target?.upid,
    pid: target?.pid,
    ...(timeRange ? { timeRange } : {}),
    source,
  };
}

function processFromCandidate(candidate: ProcessIdentityCandidate): ResolvedProcessIdentityV1 | undefined {
  if (candidate.upid === undefined) return undefined;
  const matchSources = new Set<string>();
  for (const sourceText of [candidate.targetMatchSources, candidate.supportingSources]) {
    if (typeof sourceText !== 'string') continue;
    for (const part of sourceText.split(',')) {
      const source = part.trim();
      if (source) matchSources.add(source);
    }
  }
  return {
    upid: candidate.upid,
    pid: candidate.pid,
    processName: candidate.processName || candidate.metadataProcessName || candidate.recommendedProcessNameParam,
    packageName: candidate.packageName || candidate.canonicalPackageName,
    matchSources: Array.from(matchSources),
    confidence: Math.max(0, Math.min(1, candidate.confidenceScore / 100)),
  };
}

function threadFromCandidate(
  candidate: ProcessIdentityCandidate,
  target: ProcessIdentityTarget | undefined,
): ResolvedThreadIdentityV1 | undefined {
  if (candidate.threadUtid === undefined) return undefined;
  if (target?.threadName && candidate.threadTargetMatched !== true) return undefined;
  return {
    utid: candidate.threadUtid,
    tid: candidate.threadTid,
    threadName: candidate.threadName,
    role: candidate.threadRole,
    owningUpid: candidate.upid,
    processName: candidate.processName || candidate.metadataProcessName || candidate.recommendedProcessNameParam,
    matchSources: candidate.threadName ? ['thread.name'] : [],
    confidence: Math.max(0, Math.min(1, candidate.confidenceScore / 100)),
  };
}

export function buildIdentityResolutionFromProcessGate(
  input: BuildIdentityResolutionFromProcessGateInput,
): IdentityResolutionV1 | undefined {
  if (!input.target && !input.resolution) return undefined;

  const target = buildTarget(
    input.traceId,
    input.traceSide,
    input.target,
    input.source || 'skill_param',
  );
  const resolution = input.resolution;
  const status = input.statusOverride || mapProcessIdentityStatus(resolution);
  const selectedCandidates = (resolution?.candidates || []).filter(candidate =>
    status !== 'verified' || (candidate.upid !== undefined && resolution?.upids.includes(candidate.upid)));
  const processes = selectedCandidates
    .map(processFromCandidate)
    .filter((item): item is ResolvedProcessIdentityV1 => Boolean(item));
  const threads = selectedCandidates
    .map(candidate => threadFromCandidate(candidate, input.target))
    .filter((item): item is ResolvedThreadIdentityV1 => Boolean(item));
  const warnings = [
    ...(input.warnings || []),
    ...(resolution?.warnings || []),
    ...(resolution?.resolverError ? [`resolver failed: ${resolution.resolverError}`] : []),
  ];
  const recommendedParams: Record<string, string | number | boolean> = {};
  if (resolution?.recommendedProcessNameParam) {
    recommendedParams.process_name = resolution.recommendedProcessNameParam;
    recommendedParams.package = resolution.recommendedProcessNameParam;
  }
  if (status === 'verified' && resolution?.upids?.length === 1) {
    recommendedParams.upid = resolution.upids[0];
  }

  return {
    version: 'identity_contract@1',
    identityRefId: `identity:${stableHash({
      traceId: input.traceId,
      traceSide: input.traceSide || 'current',
      target,
      status,
      upids: resolution?.upids || [],
      confidence: resolution?.confidenceScore,
    })}`,
    target,
    status,
    processes,
    threads,
    warnings,
    ...(Object.keys(recommendedParams).length > 0 ? { recommendedParams } : {}),
  };
}
