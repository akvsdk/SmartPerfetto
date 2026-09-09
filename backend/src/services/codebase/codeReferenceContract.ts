// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisPlanV3, ToolCallRecord} from '../../agentv3/types';
import {loadPromptTemplate} from '../../agentv3/strategyLoader';
import type {OutputLanguage} from '../../agentv3/outputLanguage';
import {MAX_SOURCE_REFERENCE_PATH_LENGTH, normalizeSourceReferencePath} from './sourceUseDecision';
import {
  getSourceLookupCodeReferences,
  isSourceLookupToolName,
} from './sourceLookupTools';

const CODE_PATH = `[\\p{L}\\p{N}\\p{M}_.@+() ,/\\-]{1,${MAX_SOURCE_REFERENCE_PATH_LENGTH}}\\.[a-z0-9]{1,16}`;
const PATH_WITH_LINE_RANGE = new RegExp(
  `(?<![\\p{L}\\p{N}_./\\\\])(${CODE_PATH})(?::L?\\d+(?:-L?\\d+)?|\\s+L\\d+(?:-L?\\d+)?)\\b`,
  'iu',
);
const FILE_PATH_FIELD = new RegExp(
  `\\bfilePath\\b[\\s"'\u0060|:=]{1,16}(${CODE_PATH})\\b`,
  'iu',
);
const LINE_RANGE_FIELD = /\blineRange\b[\s"'`|:=]{1,16}(?:L)?\d+(?:-\d+)?\b/i;
const LINE_RANGE_OBJECT = /\blineRange\b[\s"'`|:=]{0,16}\{[^}]{0,80}\bstart\b[\s"'`|:=]{1,12}\d+[^}]{0,80}\bend\b[\s"'`|:=]{1,12}\d+/i;
const CHUNK_ID_FIELD = /\b(?:chunkId|referenceId|sourceRef)\b[\s"'`|:=]{1,16}[\w.-]+\b/i;
const LINE_RANGE_UNAVAILABLE = /(?:line(?:\s+range|\s+number)?\s+(?:is\s+)?unavailable|行号不可用)/i;

function isSuccessfulSourceLookup(call: ToolCallRecord): boolean {
  return call.success === true &&
    call.returnedCodeReferences === true &&
    isSourceLookupToolName(call.toolName);
}

export function planHasSuccessfulSourceLookup(
  plan: AnalysisPlanV3 | null | undefined,
): boolean {
  return plan?.toolCallLog?.some(isSuccessfulSourceLookup) === true;
}

export function hasConcreteCodeReference(text: string): boolean {
  if (normalizeSourceReferencePath(PATH_WITH_LINE_RANGE.exec(text)?.[1])) return true;
  if (!normalizeSourceReferencePath(FILE_PATH_FIELD.exec(text)?.[1])) return false;
  return LINE_RANGE_FIELD.test(text) || LINE_RANGE_OBJECT.test(text)
    || (CHUNK_ID_FIELD.test(text) && LINE_RANGE_UNAVAILABLE.test(text));
}

export function finalReportMissingRequiredCodeReference(input: {
  plan: AnalysisPlanV3 | null | undefined;
  conclusion: string;
}): boolean {
  return planHasSuccessfulSourceLookup(input.plan) &&
    !hasConcreteCodeReference(input.conclusion);
}

export function completeFinalReportCodeReferences(input: {
  plan: AnalysisPlanV3 | null | undefined;
  conclusion: string;
  outputLanguage: OutputLanguage;
}): string {
  if (!finalReportMissingRequiredCodeReference(input) || !input.plan) return input.conclusion;
  const references = getSourceLookupCodeReferences(input.plan);
  if (references.length === 0) return input.conclusion;

  const heading = input.outputLanguage === 'en'
    ? '### Source references (candidate mechanisms)'
    : '### 源码定位（候选机制）';
  const note = input.outputLanguage === 'en'
    ? 'These references come from source lookup authorized for this analysis and only locate candidate mechanisms; whether they occurred in this run remains grounded in Trace evidence.'
    : '以下引用来自本次已授权源码查询，仅用于定位候选机制；本次是否发生仍以 Trace 证据为准。';
  const items = references.map(reference => reference.lineRange
    ? `- ${reference.codebaseId ? `codebaseId: ${reference.codebaseId}; ` : ''}${reference.filePath}:L${reference.lineRange.start}-L${reference.lineRange.end}`
    : input.outputLanguage === 'en'
      ? `- ${reference.codebaseId ? `codebaseId: ${reference.codebaseId}; ` : ''}filePath: ${reference.filePath}; sourceRef: ${reference.chunkId ?? reference.referenceId}; line number unavailable`
      : `- ${reference.codebaseId ? `codebaseId: ${reference.codebaseId}; ` : ''}filePath: ${reference.filePath}; sourceRef: ${reference.chunkId ?? reference.referenceId}; 行号不可用`);
  return `${input.conclusion.trimEnd()}\n\n${heading}\n\n${note}\n\n${items.join('\n')}`;
}

export function loadCodeReferenceContractPrompt(outputLanguage: OutputLanguage): string {
  const templateName = outputLanguage === 'en'
    ? 'prompt-code-reference-contract-en'
    : 'prompt-code-reference-contract-zh';
  const template = loadPromptTemplate(templateName);
  if (!template) throw new Error(`Missing code-reference contract prompt template: ${templateName}`);
  return template;
}
