// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {CaseKnowledgeReportRecommendation} from '../../types/caseKnowledge';
import type {EvidenceRelationCandidateV1} from '../../types/evidenceContract';
import type {
  SourceClaimBindingV1,
  SourceReferenceV1,
  SourceUseDecisionV1,
} from '../../services/codebase/sourceUseDecision';

export type ConclusionOutputMode = 'initial_report' | 'focused_answer' | 'need_input';
export type ConclusionClusterOutputMode = 'required' | 'optional' | 'none';
export type ConclusionClusterFrameListMode = 'none' | 'top' | 'full';
export type ConclusionClaimKind =
  | 'numeric'
  | 'categorical'
  | 'time_range'
  | 'identity'
  | 'causal'
  | 'comparison'
  | 'inference'
  | 'recommendation';
export type ConclusionClaimSupportLevel = 'verified' | 'partial' | 'inference' | 'unsupported';

export interface ConclusionContractConclusionItem {
  rank: number;
  statement: string;
  confidencePercent?: number;
  trigger?: string;
  supply?: string;
  amplification?: string;
}

export interface ConclusionContractClusterItem {
  cluster: string;
  description?: string;
  frames?: number;
  percentage?: number;
  frameRefs?: string[];
  omittedFrameRefs?: number;
}

export interface ConclusionContractClusterPolicy {
  outputMode: ConclusionClusterOutputMode;
  frameListMode: ConclusionClusterFrameListMode;
  maxFramesPerCluster?: number;
}

export interface ConclusionContractEvidenceItem {
  conclusionId: string;
  text: string;
}

export interface ConclusionContractClaimReference {
  evidenceRefId?: string;
  rowIndex?: number;
  rowSelector?: Record<string, string | number | boolean>;
  column?: string;
  value?: string | number | boolean;
  sourceRef?: string;
  sourceToolCallId?: string;
  /** Canonical durable artifact id for artifact-backed claims. */
  artifactId?: string;
  /** Compatibility alias from existing artifact rows; normalize to artifactId. */
  sourceArtifactId?: string;
}

export interface ConclusionContractClaimItem {
  id?: string;
  conclusionId?: string;
  text: string;
  kind?: ConclusionClaimKind;
  references: ConclusionContractClaimReference[];
  artifactRefs?: Array<{ artifactId: string; rowIndex?: number; rowSelector?: Record<string, unknown> }>;
  relationRefs?: string[];
  /** Model-produced hint only; visible verdicts come from verifier output. */
  supportLevel?: ConclusionClaimSupportLevel;
  semantics?: ClaimSemanticsV1;
  /** Original invalid model declaration; never a verified interpretation. */
  rawSemantics?: unknown;
  /** Malformed references remain available for diagnosis and lossless reparse. */
  rawReferences?: unknown;
  /** Parser-owned diagnostics, not accepted from model JSON. */
  semanticsParseIssues?: ConclusionContractParseIssue[];
}

export interface ClaimSemanticsV1 {
  schemaVersion: 'claim_semantics@1';
  /** Unknown rule IDs are valid declarations but supply no proof. */
  predicate: string;
  polarity: 'affirmed' | 'negated' | 'undetermined';
  discourse: 'asserted' | 'hypothetical' | 'quoted' | 'rejected_quote';
  quantifier: 'one' | 'some' | 'all' | 'only';
  modality: 'certain' | 'possible' | 'undetermined';
  conditions?: string[];
  scope: {
    subjectRefs?: ConclusionContractClaimReference[];
    objectRefs?: ConclusionContractClaimReference[];
    population: 'cited_rows' | 'selected_interval' | 'process_instance' | 'trace' | 'codebase';
    timeRangeNs?: {start: string; end: string};
  };
  /** The proposition value is distinct from a cited cell's value. */
  numeric?: {operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: number | string; unit: string};
}

export interface ConclusionContractParseIssue {
  code: 'invalid_framing' | 'duplicate_marker' | 'invalid_json' | 'invalid_contract' |
    'invalid_claim' | 'invalid_reference' | 'invalid_semantics' | 'duplicate_claim_id' |
    'invalid_relation_proposal' | 'duplicate_proposal_id' | 'untrusted_parser_metadata';
  path: string;
}

