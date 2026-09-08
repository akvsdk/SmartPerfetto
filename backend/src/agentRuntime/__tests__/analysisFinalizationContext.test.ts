// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, jest} from '@jest/globals';
import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {attachFinalizationContext, takeFinalizationContext,
  type RuntimeFinalizationContextInput} from '../analysisFinalizationContext';

const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'finalization-test'});

function fixture(overrides: Partial<RuntimeFinalizationContextInput> = {}) {
  const result: AnalysisResult = {sessionId: 'session', conclusion: 'Measured output', success: true,
    confidence: 0.8, findings: [], hypotheses: [], rounds: 1, totalDurationMs: 1};
  const candidate = {runId: 'run', attemptId: 'attempt', candidateRef: 'candidate',
    conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)};
  const input: RuntimeFinalizationContextInput = {
    runId: 'run', sessionId: result.sessionId, deadlineMs: Date.now() + 1000,
    strategyRegistry: registry,
    turnIntent: {schemaVersion: 1, status: 'resolved', source: 'semantic',
      registryFingerprint: registry.registryFingerprint, taskKind: 'fact', sceneId: 'general',
      scope: 'bounded_question', recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'existing_only'},
    traceIdentity: {currentTraceId: 'trace'},
    deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate,
      completion: {...candidate, schemaVersion: 1, status: 'completed', runtimeKind: 'openai-agents-sdk'},
      outputOrigin: 'sdk_final'},
    ...overrides,
  };
  return {result, input};
}

const textInput = (signal: AbortSignal, deadlineMs = Date.now() + 1000) => ({
  signal, deadlineMs, prompt: 'review', systemPrompt: 'review', outputByteLimit: 1000,
});

afterEach(() => {jest.useRealTimers();});

describe('private runtime finalization context', () => {
  it('is taken once from the exact result and never copied into serializable results', () => {
    const {result, input} = fixture({dispatchText: async () => ({status: 'ok', text: 'private provider output'})});
    const before = JSON.stringify(result);
    attachFinalizationContext(result, input);
    expect(JSON.stringify(result)).toBe(before);
    expect(takeFinalizationContext({...result})).toBeUndefined();
    expect(takeFinalizationContext(JSON.parse(before))).toBeUndefined();
    const context = takeFinalizationContext(result)!;
    expect(context.runId).toBe('run');
    expect(takeFinalizationContext(result)).toBeUndefined();
    context.dispose();
    expect(() => context.hasSemanticTransport).toThrow();
  });

  it('detaches captured input facts before callers can mutate them', () => {
    const {result, input} = fixture();
    attachFinalizationContext(result, input);
    input.traceIdentity.currentTraceId = 'another-trace';
    if (input.deliveryContext.entry !== 'historical_restore') input.deliveryContext.acceptedCandidate!.runId = 'another-run';
    const context = takeFinalizationContext(result)!;
    expect(context.traceIdentity.currentTraceId).toBe('trace');
    expect(context.deliveryContext).toMatchObject({acceptedCandidate: {runId: 'run'}});
    expect(Object.isFrozen(context.traceIdentity)).toBe(true);
    context.dispose();
  });

  it('keeps provider query in a frozen private method view that expires with its context', () => {
    const query = {text: 'PRIVATE_PROVIDER_QUERY', analysisContextFingerprint: 'selection-v1'};
    const {result, input} = fixture({providerQuery: query});
    attachFinalizationContext(result, input);
    query.text = 'A changed query';
    const context = takeFinalizationContext(result)!;
    const signal = new AbortController().signal;
    expect(context.getProviderQuery(signal)).toEqual({text: 'PRIVATE_PROVIDER_QUERY', analysisContextFingerprint: 'selection-v1'});
    expect(Object.isFrozen(context.getProviderQuery(signal))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_QUERY');
    expect(JSON.stringify(context)).not.toContain('PRIVATE_PROVIDER_QUERY');
    const cancelled = new AbortController();
    cancelled.abort();
    expect(() => context.getProviderQuery(cancelled.signal)).toThrow();
    context.dispose();
    expect(() => context.getProviderQuery(signal)).toThrow();
  });

  it('rejects historical, wrong-run, wrong-session and mismatched registry contexts', () => {
    for (const overrides of [
      {deliveryContext: {entry: 'historical_restore' as const}},
      {runId: 'another'}, {sessionId: 'another'},
      {turnIntent: {...fixture().input.turnIntent, registryFingerprint: 'another'}},
    ]) {
      const {result, input} = fixture(overrides);
      expect(() => attachFinalizationContext(result, input)).toThrow();
      expect(takeFinalizationContext(result)).toBeUndefined();
    }
  });

  it('does not replace a context already attached to the same result', () => {
    const {result, input} = fixture();
    attachFinalizationContext(result, input);
    expect(() => attachFinalizationContext(result, input)).toThrow();
    takeFinalizationContext(result)!.dispose();
  });

  it.each(['reader', 'provider'] as const)('bounds an unresponsive %s by the original deadline', async kind => {
    jest.useFakeTimers({now: 1000});
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({deadlineMs: 1100,
      evidenceReadView: {resolveReferences: (_requests, signal) => {
        receivedSignal = signal; return new Promise(() => {});
      }},
      dispatchText: request => {receivedSignal = request.signal; return new Promise(() => {});},
    });
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const signal = new AbortController().signal;
    const pending = kind === 'reader'
      ? context.resolveReferences([{key: 'ref', reference: {artifactId: 'artifact'}, requiredColumns: []}], signal)
      : context.dispatchText(textInput(signal, 9000));
    await jest.advanceTimersByTimeAsync(100);
    expect(receivedSignal?.aborted).toBe(true);
    expect(await pending).toEqual(kind === 'reader'
      ? [{key: 'ref', status: 'incomplete', reason: 'deadline_exceeded'}]
      : {status: 'unavailable', reason: 'timeout'});
    context.dispose();
  });

  it.each(['caller', 'dispose'] as const)('cancels in-flight callbacks via %s even when they ignore abort', async source => {
    let receivedSignal: AbortSignal | undefined;
    const {result, input} = fixture({dispatchText: request => {
      receivedSignal = request.signal; return new Promise(() => {});
    }});
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    const pending = context.dispatchText(textInput(controller.signal));
    const assertion = expect(pending).rejects.toMatchObject({name: 'AbortError'});
    await Promise.resolve();
    if (source === 'caller') controller.abort();
    else context.dispose();
    await assertion;
    expect(receivedSignal?.aborted).toBe(true);
    context.dispose();
  });

  it('never dispatches an expired or cancelled operation and clamps a longer requested deadline', async () => {
    const dispatchText = jest.fn<NonNullable<RuntimeFinalizationContextInput['dispatchText']>>()
      .mockResolvedValue({status: 'ok', text: '{}'});
    const {result, input} = fixture({dispatchText});
    attachFinalizationContext(result, input);
    const context = takeFinalizationContext(result)!;
    const controller = new AbortController();
    await context.dispatchText(textInput(controller.signal, input.deadlineMs + 1000));
    expect(dispatchText.mock.calls[0][0].deadlineMs).toBe(input.deadlineMs);
    expect(await context.dispatchText(textInput(controller.signal, 1))).toEqual({status: 'unavailable', reason: 'timeout'});
    controller.abort();
    await expect(context.dispatchText(textInput(controller.signal))).rejects.toMatchObject({name: 'AbortError'});
    expect(dispatchText).toHaveBeenCalledTimes(1);
    context.dispose();
  });
});
