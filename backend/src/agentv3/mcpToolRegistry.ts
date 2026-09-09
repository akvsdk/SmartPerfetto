// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * McpToolRegistry — single source of truth for MCP tools registered
 * by SmartPerfetto.
 *
 * Plan 41 M0 (this file): extract the registry that
 * `claudeMcpServer.ts` already maintained as an inline
 * `toolEntries: Array<{tool, name}>` array. The registry adds:
 *   - explicit `McpToolExposure` per entry (public / internal /
 *     deprecated) so future hosts (stdio, A2A) can filter without
 *     re-deciding policy
 *   - shared `MCP_NAME_PREFIX` handling so `allowedTools` always
 *     matches the SDK's expectation
 *   - one place to derive an `McpToolAci[]` snapshot (used by M1
 *     to populate `McpPublicApiContract`)
 *
 * Critical invariant: registration preserves each tool's canonical
 * name, exposure, schema, and handler result. Runtime wrappers may
 * coordinate admitted tool concurrency and record timing receipts;
 * those policies come from the canonical `SharedToolSpec` rather
 * than being re-decided by individual runtime adapters.
 *
 * Out of scope for M0:
 *   - stdio adapter (lands in M1 as `standaloneMcpServer.ts`)
 *   - A2A AgentCard (M2)
 *   - SupersedeStoreReadOnlyAdapter (M1a, prerequisite for raising
 *     `recall_patterns` exposure from internal back to public)
 *
 * @module mcpToolRegistry
 */

import {createSdkMcpServer} from '@anthropic-ai/claude-agent-sdk';
import {z} from 'zod';

import {
  compactSharedToolSpec,
  createClaudeSdkToolFromSharedSpec,
  sharedToolSpecFromClaudeSdkTool,
  withRuntimeToolConcurrency,
  withRuntimeToolGuard,
  type SharedToolSpec,
} from '../agentRuntime/runtimeToolSpec';
import {
  createRuntimeToolConcurrencyCoordinator,
  type RuntimeToolConcurrencyCoordinator,
} from '../agentRuntime/runtimeToolConcurrency';
import {
  type McpToolAci,
  type McpToolExposure,
  makeSparkProvenance,
  type McpPublicApiContract,
} from '../types/sparkContracts';
import {getPlanToolCapability, type PlanToolCapability} from './types';
import type {RunManifestAttributionSink} from '../types/selfEvolution';
import {withRuntimeToolObserver, type RuntimeToolObserver} from '../agentRuntime/runtimeToolObserver';
import {createRuntimeToolResult} from '../agentRuntime/runtimeToolResult';

/** MCP tool name prefix — derived from the server name `'smartperfetto'`.
 * `claudeMcpServer.ts` exports the same constant; both files agree
 * because both import from this module. The SDK consumes prefixed
 * names in its `allowedTools` array; the MCP protocol itself uses
 * short names. */
export const MCP_NAME_PREFIX = 'mcp__smartperfetto__';

/** One tool stored in the registry. `shared` is the SDK-neutral
 * SmartPerfetto tool body; `tool` is the Claude SDK-native view
 * generated from it. */
export interface McpToolDefinition {
  /** Short MCP tool name (no prefix). */
  name: string;
  /** Shared SmartPerfetto tool body and schema. */
  shared: SharedToolSpec;
  /** Claude SDK tool descriptor — passed to `createSdkMcpServer`. */
  tool: unknown;
  /** Exposure level — drives stdio / A2A filtering downstream. */
  exposure: McpToolExposure;
  /** Human-readable summary surfaced via `getAci()`. Optional during
   * M0 because most existing tools already carry their own description
   * inside the SDK tool object; M1 populates this as it migrates the
   * description text to a stable place. */
  summary?: string;
  /** Required env vars or capability flags. */
  requires?: string[];
  /** Provider-neutral planning role derived from the canonical tool name. */
  planCapability?: PlanToolCapability;
  evidenceEffect?: SharedToolSpec['evidenceEffect'];
}