export type ConclusionBindingEligibility = 'eligible' | 'ineligible' | 'legacy_unchecked';

export interface ConclusionContractDeclarationParseResult {
  status: 'absent' | 'valid' | 'invalid';
  raw: string;
  rawPayload?: unknown;
  contract?: ConclusionContract;
  issues: ConclusionContractParseIssue[];
  bindingEligibility: ConclusionBindingEligibility;
}

export interface ConclusionContractSidecarParseResult extends ConclusionContractDeclarationParseResult {
  /** Exact narrative outside the accepted marker. */
  narrative: string;
  /** Half-open UTF-16 offsets; retain raw separately before removing these from chat. */
  machineSegments: Array<{start: number; end: number}>;
}

export interface ConclusionContractMetadata {
  confidencePercent?: number;
  rounds?: number;
  clusterPolicy?: ConclusionContractClusterPolicy;
  sceneId?: string;
  /**
   * Claims were derived by matching the final narrative against captured
   * DataEnvelope cells, not emitted explicitly by the model.
   */
  derivedFromNarrativeEvidenceMatch?: boolean;
  claimDerivation?: 'explicit_model_contract' | 'narrative_evidence_match';
  claimVerificationScope?: 'explicit_claims' | 'sampled_narrative_evidence';
  replacedUnresolvableProviderClaims?: boolean;
}

export interface ConclusionContract {
  schemaVersion: 'conclusion_contract_v1';
  mode: ConclusionOutputMode;
  conclusions: ConclusionContractConclusionItem[];
  clusters: ConclusionContractClusterItem[];
  evidenceChain: ConclusionContractEvidenceItem[];
  claims?: ConclusionContractClaimItem[];
  rawClaims?: unknown;
  /** Parser-owned original root when rejected metadata cannot be omitted losslessly. */
  rawDeclaration?: unknown;
  /** Model proposals only; proof is produced independently by the backend. */
  relationProposals?: EvidenceRelationCandidateV1[];
  /** Preserve malformed proposals without treating them as typed candidates. */
  rawRelationProposals?: unknown;
  /** Parser-owned binding state. JSON with these fields cannot supply authority. */
  parseIssues?: ConclusionContractParseIssue[];
  bindingEligibility?: ConclusionBindingEligibility;
  sourceUseDecision?: SourceUseDecisionV1;
  sourceReferences?: SourceReferenceV1[];
  sourceClaimBindings?: SourceClaimBindingV1[];
  /**
   * Curated case-library recommendations selected by a retrieval/citation path.
   * Report rendering consumes this structured projection; retrieval remains
   * responsible for evidence-signature gating.
   */
  caseRecommendations?: CaseKnowledgeReportRecommendation[];
  uncertainties: string[];
  nextSteps: string[];
  metadata?: ConclusionContractMetadata;
}

const SIDECAR_MARKER = '<!-- smartperfetto:conclusion-contract@1';
const SIDECAR_PREFIX = '<!-- smartperfetto:conclusion-contract@';
/** Shared prompt framing; injected only after developer comments are stripped. */
export const CONCLUSION_CONTRACT_SIDECAR_MARKER = SIDECAR_MARKER;
const ROOT_PARSER_FIELDS = [
  'parseIssues', 'bindingEligibility', 'verified', 'rawClaims', 'rawRelationProposals', 'rawDeclaration',
] as const;
const CLAIM_PARSER_FIELDS = [
  'parseIssues', 'bindingEligibility', 'verified', 'rawSemantics', 'semanticsParseIssues', 'rawReferences', 'rawDeclaration',
] as const;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function oneOf(value: unknown, options: readonly string[]): value is string {
  return typeof value === 'string' && options.includes(value);
}

