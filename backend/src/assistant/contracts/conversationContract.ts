// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {loadPromptTemplate, renderTemplate} from '../../agentv3/strategyLoader';
import {parseConclusionContractSidecar} from '../../agent/core/conclusionContract';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';

export type ConversationTraceContext =
  | {kind: 'none'}
  | {kind: 'attached'; traceId: string};

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Source-derived assistant text stays out of later dormant primary prompts. */
  sourceDerived?: boolean;
}

export interface ConversationEvidenceRef {
  id: string;
  label: string;
  source?: string;
}

export interface FullAnalysisHandoff {
  question: string;
  scope: string;
  assumptions: string[];
  evidence: ConversationEvidenceRef[];
}

interface ConversationOutcomeBase {
  message: string;
  evidence?: ConversationEvidenceRef[];
  /** Public finalized result only; runtime context and parser diagnostics stay private. */
  finalResult?: AnalysisResult;
}

export type ConversationRuntimeOutcome =
  | (ConversationOutcomeBase & {kind: 'answered'})
  | (ConversationOutcomeBase & {
      kind: 'needs_user_input';
      question: string;
    })
  | (ConversationOutcomeBase & {
      kind: 'recommend_full';
      handoff: FullAnalysisHandoff;
    })
  | (ConversationOutcomeBase & {kind: 'cancelled'});

export interface ConversationResponseProjection {
  status: 'absent' | 'valid' | 'invalid';
  /** Exact original text outside machine segments; never a rendered question. */
  narrative: string;
  /** Half-open UTF-16 offsets in the original response. */
  machineSegments: Array<{start: number; end: number}>;
  outcome: ConversationRuntimeOutcome;
  issues: Array<{code: 'invalid_framing' | 'duplicate_marker' | 'invalid_json' | 'invalid_control'}>;
}

function topLevelConversationControls(raw: string): Array<{start: number; end: number; payload?: string}> {
  const lines = raw.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  const controls: Array<{start: number; end: number; payload?: string}> = [];
  let fence: {character: string; length: number} | undefined;
  let htmlComment = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    if (fence) {
      const closing = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (htmlComment) {
      if (line.includes('-->')) htmlComment = false;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
      fence = {character: opening[1][0], length: opening[1].length};
      continue;
    }
    const marker = /^ {0,3}<!--\s*smartperfetto:conversation-control(?:\s|$)/.exec(line);
    if (marker) {
      const start = offsets[index] + line.indexOf('<!--');
      const close = raw.indexOf('-->', start + marker[0].trimStart().length);
      const end = close < 0 ? raw.length : close + 3;
      const payloadStart = offsets[index] + marker[0].length;
      while (index + 1 < lines.length && offsets[index + 1] < end) index++;
      const suffix = raw.slice(end, offsets[index] + lines[index].length);
      controls.push({start, end, ...(close >= 0 && !suffix.trim()
        ? {payload: raw.slice(payloadStart, close).trim()} : {})});
      continue;
    }
    if (/^ {0,3}<!--/.test(line) && !line.includes('-->')) htmlComment = true;
  }
  const sidecarSegments = parseConclusionContractSidecar(raw).machineSegments;
  const segments = [
    ...sidecarSegments.map(segment => ({...segment, control: undefined})),
    ...controls.filter(control => !sidecarSegments.some(segment =>
      segment.start < control.end && segment.end > control.start)).map(control => ({...control, control})),
  ].sort((left, right) => right.start - left.start);
  const terminalControls: typeof controls = [];
  let cursor = raw.length;
  for (const segment of segments) {
    if (segment.end > cursor || raw.slice(segment.end, cursor).trim()) break;
    cursor = segment.start;
    if (segment.control) terminalControls.push(segment.control);
  }
  return terminalControls.reverse();
}

function normalizeEvidence(value: unknown): ConversationEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ConversationEvidenceRef[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!id || !label) return [];
    const source = typeof record.source === 'string' ? record.source.trim() : '';
    return [{id, label, ...(source ? {source} : {})}];
  });
}