export type McpToolRegistration = Omit<McpToolDefinition, 'shared' | 'planCapability'> & {
  shared?: SharedToolSpec;
};

export function resolveMcpToolPlanCapability(
  definition: Pick<McpToolDefinition, 'name' | 'planCapability'>,
): PlanToolCapability {
  return definition.planCapability ?? getPlanToolCapability(definition.name);
}

export interface ToolRequestScope {
  readonly sessionId: string;
  readonly hasCodebaseAccess: boolean;
  readonly capabilities?: readonly string[];
  readonly allowNewEvidence?: boolean;
}

function isToolAllowedForScope(
  tool: Pick<McpToolDefinition, 'exposure' | 'evidenceEffect'>,
  scope: ToolRequestScope | undefined,
): boolean {
  if (!scope) return true;
  if (tool.exposure === 'deprecated') return false;
  if (tool.exposure === 'requires_codebase_permission' && !scope.hasCodebaseAccess) return false;
  return scope.allowNewEvidence !== false ||
    tool.evidenceEffect === 'none' || tool.evidenceEffect === 'read_existing';
}

/**
 * Filter the registry contents by one or more exposure levels.
 *
 * Useful for stdio adapter (`['public']`) or admin-only paths
 * (`['internal']`). The default `claudeMcpServer.ts` consumer takes
 * everything, including internal session-protocol tools, because the
 * Claude SDK is the agent itself and is the legitimate caller of
 * those tools.
 */
export function filterByExposure(
  defs: readonly McpToolDefinition[],
  exposures: readonly McpToolExposure[],
): McpToolDefinition[] {
  const wanted = new Set(exposures);
  return defs.filter(d => wanted.has(d.exposure));
}

/** Derive the SDK `allowedTools` array — short names with the
 * SmartPerfetto prefix. Order is preserved so callers that care
 * about deterministic ordering get it. */
export function buildAllowedTools(
  defs: readonly McpToolDefinition[],
): string[] {
  return defs.map(d => `${MCP_NAME_PREFIX}${d.name}`);
}

/**
 * The McpToolRegistry collects tool definitions and emits the views
 * the existing `claudeMcpServer.ts` consumer needs (SDK server +
 * allowedTools list) plus the views M1 will need (stdio dispatcher,
 * ACI snapshot for `McpPublicApiContract`).
 *
 * Stateful registration order matters — the SDK uses array order to
 * match `allowedTools[i]` to `tools[i]`. `register()` appends; later
 * calls cannot reorder the registry.
 */
export class McpToolRegistry {
  private readonly entries: McpToolDefinition[] = [];
  private readonly toolConcurrencyCoordinator: RuntimeToolConcurrencyCoordinator;
  private readonly runManifestAttributionSink?: RunManifestAttributionSink;
  private readonly toolObserver?: RuntimeToolObserver;
  private readonly acquisitionObserver?: RuntimeToolObserver;
  private readonly requestScope?: ToolRequestScope;
  private readonly canInvokeTool?: () => boolean;

  constructor(options: {
    toolConcurrencyCoordinator?: RuntimeToolConcurrencyCoordinator;
    runManifestAttributionSink?: RunManifestAttributionSink;
    toolObserver?: RuntimeToolObserver;
    acquisitionObserver?: RuntimeToolObserver;
    requestScope?: ToolRequestScope;
    canInvokeTool?: () => boolean;
  } = {}) {
    this.toolConcurrencyCoordinator = options.toolConcurrencyCoordinator
      ?? createRuntimeToolConcurrencyCoordinator();
    this.runManifestAttributionSink = options.runManifestAttributionSink;
    this.toolObserver = options.toolObserver;
    this.acquisitionObserver = options.acquisitionObserver;
    this.canInvokeTool = options.canInvokeTool;
    this.requestScope = options.requestScope && Object.freeze({
      ...options.requestScope,
      ...(options.requestScope.capabilities
        ? {capabilities: Object.freeze([...options.requestScope.capabilities])}
        : {}),
    });
  }