function keysWithin(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function claimReference(value: unknown): value is ConclusionContractClaimReference {
  if (!record(value) || !keysWithin(value, [
    'evidenceRefId', 'rowIndex', 'rowSelector', 'column', 'value', 'sourceRef',
    'sourceToolCallId', 'artifactId', 'sourceArtifactId',
  ])) return false;
  const identifiers = ['evidenceRefId', 'sourceRef', 'sourceToolCallId', 'artifactId', 'sourceArtifactId'];
  if (!identifiers.some(key => typeof value[key] === 'string' && String(value[key]).trim())) return false;
  if ([...identifiers, 'column'].some(key => value[key] !== undefined &&
    (typeof value[key] !== 'string' || !String(value[key]).trim()))) return false;
  if (value.rowIndex !== undefined && (!Number.isSafeInteger(value.rowIndex) || Number(value.rowIndex) < 0)) return false;
  if (value.rowSelector !== undefined && (!record(value.rowSelector) ||
    Object.keys(value.rowSelector).length === 0 ||
    Object.entries(value.rowSelector).some(([key, item]) => !key || !scalar(item)))) return false;
  return value.value === undefined || scalar(value.value);
}

function referenceList(value: unknown): value is ConclusionContractClaimReference[] {
  return Array.isArray(value) && value.every(claimReference);
}

/** Schema validation only; it does not infer meaning from a claim's wording. */
export function parseClaimSemanticsDeclaration(raw: unknown, path = 'semantics'): {
  semantics?: ClaimSemanticsV1;
  rawSemantics?: unknown;
  semanticsParseIssues?: ConclusionContractParseIssue[];
} {
  const invalid = () => ({rawSemantics: raw, semanticsParseIssues: [{code: 'invalid_semantics' as const, path}]});
  if (!record(raw) || !keysWithin(raw, ['schemaVersion', 'predicate', 'polarity', 'discourse',
    'quantifier', 'modality', 'conditions', 'scope', 'numeric']) ||
    raw.schemaVersion !== 'claim_semantics@1' || typeof raw.predicate !== 'string' ||
    (!raw.predicate.trim() || /\s/.test(raw.predicate)) ||
    !oneOf(raw.polarity, ['affirmed', 'negated', 'undetermined']) ||
    !oneOf(raw.discourse, ['asserted', 'hypothetical', 'quoted', 'rejected_quote']) ||
    !oneOf(raw.quantifier, ['one', 'some', 'all', 'only']) ||
    !oneOf(raw.modality, ['certain', 'possible', 'undetermined']) ||
    (raw.conditions !== undefined && !stringList(raw.conditions))) return invalid();
  const scope = raw.scope;
  if (!record(scope) || !keysWithin(scope, ['subjectRefs', 'objectRefs', 'population', 'timeRangeNs']) ||
    !oneOf(scope.population, ['cited_rows', 'selected_interval', 'process_instance', 'trace', 'codebase']) ||
    (scope.subjectRefs !== undefined && !referenceList(scope.subjectRefs)) ||
    (scope.objectRefs !== undefined && !referenceList(scope.objectRefs))) return invalid();
  if (scope.timeRangeNs !== undefined) {
    const range = scope.timeRangeNs;
    if (!record(range) || !keysWithin(range, ['start', 'end']) || typeof range.start !== 'string' ||
      typeof range.end !== 'string' || !/^-?\d+$/.test(range.start) || !/^-?\d+$/.test(range.end) ||
      BigInt(range.start) > BigInt(range.end)) return invalid();
  }
  if (raw.numeric !== undefined) {
    const numeric = raw.numeric;
    if (!record(numeric) || !keysWithin(numeric, ['operator', 'value', 'unit']) ||
      !oneOf(numeric.operator, ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']) ||
      !((typeof numeric.value === 'number' && Number.isFinite(numeric.value)) ||
        (typeof numeric.value === 'string' && /^-?(?:\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(numeric.value))) ||
      typeof numeric.unit !== 'string' || !numeric.unit.trim()) return invalid();
  }
  return {semantics: structuredClone(raw) as unknown as ClaimSemanticsV1};
}

/** Preserve array order and duplicate IDs so binding validation can reject ambiguity. */
export function parseDeclaredConclusionClaims(raw: unknown): {
  claims: ConclusionContractClaimItem[];
  rawClaims?: unknown;
  issues: ConclusionContractParseIssue[];
} {
  if (!Array.isArray(raw)) return {claims: [], rawClaims: raw, issues: [{code: 'invalid_claim', path: 'claims'}]};
  const claims: ConclusionContractClaimItem[] = [];
  const issues: ConclusionContractParseIssue[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    const path = `claims[${index}]`;
    if (!record(item) || typeof item.text !== 'string') {
      issues.push({code: 'invalid_claim', path});
      return;
    }
    if (!item.text.trim() || (item.id !== undefined && (typeof item.id !== 'string' || !item.id.trim())) ||
      (item.conclusionId !== undefined && typeof item.conclusionId !== 'string') ||
      (item.kind !== undefined && !oneOf(item.kind, ['numeric', 'categorical', 'time_range', 'identity', 'causal', 'comparison',
        'inference', 'recommendation']))) issues.push({code: 'invalid_claim', path});
    if (CLAIM_PARSER_FIELDS.some(key => hasOwn(item, key))) issues.push({code: 'untrusted_parser_metadata', path});
    const referencesValid = referenceList(item.references);
    if (!referencesValid) issues.push({code: 'invalid_reference', path: `${path}.references`});
    const semantics = hasOwn(item, 'semantics')
      ? parseClaimSemanticsDeclaration(item.semantics, `${path}.semantics`) : {};
    issues.push(...(semantics.semanticsParseIssues ?? []));
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) issues.push({code: 'duplicate_claim_id', path: `${path}.id`});
      ids.add(item.id);
    }
    const artifactRefs = item.artifactRefs;
    const validArtifactRefs = artifactRefs === undefined || (Array.isArray(artifactRefs) && artifactRefs.every(ref =>
      record(ref) && keysWithin(ref, ['artifactId', 'rowIndex', 'rowSelector']) &&
      typeof ref.artifactId === 'string' && ref.artifactId.trim() &&
      (ref.rowIndex === undefined || (Number.isSafeInteger(ref.rowIndex) && Number(ref.rowIndex) >= 0)) &&
      (ref.rowSelector === undefined || record(ref.rowSelector))));
    if (!validArtifactRefs || (item.relationRefs !== undefined && !stringList(item.relationRefs))) {
      issues.push({code: 'invalid_reference', path});
    }
    claims.push({
      ...(typeof item.id === 'string' ? {id: item.id} : {}),
      ...(typeof item.conclusionId === 'string' ? {conclusionId: item.conclusionId} : {}),
      text: item.text,
      ...(typeof item.kind === 'string' ? {kind: item.kind as ConclusionClaimKind} : {}),
      references: referenceList(item.references) ? structuredClone(item.references) : [],
      ...(!referencesValid ? {rawReferences: structuredClone(item.references)} : {}),
      ...(Array.isArray(artifactRefs) && validArtifactRefs ? {artifactRefs: structuredClone(artifactRefs) as ConclusionContractClaimItem['artifactRefs']} : {}),
      ...(stringList(item.relationRefs) ? {relationRefs: [...item.relationRefs]} : {}),
      ...(oneOf(item.supportLevel, ['verified', 'partial', 'inference', 'unsupported'])
        ? {supportLevel: item.supportLevel as ConclusionClaimSupportLevel} : {}),
      ...semantics,
    });
  });
  return {claims, ...(issues.some(issue => issue.code === 'invalid_claim' || issue.code === 'untrusted_parser_metadata' ||
    (issue.code === 'invalid_reference' && !issue.path.endsWith('.references'))) ? {rawClaims: structuredClone(raw)} : {}), issues};
}

