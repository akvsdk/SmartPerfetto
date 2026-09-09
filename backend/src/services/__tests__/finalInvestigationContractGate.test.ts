// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';
import {analysisDeliveryFingerprint, type AnalysisDeliveryContext} from '../../types/analysisDelivery';
import type {InvestigationEvidenceRecord, InvestigationEvidenceSnapshot} from '../evidence/investigationEvidenceLedger';
import {investigationEvidenceFingerprint} from '../evidence/investigationEvidenceLedger';
import {assessFinalInvestigationContract} from '../finalInvestigationContractGate';
import {applyFinalResultQualityGate} from '../finalResultQualityGate';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';

function fixture() {
  const conclusion = 'The frequency was observed in this task window.';
  const conclusionContract = {schemaVersion: 'conclusion_contract_v1', claims: []};
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
  const record: InvestigationEvidenceRecord = {
    recordId: 'capture:0:0', captureId: 'capture', rowIndex: 0, skillId: 'system', stepId: 'query',
    definitionFingerprint: 'definition', selectedSqlHash: 'sql', traceId: 'trace', traceSide: 'current',
    originRunId: 'run', origin: 'current_run', domain: 'cpu', metricId: 'frequency', status: 'observed',
    window: {start: 100, end: 200}, upid: 1, utid: 2, value: 1200, unit: 'MHz', coverage: 100, denominator: 100,
  };
  const body: Omit<InvestigationEvidenceSnapshot, 'fingerprint'> = {
    schemaVersion: 'investigation_evidence@1', ownerKey: 'run', currentRunId: 'run', records: [record], issues: [], complete: true,
  };
  const context: Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> = {
    entry: 'new_finalization', acceptedCandidate: candidate, evidenceFingerprint: 'claims-evidence',
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation',
      sceneId: 'test', scope: 'scene_wide', recommendedComplexity: 'quick', deliverable: 'answer',
      evidenceAccess: 'read_new', registryFingerprint: 'registry'},
    investigationRequirements: {schemaVersion: 1, status: 'resolved', sceneId: 'test', registryFingerprint: 'registry',
      contractFingerprint: 'profile', legacyRequirements: [], requirements: [{id: 'frequency', domain: 'cpu',
        description: 'Task frequency and data coverage.', required: true, evidenceMetrics: ['frequency']}]},
    investigationEvidence: {...body, fingerprint: investigationEvidenceFingerprint(body)},
  };
  const bind = () => {
    if (context.investigationEvidence) context.investigationEvidence = {...context.investigationEvidence,
      fingerprint: investigationEvidenceFingerprint(context.investigationEvidence)};
    context.investigationAssessment = {schemaVersion: 1, status: 'checked',
      binding: {...candidate, conclusionContractFingerprint: analysisDeliveryFingerprint(conclusionContract),
        evidenceFingerprint: context.evidenceFingerprint!,
        requirementsFingerprint: analysisDeliveryFingerprint(context.investigationRequirements),
        registryFingerprint: context.turnIntent!.registryFingerprint,
        intentFingerprint: analysisDeliveryFingerprint(context.turnIntent),
        ledgerFingerprint: analysisDeliveryFingerprint(context.investigationEvidence ?? null)},
      requirements: [{requirementId: 'frequency', domain: 'cpu', applicability: 'applicable', coverage: 'covered',
        contentLocations: [{start: 0, end: conclusion.length}], evidenceRecordIds: [record.recordId], scopeMatch: 'matched',
        evidenceStatus: 'observed', acquisition: 'observed'}]};
  };
  bind();
  const evaluate = () => assessFinalInvestigationContract({conclusion, conclusionContract, context});
  return {conclusion, conclusionContract, candidate, context, record, bind, evaluate};
}