  /** Add a tool to the registry. Does NOT prevent duplicates by
   * name; callers control ordering and uniqueness explicitly so the
   * existing conditional registration patterns
   * (`if (writeAnalysisNote) registry.register(...)`) keep working. */
  register(def: McpToolRegistration): void {
    const base = def.shared ?? sharedToolSpecFromClaudeSdkTool(
      def.name,
      def.tool,
      def.exposure,
      {summary: def.summary, requires: def.requires, evidenceEffect: def.evidenceEffect},
    );
    const planCapability = getPlanToolCapability(base.name);
    const shared = planCapability === 'evidence' && !base.inputSchema.planPhaseId
      ? {...base, inputSchema: {...base.inputSchema,
          planPhaseId: z.string().optional().describe('Optional explicit plan phase ID for this invocation.'),
        }}
      : base;
    const access = Object.freeze({exposure: shared.exposure, evidenceEffect: shared.evidenceEffect});
    const scopeGuarded = withRuntimeToolGuard(
      compactSharedToolSpec(shared),
      () => isToolAllowedForScope(access, this.requestScope),
      async () => createRuntimeToolResult({
        success: false,
        action_required: 'use_authorized_existing_evidence',
        unsupportedReason: 'tool_not_allowed_for_request',
      }, {isError: true}),
    );
    const guarded = withRuntimeToolGuard(scopeGuarded, () => {
      try { return this.canInvokeTool?.() !== false; } catch { return false; }
    }, async () => createRuntimeToolResult({success: false,
      action_required: 'deliver_existing_conclusion', unsupportedReason: 'acquisition_closed'}, {isError: true}));
    const acquisitionObserver = shared.evidenceEffect === 'acquire' ? this.acquisitionObserver : undefined;
    const observer: RuntimeToolObserver | undefined = acquisitionObserver ? async event => {
      try { await acquisitionObserver(event); } catch { /* Retained captures remain independently checked. */ }
      if (this.toolObserver) await this.toolObserver(event);
    } : this.toolObserver;
    const runtimeShared = withRuntimeToolConcurrency(
      withRuntimeToolObserver(guarded, observer),
      this.toolConcurrencyCoordinator,
      {runManifestAttributionSink: this.runManifestAttributionSink},
    );
    this.entries.push(Object.freeze({
      name: runtimeShared.name,
      shared: runtimeShared,
      tool: createClaudeSdkToolFromSharedSpec(runtimeShared),
      exposure: runtimeShared.exposure,
      summary: runtimeShared.summary,
      requires: runtimeShared.requires,
      planCapability,
      evidenceEffect: runtimeShared.evidenceEffect,
    }));
  }

  /** Convenience for the existing call sites that pass `(tool,
   * name)` — keeps the migration patch in `claudeMcpServer.ts`
   * minimal. */
  registerSdk(
    tool: unknown,
    name: string,
    exposure: McpToolExposure,
    extras?: Pick<McpToolDefinition, 'summary' | 'requires' | 'evidenceEffect'> & Pick<SharedToolSpec, 'concurrency'>,
  ): void {
    this.register({
      tool,
      name,
      exposure,
      shared: sharedToolSpecFromClaudeSdkTool(name, tool, exposure, extras),
      ...extras,
    });
  }

  /** Register an SDK-neutral SmartPerfetto tool body and build the
   * Claude SDK-native descriptor view from it. */
  registerShared(spec: SharedToolSpec): void {
    this.register({
      name: spec.name,
      exposure: spec.exposure,
      tool: createClaudeSdkToolFromSharedSpec(spec),
      shared: spec,
      summary: spec.summary,
      requires: spec.requires,
      evidenceEffect: spec.evidenceEffect,
    });
  }