function relationProposal(value: unknown): value is EvidenceRelationCandidateV1 {
  if (!record(value) || !keysWithin(value, ['schemaVersion', 'id', 'kind', 'direction', 'subject', 'object',
    'proof', 'proofBindings', 'metricColumn', 'value', 'unit', 'deltaDirection']) ||
    value.schemaVersion !== 'evidence_relation_candidate@1' || typeof value.id !== 'string' ||
    !/^proposal:[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value.id) ||
    !oneOf(value.kind, ['overlap', 'wakeup', 'blocking_state', 'binder_peer', 'lock_owner', 'comparison_delta', 'derived']) ||
    !oneOf(value.direction, ['subject_to_object', 'object_to_subject', 'symmetric']) ||
    !claimReference(value.subject) || (value.object !== undefined && !claimReference(value.object)) ||
    (value.proof !== undefined && !claimReference(value.proof)) ||
    (value.value !== undefined && !scalar(value.value)) ||
    ['unit', 'metricColumn'].some(key => value[key] !== undefined && (typeof value[key] !== 'string' || !String(value[key]).trim())) ||
    (value.deltaDirection !== undefined && value.deltaDirection !== 'current_minus_reference')) return false;
  if (value.proofBindings !== undefined) {
    if (!record(value.proofBindings) || !keysWithin(value.proofBindings, ['subject', 'object'])) return false;
    for (const endpoint of [value.proofBindings.subject, value.proofBindings.object]) {
      if (!record(endpoint) || !keysWithin(endpoint, ['endpointColumn', 'proofColumn']) ||
        typeof endpoint.endpointColumn !== 'string' || !endpoint.endpointColumn.trim() ||
        typeof endpoint.proofColumn !== 'string' || !endpoint.proofColumn.trim()) return false;
    }
  }
  return true;
}