describe('independent investigation coverage', () => {
  it('accepts the same bound scope for an answer and a report without requiring a report', () => {
    const run = fixture();
    expect(run.evaluate()).toMatchObject({status: 'passed', evidenceStatus: 'passed'});
    run.context.turnIntent = {...run.context.turnIntent!, deliverable: 'report', recommendedComplexity: 'full'};
    run.bind();
    expect(run.evaluate()).toMatchObject({status: 'passed', evidenceStatus: 'passed'});
  });

  it('does not let collected metrics replace a missing explanation', () => {
    const run = fixture();
    run.context.investigationAssessment!.requirements[0].coverage = 'missing';
    expect(run.evaluate()).toMatchObject({status: 'failed', evidenceStatus: 'passed'});
  });

  it('can cover an accurate partial-data explanation without claiming complete acquisition', () => {
    const run = fixture();
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [{...run.record, status: 'partial'}]};
    run.bind();
    run.context.investigationAssessment!.requirements[0].evidenceStatus = 'insufficient';
    expect(run.evaluate()).toMatchObject({status: 'passed', evidenceStatus: 'coverage_incomplete',
      requirements: [{acquisition: 'insufficient'}]});
  });

  it('does not accept a normal/observed claim when no matching record was collected', () => {
    const run = fixture();
    run.context.investigationAssessment!.requirements[0].evidenceRecordIds = [];
    expect(run.evaluate()).toMatchObject({status: 'coverage_incomplete', evidenceStatus: 'not_checked'});
    run.context.investigationAssessment!.requirements[0].evidenceStatus = 'not_checked';
    expect(run.evaluate()).toMatchObject({status: 'passed', evidenceStatus: 'not_checked'});
  });

  it.each(['unknown', 'mismatched'] as const)('does not count %s task/window scope as observed', scopeMatch => {
    const run = fixture();
    run.context.investigationAssessment!.requirements[0].scopeMatch = scopeMatch;
    expect(run.evaluate()).toMatchObject({status: 'coverage_incomplete', evidenceStatus: 'coverage_incomplete'});
  });

  it('rejects unknown/duplicate IDs and unrelated metric domains', () => {
    for (const ids of [['forged'], ['capture:0:0', 'capture:0:0']]) {
      const run = fixture();
      run.context.investigationAssessment!.requirements[0].evidenceRecordIds = ids;
      expect(run.evaluate().status).toBe('coverage_incomplete');
    }
    const run = fixture();
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [{...run.record, domain: 'unrelated'}]};
    run.bind();
    expect(run.evaluate().status).toBe('coverage_incomplete');
  });

  it('does not count unknown provenance as current evidence and preserves reused evidence', () => {
    const run = fixture();
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [{...run.record, origin: 'unknown'}]};
    run.bind();
    expect(run.evaluate().evidenceStatus).toBe('coverage_incomplete');
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [{...run.record, origin: 'reused', originRunId: 'earlier'}]};
    run.context.turnIntent = {...run.context.turnIntent!, evidenceAccess: 'existing_only'};
    run.bind();
    expect(run.evaluate().evidenceStatus).toBe('passed');
  });

  it('cannot cherry-pick a covered CPU when a sibling CPU has a gap or an invalid row was omitted', () => {
    const run = fixture();
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [run.record,
      {...run.record, recordId: 'capture:1:0', rowIndex: 1, status: 'partial', coverage: 50}]};
    run.bind();
    expect(run.evaluate()).toMatchObject({status: 'coverage_incomplete', evidenceStatus: 'coverage_incomplete',
      requirements: [{acquisition: 'insufficient'}]});
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [run.record],
      incompleteCaptureIds: ['capture']};
    run.bind();
    expect(run.evaluate().requirements[0].acquisition).toBe('unknown');
  });

  it('does not substitute task-running weighting for whole-window CPU frequency', () => {
    const run = fixture();
    run.context.investigationEvidence = {...run.context.investigationEvidence!, records: [{...run.record, metricId: 'running-frequency'}]};
    run.bind();
    expect(run.evaluate().requirements[0].acquisition).toBe('insufficient');
  });

  it('keeps explanation-only requirements out of the acquisition denominator', () => {
    const run = fixture();
    run.context.investigationRequirements = {...run.context.investigationRequirements!, requirements: [
      {...run.context.investigationRequirements!.requirements[0], evidenceMetrics: undefined}]};
    run.bind();
    run.context.investigationAssessment!.requirements[0].evidenceStatus = 'not_applicable';
    run.context.investigationAssessment!.requirements[0].evidenceRecordIds = [];
    expect(run.evaluate()).toMatchObject({status: 'passed', evidenceStatus: 'not_applicable'});
  });

  it('invalidates verdicts when any bound input changes', () => {
    const mutations = [
      (run: ReturnType<typeof fixture>) => {run.context.acceptedCandidate = {...run.candidate, runId: 'other'};},
      (run: ReturnType<typeof fixture>) => {run.context.evidenceFingerprint = 'changed';},
      (run: ReturnType<typeof fixture>) => {run.context.turnIntent = {...run.context.turnIntent!, scope: 'bounded_question'};},
      (run: ReturnType<typeof fixture>) => {run.context.investigationRequirements = {...run.context.investigationRequirements!, contractFingerprint: 'changed'};},
      (run: ReturnType<typeof fixture>) => {run.context.investigationEvidence = {...run.context.investigationEvidence!, complete: false};},
    ];
    for (const mutate of mutations) {
      const run = fixture(); mutate(run); expect(run.evaluate().status).toBe('not_checked');
    }
    const run = fixture();
    expect(assessFinalInvestigationContract({conclusion: run.conclusion + ' ', conclusionContract: run.conclusionContract,
      context: run.context}).status).toBe('not_checked');
    expect(assessFinalInvestigationContract({conclusion: run.conclusion, conclusionContract: {},
      context: run.context}).status).toBe('not_checked');
  });

  it('keeps old and missing assessments unverified and explicit exemptions separate', () => {
    const run = fixture();
    delete run.context.investigationAssessment;
    expect(run.evaluate().status).toBe('not_checked');
    expect(assessFinalInvestigationContract({conclusion: run.conclusion, context: {entry: 'historical_restore'}}).status).toBe('not_checked');
    run.context.investigationRequirements = {...run.context.investigationRequirements!, status: 'not_applicable'};
    expect(run.evaluate().status).toBe('not_applicable');
  });

  it('cannot waive unconditional scene requirements or accept duplicate requirement rows', () => {
    const run = fixture();
    run.context.investigationAssessment!.requirements[0].applicability = 'not_applicable';
    run.context.investigationAssessment!.requirements[0].coverage = 'unknown';
    expect(run.evaluate().status).toBe('coverage_incomplete');
    run.context.investigationAssessment!.requirements = [...run.context.investigationAssessment!.requirements,
      ...run.context.investigationAssessment!.requirements];
    expect(run.evaluate().status).toBe('not_checked');
  });

  it('does not alter SDK completion, body or termination because investigation is missing', () => {
    const run = fixture();
    run.context.completion = {...run.candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'};
    run.context.outputOrigin = 'sdk_final';
    run.context.investigationAssessment!.requirements[0].coverage = 'missing';
    const result: AnalysisResult = {sessionId: 'session', conclusion: run.conclusion, success: true,
      confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
    // Bind the actual result contract, including absence, without changing the candidate.
    run.context.investigationAssessment!.binding.conclusionContractFingerprint = analysisDeliveryFingerprint(undefined);
    const issue = applyFinalResultQualityGate({result, query: 'Explain.', context: run.context});
    expect(issue).toBeUndefined();
    expect(result).toMatchObject({conclusion: run.conclusion, success: true,
      completion: {status: 'completed'}, deliveryAssurance: {completion: 'passed', investigation: 'failed'}});
    expect(result.terminationReason).toBeUndefined();
    expect(result.partial).toBeUndefined();
  });
});