  /** Request-authorized entries in registration order. */
  list(): readonly McpToolDefinition[] {
    return this.listForRequest();
  }

  listForRequest(scope?: ToolRequestScope): McpToolDefinition[] {
    return this.entries.filter(entry =>
      isToolAllowedForScope(entry, this.requestScope) && isToolAllowedForScope(entry, scope),
    );
  }

  /** Build the SDK's in-process MCP server. The SDK names the server
   * `smartperfetto` to align with `MCP_NAME_PREFIX`; that linkage is
   * preserved here. */
  buildSdkServer(opts: {name?: string; version?: string; scope?: ToolRequestScope} = {}) {
    const entries = this.listForRequest(opts.scope);
    return createSdkMcpServer({
      name: opts.name ?? 'smartperfetto',
      version: opts.version ?? '1.0.0',
      // The SDK accepts `unknown[]` here because tool() returns its own
      // opaque shape. Cast at the boundary; consumers do not get to
      // peek inside a tool descriptor.
      tools: entries.map(e => e.tool) as never,
    });
  }

  /** Allowed-tools array prefixed for the SDK call site. Matches the
   * exact format `claudeMcpServer.ts` returned before the refactor. */
  buildAllowedTools(scope?: ToolRequestScope): string[] {
    return buildAllowedTools(this.listForRequest(scope));
  }

  /** Snapshot of the registry as `McpToolAci[]` — drives the future
   * `McpPublicApiContract.tools` field once M1 populates summary /
   * inputSchema / examples per tool. M0 emits a minimal ACI with
   * just name + qualified name + exposure; the description / schema
   * fields stay optional so older snapshots remain readable. */
  getAci(scope?: ToolRequestScope): McpToolAci[] {
    const entries = this.listForRequest(scope);
    return entries.map(e => ({
      toolName: e.name,
      qualifiedName: `${MCP_NAME_PREFIX}${e.name}`,
      exposure: e.exposure,
      summary: e.summary ?? '',
      ...(e.requires ? {requires: e.requires} : {}),
    }));
  }

  /** Build a minimal `McpPublicApiContract` for export / inspection.
   * `agentCards` is empty for now (Plan 41 M2 populates it once A2A
   * is opt-in enabled). */
  buildPublicApiContract(opts: {
    serverVersion?: string;
    protocolVersion?: string;
    scope?: ToolRequestScope;
  } = {}): McpPublicApiContract {
    return {
      ...makeSparkProvenance({source: 'mcpToolRegistry'}),
      tools: this.getAci(opts.scope),
      serverVersion: opts.serverVersion ?? '1.0.0',
      protocolVersion: opts.protocolVersion ?? '2024-11-05',
      coverage: [
        {sparkId: 91, planId: '41', status: 'scaffolded'},
        {sparkId: 92, planId: '41', status: 'scaffolded'},
        {sparkId: 96, planId: '41', status: 'scaffolded'},
        {sparkId: 133, planId: '41', status: 'scaffolded'},
        {sparkId: 139, planId: '41', status: 'scaffolded'},
        {sparkId: 173, planId: '41', status: 'scaffolded'},
      ],
    };
  }

  /** Number of request-authorized tools. */
  size(): number {
    return this.listForRequest().length;
  }

  probeCapabilities(scope: ToolRequestScope): {
    codeAwareAvailable: boolean;
    reason?: 'feature_disabled' | 'no_codebase_configured' | 'no_permission' | 'consent_required_but_missing';
  } {
    if (process.env.SMARTPERFETTO_CODE_AWARE === 'off') {
      return {codeAwareAvailable: false, reason: 'feature_disabled'};
    }
    if (!scope.hasCodebaseAccess || this.requestScope?.hasCodebaseAccess === false) {
      return {codeAwareAvailable: false, reason: 'no_permission'};
    }
    return {codeAwareAvailable: true};
  }
}