export function parseDeclaredRelationProposals(raw: unknown): {
  relationProposals: EvidenceRelationCandidateV1[];
  rawRelationProposals?: unknown;
  issues: ConclusionContractParseIssue[];
} {
  if (!Array.isArray(raw)) return {relationProposals: [], rawRelationProposals: raw,
    issues: [{code: 'invalid_relation_proposal', path: 'relationProposals'}]};
  const relationProposals: EvidenceRelationCandidateV1[] = [];
  const issues: ConclusionContractParseIssue[] = [];
  const ids = new Set<string>();
  raw.forEach((item, index) => {
    if (!relationProposal(item)) {
      issues.push({code: 'invalid_relation_proposal', path: `relationProposals[${index}]`});
      return;
    }
    if (ids.has(item.id)) issues.push({code: 'duplicate_proposal_id', path: `relationProposals[${index}].id`});
    ids.add(item.id);
    relationProposals.push(structuredClone(item));
  });
  return {relationProposals, ...(issues.length ? {rawRelationProposals: structuredClone(raw)} : {}), issues};
}

/** New declaration fields distinguish the typed protocol from legacy aliases. */
export function hasConclusionContractDeclarations(value: unknown): boolean {
  if (!record(value)) return false;
  return hasOwn(value, 'relationProposals') || ROOT_PARSER_FIELDS.some(key => hasOwn(value, key)) ||
    (Array.isArray(value.claims) && value.claims.some(claim => record(claim) &&
      (hasOwn(claim, 'semantics') || CLAIM_PARSER_FIELDS.some(key => hasOwn(claim, key)))));
}

/** Classify complete canonical typed JSON before a legacy extractor can rewrite it. */
export function parseTypedConclusionContractJson(raw: string): ConclusionContractDeclarationParseResult {
  const absent: ConclusionContractDeclarationParseResult = {
    status: 'absent', raw, issues: [], bindingEligibility: 'legacy_unchecked',
  };
  const text = raw.trim();
  const fenced = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(text);
  let rawPayload: unknown;
  try { rawPayload = JSON.parse(fenced ? fenced[1] : text); }
  catch { return absent; }
  if (!record(rawPayload) || rawPayload.schemaVersion !== 'conclusion_contract_v1' ||
    !hasConclusionContractDeclarations(rawPayload)) return absent;
  const projected = parseConclusionContractDeclaration(rawPayload);
  const status = projected.issues.length ? 'invalid' : 'valid';
  return {raw, rawPayload, ...projected, status,
    bindingEligibility: status === 'valid' ? 'eligible' : 'ineligible'};
}