function selectAuthoritativeEvidence(
  requestedValue: unknown,
  authoritativeEvidence: ConversationEvidenceRef[],
): ConversationEvidenceRef[] {
  const requestedEvidence = normalizeEvidence(requestedValue);
  if (requestedEvidence.length === 0) return authoritativeEvidence;

  const authoritativeById = new Map(
    authoritativeEvidence.map((item) => [item.id, item]),
  );
  const selectedIds = new Set<string>();
  const selectedEvidence = requestedEvidence.flatMap((item) => {
    const authoritative = authoritativeById.get(item.id);
    if (!authoritative || selectedIds.has(item.id)) return [];
    selectedIds.add(item.id);
    return [authoritative];
  });
  return selectedEvidence.length > 0 ? selectedEvidence : authoritativeEvidence;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

export function parseConversationResponse(
  raw: string,
  fallbackQuestion: string,
  evidence: ConversationEvidenceRef[] = [],
): ConversationRuntimeOutcome {
  return parseConversationResponseWithProjection(raw, fallbackQuestion, evidence).outcome;
}

/** Recognize actual top-level controls while preserving an independent exact body. */
export function parseConversationResponseWithProjection(
  raw: string,
  fallbackQuestion: string,
  evidence: ConversationEvidenceRef[] = [],
): ConversationResponseProjection {
  const controls = topLevelConversationControls(raw);
  const machineSegments = controls.map(({start, end}) => ({start, end}));
  let narrative = raw;
  for (const {start, end} of [...machineSegments].reverse()) {
    narrative = narrative.slice(0, start) + narrative.slice(end);
  }
  const message = narrative.trim();
  const base = {narrative, machineSegments, outcome: {kind: 'answered' as const, message, evidence}};
  if (controls.length === 0) return {...base, status: 'absent', issues: []};
  if (controls.length !== 1) return {...base, status: 'invalid', issues: [{code: 'duplicate_marker'}]};
  if (controls[0].payload === undefined) return {...base, status: 'invalid', issues: [{code: 'invalid_framing'}]};
  let control: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(controls[0].payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {...base, status: 'invalid', issues: [{code: 'invalid_control'}]};
    }
    control = parsed as Record<string, unknown>;
  } catch {
    return {...base, status: 'invalid', issues: [{code: 'invalid_json'}]};
  }

  if (control.kind === 'needs_user_input') {
    const question = typeof control.question === 'string'
      ? control.question.trim()
      : '';
    if (question) {
      return {...base, status: 'valid', issues: [], outcome: {
        kind: 'needs_user_input',
        message: message || question,
        question,
        evidence,
      }};
    }
  }

  if (control.kind === 'recommend_full' && control.handoff && typeof control.handoff === 'object') {
    const handoff = control.handoff as Record<string, unknown>;
    const question = typeof handoff.question === 'string' && handoff.question.trim()
      ? handoff.question.trim()
      : fallbackQuestion;
    const scope = typeof handoff.scope === 'string' ? handoff.scope.trim() : '';
    if (scope) {
      return {...base, status: 'valid', issues: [], outcome: {
        kind: 'recommend_full',
        message,
        evidence,
        handoff: {
          question,
          scope,
          assumptions: normalizeStringArray(handoff.assumptions),
          evidence: selectAuthoritativeEvidence(handoff.evidence, evidence),
        },
      }};
    }
  }

  return {...base, status: control.kind === 'answered' ? 'valid' : 'invalid',
    issues: control.kind === 'answered' ? [] : [{code: 'invalid_control'}]};
}

function formatHistory(history: ConversationMessage[]): string {
  if (history.length === 0) return '（这是本次对话的第一轮。）';
  return history.slice(-12).map((message) => (
    `${message.role === 'user' ? '用户' : '助手'}：${message.content}`
  )).join('\n\n');
}

export function buildConversationPrompt(input: {
  question: string;
  history: ConversationMessage[];
  traceContext: ConversationTraceContext;
}): string {
  const template = loadPromptTemplate('prompt-conversation');
  if (!template) throw new Error('Conversation prompt template is not configured');
  return renderTemplate(template, {
    question: input.question,
    historySection: formatHistory(input.history),
    traceContextNotice: input.traceContext.kind === 'attached'
      ? `当前已附加 Trace（ID: ${input.traceContext.traceId}）。只有来自该 Trace 或本轮工具结果的内容才能表述为 Trace 事实。`
      : '当前没有附加 Trace。可以讨论需求、Android 性能原理、分析方法和已授权源码，但必须明确说明没有 Trace 证据，且不要调用 Trace 工具。',
  });
}
