// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Finding } from '../agent/types';
import type { SceneType } from './sceneClassifier';
import type { ComplexityClassifierInput, SelectionContext } from './types';

const RECENT_TURN_LIMIT = 3;
const RECENT_FINDING_LIMIT = 5;

type PriorTurn = {
  id?: string;
  query?: string;
  intent?: { complexity?: string; referencedEntities?: Array<{type: string; id?: number | string}> };
  findings?: Finding[];
};

interface BuildComplexityClassifierInputParams {
  query: string;
  sceneType: SceneType;
  selectionContext?: SelectionContext;
  hasReferenceTrace: boolean;
  previousTurns: PriorTurn[];
  requestedMode?: ComplexityClassifierInput['requestedMode'];
}

function isFullLikeTurn(turn: PriorTurn): boolean {
  const complexity = turn.intent?.complexity;
  return complexity === 'complex' || complexity === 'moderate';
}

function formatFindingSummary(finding: Finding): string | null {
  const title = typeof finding.title === 'string' ? finding.title.trim() : '';
  if (!title) return null;
  const parts = [title];
  if (finding.category) parts.push(`category=${finding.category}`);
  if (finding.severity) parts.push(`severity=${finding.severity}`);
  return parts.join(' | ');
}

export function buildComplexityClassifierInput(
  params: BuildComplexityClassifierInputParams,
): ComplexityClassifierInput {
  const recentTurns = params.previousTurns.slice(-RECENT_TURN_LIMIT);
  const recentFullTurns = recentTurns.filter(isFullLikeTurn);
  const previousFindings = recentTurns
    .flatMap(turn => turn.findings ?? [])
    .map(formatFindingSummary)
    .filter((summary): summary is string => !!summary)
    .slice(-RECENT_FINDING_LIMIT);
  const previousFindingDetails = recentTurns.flatMap((turn, index) =>
    (turn.findings ?? []).filter(finding => finding.title?.trim()).map(finding => ({
      turnIndex: params.previousTurns.length - recentTurns.length + index,
      ...(turn.id ? {turnId: turn.id} : {}),
      ...(finding.id ? {id: finding.id} : {}),
      title: finding.title.trim().slice(0, 240),
      ...(finding.description ? {description: finding.description.slice(0, 800)} : {}),
      ...(finding.category ? {category: finding.category} : {}),
    }))).slice(-RECENT_FINDING_LIMIT);
  const previousEntities = recentTurns.flatMap((turn, index) =>
    (turn.intent?.referencedEntities ?? []).flatMap(entity =>
      typeof entity.id === 'string' || (typeof entity.id === 'number' && Number.isFinite(entity.id))
        ? [{turnIndex: params.previousTurns.length - recentTurns.length + index, type: entity.type, id: entity.id}]
        : [])).slice(-10);

  return {
    query: params.query,
    sceneType: params.sceneType,
    hasSelectionContext: !!params.selectionContext,
    selectionContext: params.selectionContext,
    hasReferenceTrace: params.hasReferenceTrace,
    hasExistingFindings: previousFindings.length > 0,
    hasPriorFullAnalysis: recentFullTurns.length > 0,
    previousQueries: recentTurns.map(t => t.query).filter((q): q is string => !!q),
    previousFindings,
    previousFindingDetails,
    previousEntities,
    ...(params.requestedMode ? {requestedMode: params.requestedMode} : {}),
  };
}