/** Sidecar JSON uses canonical v1 field names. Legacy aliases stay in the legacy parser. */
export function parseConclusionContractDeclaration(raw: unknown): {contract?: ConclusionContract; issues: ConclusionContractParseIssue[]} {
  const issues: ConclusionContractParseIssue[] = [];
  if (!record(raw) || raw.schemaVersion !== 'conclusion_contract_v1' ||
    !oneOf(raw.mode, ['initial_report', 'focused_answer', 'need_input']) ||
    !Array.isArray(raw.conclusions) || !Array.isArray(raw.clusters) || !Array.isArray(raw.evidenceChain) ||
    !stringList(raw.uncertainties) || !stringList(raw.nextSteps)) {
    return {issues: [{code: 'invalid_contract', path: '$'}]};
  }
  const rejectedRootMetadata = ROOT_PARSER_FIELDS.some(key => hasOwn(raw, key));
  if (rejectedRootMetadata) {
    issues.push({code: 'untrusted_parser_metadata', path: '$'});
  }
  const conclusionValid = raw.conclusions.every(item => record(item) && typeof item.statement === 'string' &&
    typeof item.rank === 'number' && Number.isFinite(item.rank));
  const clustersValid = raw.clusters.every(item => record(item) && typeof item.cluster === 'string');
  const evidenceValid = raw.evidenceChain.every(item => record(item) && typeof item.conclusionId === 'string' && typeof item.text === 'string');
  if (!conclusionValid || !clustersValid || !evidenceValid) return {issues: [...issues, {code: 'invalid_contract', path: '$'}]};
  const claims = hasOwn(raw, 'claims') ? parseDeclaredConclusionClaims(raw.claims) : undefined;
  const relations = hasOwn(raw, 'relationProposals') ? parseDeclaredRelationProposals(raw.relationProposals) : undefined;
  issues.push(...(claims?.issues ?? []), ...(relations?.issues ?? []));
  const contract: ConclusionContract = {
    schemaVersion: 'conclusion_contract_v1', mode: raw.mode as ConclusionOutputMode,
    conclusions: structuredClone(raw.conclusions) as ConclusionContractConclusionItem[],
    clusters: structuredClone(raw.clusters) as ConclusionContractClusterItem[],
    evidenceChain: structuredClone(raw.evidenceChain) as ConclusionContractEvidenceItem[],
    uncertainties: [...raw.uncertainties], nextSteps: [...raw.nextSteps],
    ...(claims ? {claims: claims.claims, ...(hasOwn(claims, 'rawClaims') ? {rawClaims: claims.rawClaims} : {})} : {}),
    ...(relations ? {relationProposals: relations.relationProposals,
      ...(hasOwn(relations, 'rawRelationProposals') ? {rawRelationProposals: relations.rawRelationProposals} : {})} : {}),
    ...(record(raw.metadata) ? {metadata: structuredClone(raw.metadata) as ConclusionContractMetadata} : {}),
    ...(record(raw.sourceUseDecision) ? {sourceUseDecision: structuredClone(raw.sourceUseDecision) as unknown as SourceUseDecisionV1} : {}),
    ...(Array.isArray(raw.sourceReferences) ? {sourceReferences: structuredClone(raw.sourceReferences) as SourceReferenceV1[]} : {}),
    ...(Array.isArray(raw.sourceClaimBindings) ? {sourceClaimBindings: structuredClone(raw.sourceClaimBindings) as SourceClaimBindingV1[]} : {}),
    ...(rejectedRootMetadata ? {rawDeclaration: structuredClone(raw)} : {}),
    parseIssues: issues,
    bindingEligibility: issues.length ? 'ineligible' : 'eligible',
  };
  return {contract, issues};
}

export interface ConclusionSidecarMachineSegment {
  start: number;
  end: number;
  startLine: number;
  /** -1 means the explicit machine segment was interrupted. */
  endLine: number;
}

function newSidecarLineState() {
  return {
    length: 0, prefixIndex: 0, pendingPrefix: '', startText: '', commentTail: '',
    hasCommentClose: false, equalsTerminator: true,
    fencePossible: true, fenceCharacter: '', fenceLength: 0, fenceTail: false,
    fenceTailWhitespace: true, fenceTailBacktick: false, fenceTailLineBreak: false,
  };
}

/**
 * The shared framing grammar for final parsing and live narrative projection.
 * Only a possible line-start marker and one CR are withheld. Machine payloads
 * and visible prose are never retained; line/fence recognition uses counters.
 */
