// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash, randomUUID} from 'crypto';

export type EvidenceScalar = string | number | boolean | null;
export interface CapturedFieldSemantics {
  origin: {kind: 'skill_literal' | 'native_producer'; definitionFingerprint: string;
    skillId?: string; stepId?: string; selectedSqlHash?: string};
  unit?: string;
  timeRole?: 'start' | 'end' | 'duration';
  clock?: 'trace_monotonic';
  metricId?: string;
  aggregation?: string;
  populationKey?: string;
}
export interface EvidenceTableWitness {readonly captureId: string}
export interface CapturedEvidenceTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (EvidenceScalar | undefined)[])[];
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
  readonly unavailableReason?: string;
}
export interface CapturedAnchorFacts {
  readonly captureId: string;
  readonly originalRowIndex: number;
  readonly referenceKey?: string;
  readonly queryHash?: string;
  readonly row: Readonly<Record<string, EvidenceScalar>>;
  readonly fields: Readonly<Record<string, CapturedFieldSemantics>>;
}
const tables = new WeakMap<EvidenceTableWitness, CapturedEvidenceTable>();
const owners = new WeakMap<object, EvidenceTableWitness>();
const anchorFacts = new WeakMap<object, CapturedAnchorFacts>();

export function freezeEvidenceValue<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeEvidenceValue);
    Object.freeze(value);
  }
  return value;
}

export function evidenceCaptureHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    if (input && typeof input === 'object') return `{${Object.keys(input).sort()
      .map(key => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`).join(',')}}`;
    return JSON.stringify(input) ?? 'null';
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function captureEvidenceTable(data: unknown,
  fields: Record<string, CapturedFieldSemantics> = {}, unavailableReason?: string): EvidenceTableWitness {
  const witness = Object.freeze({captureId: randomUUID()});
  const payload = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const rawRows = Array.isArray(data) ? data : Array.isArray(payload?.rows) ? payload.rows : undefined;
  const rawColumns = Array.isArray(payload?.columns) ? payload.columns : rawRows?.[0] &&
    typeof rawRows[0] === 'object' && !Array.isArray(rawRows[0]) ? Object.keys(rawRows[0]) : [];
  const columns = rawColumns.filter((column): column is string => typeof column === 'string');
  const scalar = (value: unknown): EvidenceScalar | undefined => value === null || typeof value === 'string' ||
    typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
  const reason = unavailableReason || (!rawRows ? 'unmapped_evidence_shape' :
    columns.length !== rawColumns.length || columns.some(column => !column.trim()) ? 'invalid_evidence_columns' :
      rawRows.length > 0 && columns.length === 0 ? 'unmapped_evidence_columns' : undefined);
  const rows = (rawRows || []).map(row => columns.map((column, index) => scalar(Array.isArray(row)
    ? row[index] : row && typeof row === 'object' ? (row as Record<string, unknown>)[column] : undefined)));
  tables.set(witness, freezeEvidenceValue({columns: [...columns], rows,
    fields: structuredClone(fields), ...(reason ? {unavailableReason: reason} : {})}));
  return witness;
}

export function capturedEvidenceTable(witness: EvidenceTableWitness): CapturedEvidenceTable | undefined {
  return tables.get(witness);
}
export function attachEvidenceTable(owner: object, witness: EvidenceTableWitness): void {
  if (!tables.has(witness)) throw new Error('Unissued evidence table witness');
  owners.set(owner, witness);
}
export function evidenceTableFor(owner: object): EvidenceTableWitness | undefined {return owners.get(owner);}

export function bindCapturedAnchorFacts(anchor: object, witness: EvidenceTableWitness, rowIndex: number,
  selectedColumns?: readonly string[], referenceKey?: string): void {
  if (anchorFacts.has(anchor)) throw new Error('Captured anchor facts cannot be rebound');
  const table = tables.get(witness);
  if (!table || table.unavailableReason || !Number.isSafeInteger(rowIndex) || rowIndex < 0 ||
      !table.rows[rowIndex] || new Set(table.columns).size !== table.columns.length) return;
  const selected = new Set(selectedColumns || table.columns);
  const row: Record<string, EvidenceScalar> = Object.create(null);
  const fields: Record<string, CapturedFieldSemantics> = Object.create(null);
  table.columns.forEach((column, index) => {
    const value = table.rows[rowIndex][index];
    if (selected.has(column) && value !== undefined) row[column] = value;
    if (selected.has(column) && table.fields[column]) fields[column] = structuredClone(table.fields[column]);
  });
  const hashes = new Set(Object.values(fields).map(field => field.origin.selectedSqlHash).filter(Boolean));
  anchorFacts.set(anchor, freezeEvidenceValue({captureId: witness.captureId, originalRowIndex: rowIndex, row, fields,
    ...(referenceKey ? {referenceKey} : {}),
    ...(hashes.size === 1 ? {queryHash: [...hashes][0]} : {})}));
  freezeEvidenceValue(anchor);
}
export function getCapturedAnchorFacts(anchor: object): CapturedAnchorFacts | undefined {return anchorFacts.get(anchor);}
