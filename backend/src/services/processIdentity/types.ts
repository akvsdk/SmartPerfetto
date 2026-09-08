// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ProcessIdentityStatus = 'verified' | 'ambiguous' | 'unresolved' | 'not_found';

export type SkillIdentityPolicy = 'none' | 'exempt' | 'verify_if_present' | 'required';

export type SkillIdentityRewriteTarget = 'recommended_process_name_param' | 'upid';

export interface SkillIdentityConfig {
  policy: SkillIdentityPolicy;
  scope?: 'process';
  aliases?: string[];
  rewriteTo?: SkillIdentityRewriteTarget;
  minConfidence?: number;
}

export interface ProcessIdentityTarget {
  requestedName?: string;
  threadName?: string;
  upid?: number;
  pid?: number;
  startTs?: string | number;
  endTs?: string | number;
}

export interface ProcessIdentityCandidate {
  rank: number;
  confidenceScore: number;
  rawStatus?: string;
  canonicalPackageName?: string;
  recommendedProcessNameParam?: string;
  upid?: number;
  pid?: number;
  processName?: string;
  metadataProcessName?: string;
  packageName?: string;
  cmdline?: string;
  targetMatchSources?: string;
  supportingSources?: string;
  identityWarning?: string;
  threadUtid?: number;
  threadTid?: number;
  threadName?: string;
  threadRole?: 'app_main' | 'render_thread' | 'unknown';
  threadTargetMatched?: boolean;
}

export interface ProcessIdentityResolution {
  status: ProcessIdentityStatus;
  requestedName?: string;
  canonicalPackageName?: string;
  recommendedProcessNameParam?: string;
  /** Verified selected process IDs; alternatives belong only in candidates. */
  upids: number[];
  confidenceScore: number;
  rawStatus?: string;
  evidenceSources: string[];
  warnings: string[];
  candidates: ProcessIdentityCandidate[];
  resolverError?: string;
}

export const DEFAULT_PROCESS_IDENTITY_ALIASES = [
  'package',
  'process_name',
  'package_name',
  'target_package',
  'app_package',
  'packageName',
  'processName',
];

export const PROCESS_IDENTITY_SELECTORS = [
  ...DEFAULT_PROCESS_IDENTITY_ALIASES, 'upid', 'pid', 'thread_name', 'threadName',
];

export function hasProcessIdentitySelector(params: Record<string, unknown> | undefined): boolean {
  return PROCESS_IDENTITY_SELECTORS.some(key => params?.[key] !== undefined && params[key] !== null &&
    String(params[key]).trim() !== '');
}