export class ConclusionSidecarFramingScanner {
  private line = newSidecarLineState();
  private offset = 0;
  private lineStart = 0;
  private lineIndex = 0;
  private fence: {character: string; length: number} | undefined;
  private htmlComment = false;
  private machineStart: {offset: number; line: number} | undefined;
  private pendingCr = false;
  private ended = false;
  private markers = 0;

  constructor(private readonly onMachineSegment?: (segment: ConclusionSidecarMachineSegment) => void) {}

  get markerCount(): number { return this.markers; }

  /** Diagnostic of text awaiting disambiguation, independent of answer length. */
  get bufferedCharacterCount(): number {
    return this.line.pendingPrefix.length + (this.pendingCr ? 1 : 0);
  }

  write(text: string): string {
    if (this.ended) return '';
    let visible = '';
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      this.offset++;
      if (this.pendingCr) {
        this.pendingCr = false;
        if (character === '\n') {
          visible += this.endLine('\r\n');
          continue;
        }
        visible += this.consumeCharacter('\r');
      }
      if (character === '\r') this.pendingCr = true;
      else if (character === '\n') visible += this.endLine('\n');
      else visible += this.consumeCharacter(character);
    }
    return visible;
  }

  finish(): string {
    if (this.ended) return '';
    let visible = '';
    if (this.pendingCr) {
      this.pendingCr = false;
      visible += this.consumeCharacter('\r');
    }
    visible += this.endLine('');
    if (this.machineStart) this.emitSegment(this.offset, -1);
    this.ended = true;
    return visible;
  }

  reset(): void {
    this.line = newSidecarLineState();
    this.offset = this.lineStart = this.lineIndex = this.markers = 0;
    this.fence = this.machineStart = undefined;
    this.htmlComment = this.pendingCr = this.ended = false;
  }

  private consumeCharacter(character: string): string {
    const line = this.line;
    line.length++;
    line.equalsTerminator &&= character === '-->'[line.length - 1];
    if (!this.machineStart) {
      if (line.startText.length < 7) line.startText += character;
      line.commentTail = (line.commentTail + character).slice(-3);
      line.hasCommentClose ||= line.commentTail === '-->';
      this.consumeFenceCharacter(character);
    }

    if (this.fence || this.htmlComment) return character;
    if (line.prefixIndex >= 0) {
      if (character === SIDECAR_PREFIX[line.prefixIndex]) {
        line.prefixIndex++;
        if (line.prefixIndex === SIDECAR_PREFIX.length) {
          this.markers++;
          this.machineStart ??= {offset: this.lineStart, line: this.lineIndex};
          line.pendingPrefix = '';
          line.prefixIndex = -1;
        } else if (!this.machineStart) line.pendingPrefix += character;
        return '';
      }
      line.prefixIndex = -1;
    }
    if (this.machineStart) return '';
    const visible = line.pendingPrefix + character;
    line.pendingPrefix = '';
    return visible;
  }

  private consumeFenceCharacter(character: string): void {
    const line = this.line;
    if (!line.fencePossible) return;
    if (!line.fenceCharacter) {
      if (character === ' ' && line.length <= 3) return;
      if ((character === '`' || character === '~') && line.length <= 4) {
        line.fenceCharacter = character;
        line.fenceLength = 1;
      } else line.fencePossible = false;
    } else if (!line.fenceTail && character === line.fenceCharacter) {
      line.fenceLength++;
    } else {
      line.fenceTail = true;
      line.fenceTailWhitespace &&= /\s/.test(character);
      line.fenceTailBacktick ||= character === '`';
      // Match the existing opening regex's dot semantics, including bare CR.
      line.fenceTailLineBreak ||= /[\r\u2028\u2029]/.test(character);
    }
  }

  private endLine(newline: string): string {
    const line = this.line;
    let visible = line.pendingPrefix;
    if (this.machineStart) {
      if (line.length === 3 && line.equalsTerminator) {
        this.emitSegment(this.lineStart + line.length, this.lineIndex);
      }
    } else if (this.fence) {
      if (line.fenceCharacter === this.fence.character && line.fenceLength >= this.fence.length &&
        line.fenceTailWhitespace) this.fence = undefined;
    } else if (this.htmlComment) {
      if (line.hasCommentClose) this.htmlComment = false;
    } else if (line.fenceLength >= 3 && !line.fenceTailLineBreak &&
      (line.fenceCharacter !== '`' || !line.fenceTailBacktick)) {
      this.fence = {character: line.fenceCharacter, length: line.fenceLength};
    } else if (/^ {0,3}<!--/.test(line.startText) && !line.hasCommentClose) {
      this.htmlComment = true;
    }
    if (!this.machineStart) visible += newline;
    this.line = newSidecarLineState();
    this.lineStart = this.offset;
    this.lineIndex++;
    return visible;
  }

  private emitSegment(end: number, endLine: number): void {
    const start = this.machineStart!;
    this.onMachineSegment?.({start: start.offset, end, startLine: start.line, endLine});
    this.machineStart = undefined;
  }
}

/** Recognize explicit top-level sidecars without interpreting ordinary prose. */
export function parseConclusionContractSidecar(raw: string): ConclusionContractSidecarParseResult {
  const lines = raw.split(/\r?\n/);
  const markers: Array<{start: number; end: number}> = [];
  const machineSegments: Array<{start: number; end: number}> = [];
  const scanner = new ConclusionSidecarFramingScanner(segment => {
    markers.push({start: segment.startLine, end: segment.endLine});
    machineSegments.push({start: segment.start, end: segment.end});
  });
  const narrative = scanner.write(raw) + scanner.finish();
  const markerCount = scanner.markerCount;
  const base = {raw, narrative, machineSegments, issues: [] as ConclusionContractParseIssue[]};
  if (markerCount === 0) return {...base, status: 'absent', bindingEligibility: 'legacy_unchecked'};
  if (markerCount !== 1) return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'duplicate_marker', path: '$'}]};
  const marker = markers[0];
  if (marker.end < 0 || lines[marker.start] !== SIDECAR_MARKER || lines[marker.start + 1] !== '```json' ||
    lines[marker.end - 1] !== '```') return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'invalid_framing', path: '$'}]};
  const payload = lines.slice(marker.start + 2, marker.end - 1).join('\n');
  if (payload.includes('-->')) return {...base, status: 'invalid', bindingEligibility: 'ineligible',
    issues: [{code: 'invalid_framing', path: '$'}]};
  let rawPayload: unknown;
  try { rawPayload = JSON.parse(payload); }
  catch { return {...base, status: 'invalid', bindingEligibility: 'ineligible', issues: [{code: 'invalid_json', path: '$'}]}; }
  const projected = parseConclusionContractDeclaration(rawPayload);
  const status = projected.issues.length ? 'invalid' : 'valid';
  return {...base, rawPayload, ...projected, status,
    bindingEligibility: status === 'valid' ? 'eligible' : 'ineligible',
  };
}

/** Raw invalid declarations are serialized as declarations, then validated anew. */
export function renderConclusionContractSidecar(contract: ConclusionContract): string {
  const {parseIssues: _issues, bindingEligibility: _eligibility, rawClaims, rawRelationProposals, rawDeclaration, ...body} = contract;
  const claims = hasOwn(contract, 'rawClaims') ? rawClaims : contract.claims?.map(claim => {
    const {rawSemantics, semanticsParseIssues: _semanticIssues, rawReferences, ...declaration} = claim;
    return {...declaration,
      ...(hasOwn(claim, 'rawSemantics') ? {semantics: rawSemantics} : {}),
      ...(hasOwn(claim, 'rawReferences') ? {references: rawReferences} : {}),
    };
  });
  const declaration = hasOwn(contract, 'rawDeclaration') ? rawDeclaration : {...body,
    ...(claims !== undefined ? {claims} : {}),
    ...(hasOwn(contract, 'rawRelationProposals') ? {relationProposals: rawRelationProposals} : {}),
  };
  const serialized = JSON.stringify(declaration, null, 2);
  if (serialized === undefined) throw new Error('Cannot serialize an unavailable conclusion declaration');
  const payload = serialized.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `${SIDECAR_MARKER}\n\`\`\`json\n${payload}\n\`\`\`\n-->`;
}
