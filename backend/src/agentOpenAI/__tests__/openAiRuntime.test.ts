// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import {MaxTurnsExceededError, OpenAIChatCompletionsModel, OpenAIProvider, Runner, withTrace} from '@openai/agents';
import {OpenAIRuntime, __testing} from '../openAiRuntime';
import type {AnalysisPlanV3, PlanPhase} from '../../agentv3/types';
import type {TraceProcessorService} from '../../services/traceProcessorService';
import type {OpenAIAgentConfig} from '../../agentRuntime/engines/openai/openAiConfig';
import * as finalization from '../../agentRuntime/analysisFinalizationContext';
import {ArtifactStore} from '../../agentv3/artifactStore';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import {buildTraceProcessorQueryProvenance} from '../../services/traceProcessorConnectionModel';
import * as sourceProjection from '../../services/codebase/sourceClaimVerifier';
import {
  clearCodeAwareOutputGuards, createCodeAwareStreamingTextProjection,
  registerCodeAwareCanary, revokeCodeAwareOutputGuards,
} from '../../services/security/codeAwareOutputRegistry';
import * as verifier from '../../agentRuntime/engines/claude/claudeVerifier';
import * as patternMemory from '../../agentv3/analysisPatternMemory';
import * as configModule from '../../agentRuntime/engines/openai/openAiConfig';
import * as intentTransport from '../../agentRuntime/engines/openai/openAiIntentTransport';
import type {AnalysisTurnIntentDecision} from '../../agentRuntime/analysisTurnIntent';
import * as systemPrompt from '../../agentv3/claudeSystemPrompt';
import * as focusDetector from '../../agentv3/focusAppDetector';
import * as mcpModule from '../../agentv3/claudeMcpServer';
import {getSourceLookupCodeReferences} from '../../services/codebase/sourceLookupTools';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createRuntimeSourceFinalizationFixture, SOURCE_FINALIZATION_CANARY, SOURCE_FINALIZATION_RAW_SOURCE} from '../../agentRuntime/__tests__/sourceFinalizationFixture';

const runtimes: OpenAIRuntime[] = [];
const privacySessions: string[] = [];
const finalizationContexts: finalization.RuntimeFinalizationContext[] = [];
const decision: AnalysisTurnIntentDecision = {
  schemaVersion: 1, taskKind: 'fact', sceneId: 'general', scope: 'bounded_question',
  recommendedComplexity: 'quick', deliverable: 'answer', evidenceAccess: 'read_new',
};
function createOpenAiConfigForTest(): OpenAIAgentConfig {
  return {model: 'pinned-primary', lightModel: 'pinned-light', apiKey: 'test-only',
    baseURL: 'https://provider.invalid/v1', protocol: 'responses', cwd: process.cwd(),
    maxOutputTokens: 1024, maxTurns: 3, quickMaxTurns: 2, quickTargetTurns: 1,
    fullPathPerTurnMs: 60_000, fullRequestTimeoutMs: 60_000, streamIdleTimeoutMs: 60_000,
    maxHistoryBytes: 4 * 1024 * 1024, quickPathPerTurnMs: 30_000,
    classifierTimeoutMs: 10_000, outputLanguage: 'zh-CN'};
}
function classify(value: AnalysisTurnIntentDecision = decision) {
  jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({
    status: 'ok', text: JSON.stringify(value), actualModel: 'pinned-light', finishReason: 'stop',
  });
}
beforeEach(() => {
  jest.spyOn(configModule, 'loadOpenAIConfig').mockReturnValue(createOpenAiConfigForTest());
  jest.spyOn(intentTransport, 'runOpenAiIntentTransport');
  classify();
});
afterEach(() => {
  for (const context of finalizationContexts.splice(0)) context.dispose();
  for (const runtime of runtimes.splice(0)) runtime.reset();
  for (const sessionId of privacySessions.splice(0)) clearCodeAwareOutputGuards(sessionId);
  jest.restoreAllMocks();
});
function createOpenAiRuntimeForTest(trace?: TraceProcessorService): any {
  const runtime = new OpenAIRuntime(trace ?? {query: jest.fn(async () => ({columns: [], rows: [], durationMs: 0})), getTrace: jest.fn()} as unknown as TraceProcessorService);
  runtimes.push(runtime);
  jest.spyOn(runtime as any, 'recordPatternMemory').mockImplementation(() => undefined);
  return runtime;
}
function createRuntimeWithUpdates() {
  const runtime = createOpenAiRuntimeForTest();
  const updates: any[] = [];
  runtime.on('update', (update: any) => updates.push(update));
  return {runtime, updates};
}
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {resolve = res; reject = rej;});
  return {promise, resolve, reject};
}
function prepareStub(runtime: any, sourceUse?: unknown) {
  return jest.spyOn(runtime, 'prepareAnalysisContext').mockImplementation(async (...args: any[]) => ({
    systemPrompt: 'test system prompt', tools: [], allowedTools: [],
    sessionContext: args[4].sessionContext, previousTurns: args[4].previousTurns,
    hypotheses: [], sessionMapKey: args[4].analysisRunSpec.identity.sessionMapKey, sourceUse,
  }));
}
function responseDone(text: string, status = 'completed') {
  return {type: 'raw_model_stream_event', data: {type: 'response_done', response: {
    output: [{type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]}],
    providerData: {status, ...(status === 'incomplete' ? {incomplete_details: {reason: 'max_output_tokens'}} : {})},
  }}};
}
function sdkStream(text: string, {status = 'completed', nativeText = text, id = 'response-current', events = [] as any[]} = {}) {
  return {currentTurn: 1, finalOutput: text, history: [{role: 'assistant', content: text}], lastResponseId: id,
    state: {}, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'response_started'}};
      yield* events;
      yield responseDone(nativeText, status);
    }};
}
function mockRun(stream: unknown = sdkStream('回答已完成')) {
  return jest.spyOn(Runner.prototype as any, 'run').mockResolvedValue(stream);
}
function phase(id: string, status: PlanPhase['status']): PlanPhase {
  return {id, name: `Phase ${id}`, goal: `Goal ${id}`, expectedTools: ['invoke_skill'], status,
    ...(['completed', 'skipped'].includes(status) ? {summary: `Evidence summary for ${id}`} : {})};
}
function plan(phases: PlanPhase[]): AnalysisPlanV3 {
  return {phases, successCriteria: 'Evidence is sufficient', submittedAt: Date.now(), toolCallLog: []};
}
function streamContext(sessionId: string, quickMode: boolean) {
  return {sessionId, quickMode, answerStreamFilter: __testing.createOpenAiReasoningFilterState(),
    toolInputsByTaskId: new Map<string, {toolName: string; args: Record<string, unknown>}>()};
}

describe('OpenAI typed intent integration', () => {
  it.each(['fast', 'full', 'auto'] as const)('classifies %s once and keeps bounded answers independent of report shape', async analysisMode => {
    const runtime = createOpenAiRuntimeForTest();
    const prepare = prepareStub(runtime);
    const answer = 'provider error 是本次日志中的字段值，当前回答没有标题或句号';
    const run = mockRun(sdkStream(answer));
    const result = await runtime.analyze('任意不参与控制流的问法', `typed-${analysisMode}`, 'trace', {analysisMode, providerId: null});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][4]).toMatchObject({policy: {onDemandContext: true, allowAutomaticPrefetch: false, requiresReport: false}, turnIntent: decision});
    expect(run).toHaveBeenCalledTimes(1);
    expect((run.mock.calls[0][0] as any).model).toBe(analysisMode === 'full' ? 'pinned-primary' : 'pinned-light');
    expect(run.mock.calls[0][2]).toMatchObject({maxTurns: analysisMode === 'full' ? 3 : 2});
    expect(result.conclusion).toBe(answer);
    expect(result.completion).toMatchObject({status: 'completed', sdkFinishReason: 'completed', conclusionFingerprint: analysisDeliveryFingerprint(answer)});
    expect(result.partial).toBeUndefined();
  });
  it('uses the configured primary after malformed light output without widening automatic evidence', async () => {
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({status: 'ok', text: 'not a decision'});
    const runtime = createOpenAiRuntimeForTest();
    const prepare = prepareStub(runtime); const run = mockRun();
    const result = await runtime.analyze('query', 'malformed', 'trace', {analysisMode: 'auto', providerId: null});
    expect(result.turnIntent).toMatchObject({status: 'unavailable', unavailableReason: 'invalid_response'});
    expect(prepare.mock.calls[0][4]).toMatchObject({policy: {budgetMode: 'quick', onDemandContext: true, allowAutomaticPrefetch: false}});
    expect((run.mock.calls[0][0] as any).model).toBe('pinned-primary');
    expect(run.mock.calls[0][2]).toMatchObject({maxTurns: 2});
    expect(result.quickRun.modeDecision).toBe('ai_unavailable');
  });
  it('passes the pinned provider auth and protocol to native classification', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    await runtime.analyze('query', 'pin', 'trace', {analysisMode: 'full', providerId: null});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({protocol: 'responses', baseURL: 'https://provider.invalid/v1', apiKey: 'test-only', lightModel: 'pinned-light'}),
      signal: expect.any(AbortSignal),
    }));
  });
  it('keeps reference and RAG capabilities in explicit fast mode without automatic preflight', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, taskKind: 'comparison'});
    const prompt = jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const focus = jest.spyOn(focusDetector, 'detectFocusApps');
    const run = mockRun();
    const result = await runtime.analyze('compare selected facts', 'fast-pair', 'current', {
      analysisMode: 'fast', providerId: null, referenceTraceId: 'reference', knowledgeSourceIds: ['kb-a'],
    });
    expect(result.quickRun.requestedMode).toBe('fast');
    expect(query).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(mcp.mock.calls[0][0]).toMatchObject({referenceTraceId: 'reference', knowledgeSourceIds: ['kb-a'], allowNewEvidence: true,
      comparisonContext: {referenceTraceId: 'reference', capabilityProbeStatus: 'not_checked'}});
    expect(prompt.mock.calls[0][0]).toMatchObject({turnIntent: {taskKind: 'comparison'}, onDemandContext: true,
      comparison: {referenceTraceId: 'reference', capabilityProbeStatus: 'not_checked'}});
    const toolNames = (run.mock.calls[0][0] as any).tools.map((tool: any) => tool.name);
    expect(toolNames).toContain('fetch_artifact');
    expect(toolNames).toContain('execute_sql');
    expect(toolNames).toEqual((mcp.mock.results[0].value as any).toolDefinitions.map((tool: any) => tool.name));
  });
  it('preserves existing-artifact access while existing_only forbids all automatic collection', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, evidenceAccess: 'existing_only'});
    jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer'); const run = mockRun();
    await runtime.analyze('use prior facts', 'existing', 'trace', {analysisMode: 'full', providerId: null, referenceTraceId: 'reference'});
    expect(query).not.toHaveBeenCalled();
    expect(mcp.mock.calls[0][0]).toMatchObject({allowNewEvidence: false, analysisPlan: {current: null}});
    const names = (run.mock.calls[0][0] as any).tools.map((tool: any) => tool.name);
    expect(names).toContain('fetch_artifact'); expect(names).not.toContain('execute_sql');
    expect(names).toEqual((mcp.mock.results[0].value as any).toolDefinitions.map((tool: any) => tool.name));
  });
  it('does not prefetch without an attached trace even for a scene-wide Conversation intent', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    classify({...decision, taskKind: 'investigation', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report'});
    jest.spyOn(systemPrompt, 'buildSystemPrompt').mockReturnValue('typed prompt');
    const mcp = jest.spyOn(mcpModule, 'createClaudeMcpServer');
    const focus = jest.spyOn(focusDetector, 'detectFocusApps');
    const architecture = jest.spyOn(runtime, 'detectArchitecture');
    const vendor = jest.spyOn(runtime, 'detectVendor');
    const completeness = jest.spyOn(runtime, 'detectCompleteness');
    const run = mockRun();
    const result = await runtime.analyze('question without trace', 'no-trace-conversation', 'no-trace', {
      assistantSurface: 'conversation', conversationTraceAttached: false, analysisMode: 'full', providerId: null,
    });
    expect(query).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
    expect(architecture).not.toHaveBeenCalled(); expect(vendor).not.toHaveBeenCalled(); expect(completeness).not.toHaveBeenCalled();
    expect(mcp.mock.calls[0][0]).toMatchObject({conversationTraceAttached: false, allowNewEvidence: true});
    expect(run).toHaveBeenCalledTimes(1); expect(result.completion.status).toBe('completed');
  });
  it('does not let native success from another body certify the accepted final candidate', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('current answer', {nativeText: 'old answer'}));
    const result = await runtime.analyze('query', 'mismatch', 'trace', {providerId: null});
    expect(result.completion).toMatchObject({status: 'unknown', conclusionFingerprint: analysisDeliveryFingerprint('current answer')});
    expect(result.partial).toBe(true);
  });
  it('uses native incomplete output even when the body has every report heading', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('## Final Report\n## Evidence\n## Conclusion', {status: 'incomplete'}));
    const result = await runtime.analyze('query', 'native-incomplete', 'trace', {providerId: null});
    expect(result.completion).toMatchObject({status: 'incomplete', reason: 'output_limit'});
    expect(result.partial).toBe(true);
  });
  it('does not freeze draft evidence diagnostics before shared finalization', async () => {
    const contract = {schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer', conclusions: [], clusters: [], evidenceChain: [],
      claims: [{id: 'count-claim', text: 'The observed count is 7', kind: 'numeric', references: [{
        evidenceRefId: 'ev_count', rowIndex: 0, column: 'count', value: 7,
      }]}], uncertainties: [], nextSteps: []};
    const body = JSON.stringify(contract);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(body));
    jest.spyOn(verifier, 'verifyConclusion').mockResolvedValue({passed: false, durationMs: 1,
      heuristicIssues: [{type: 'missing_evidence', severity: 'error', message: 'Contract extraction is pending'}]});
    const result = await runtime.analyze('query', 'draft-diagnostic', 'trace', {providerId: null});
    expect(result.completion.status).toBe('completed');
    expect(result.partial).toBeUndefined(); expect(result.terminationReason).toBeUndefined();
    expect(result.conclusion).toBe(body);
    expect(result.claimVerificationResult).toBeUndefined();
    expect(result.deliveryAssurance?.claims).not.toBe('passed');
    const context = finalization.takeFinalizationContext(result);
    if (context) finalizationContexts.push(context);
    expect(context?.deliveryContext.entry).toBe('runtime_draft');
    expect(context?.hasSemanticTransport).toBe(true);
    // Actual evidence and semantic assurance belong to the shared finalization suite.
  });
  it('binds each accepted turn to its own attempt and current content', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockResolvedValueOnce(sdkStream('first')).mockResolvedValueOnce(sdkStream('second'));
    const first = await runtime.analyze('first request', 'multi-turn', 'trace', {providerId: null, runId: 'run-1'});
    const second = await runtime.analyze('follow-up', 'multi-turn', 'trace', {providerId: null, runId: 'run-2'});
    expect(first.completion.runId).toBe('run-1'); expect(second.completion.runId).toBe('run-2');
    expect(first.completion.attemptId).not.toBe(second.completion.attemptId);
    expect(second.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint('second'));
  });
});

describe('OpenAI native Chat completion boundary', () => {
  it.each(['stop', 'length'] as const)('retains native %s through the actual Agents SDK stream', async finishReason => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions'});
    const payloads = [
      {id: 'chat-current', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {role: 'assistant', content: 'protocol body'}, finish_reason: null}]},
      {id: 'chat-current', object: 'chat.completion.chunk', created: 1, model: 'pinned-light', choices: [{index: 0, delta: {}, finish_reason: finishReason}]},
    ];
    const wire = payloads.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
    const nativeFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wire, {headers: {'content-type': 'text/event-stream'}}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const result = await runtime.analyze('query', `chat-${finishReason}`, 'trace', {providerId: null});
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(result.conclusion).toBe('protocol body');
    expect(result.completion).toMatchObject({status: finishReason === 'stop' ? 'completed' : 'incomplete', sdkFinishReason: finishReason});
    expect(result.completion.reason).toBe(finishReason === 'length' ? 'output_limit' : undefined);
  });
  it.each([
    {name: 'unclosed EOF terminal frame', ending: 'eof'},
    {name: 'content after finish', ending: 'content'},
    {name: 'refusal after finish', ending: 'refusal'},
    {name: 'tool call after finish', ending: 'tool'},
    {name: 'different response ID in the same HTTP response', ending: 'changed_id'},
    {name: 'reused response ID around an intervening response', ending: 'reused_id'},
  ])('rejects $name through the actual Agents SDK stream', async ({ending}) => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), protocol: 'chat_completions'});
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, id = 'chat-current') => ({
      id, object: 'chat.completion.chunk', created: 1, model: 'pinned-light',
      choices: [{index: 0, delta, finish_reason: finish}],
    });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    let wire = frame(chunk({role: 'assistant', content: 'protocol body'}));
    if (ending === 'eof') {
      // The SDK never receives this unfinished event, despite valid JSON in the bytes.
      wire += `data: ${JSON.stringify(chunk({}, 'stop'))}`;
    } else if (ending === 'changed_id') {
      wire += frame(chunk({}, 'stop', 'chat-other'));
    } else if (ending === 'reused_id') {
      wire += frame(chunk({content: 'intervening'}, null, 'chat-other')) + frame(chunk({}, 'stop'));
    } else {
      wire += frame(chunk({}, 'stop'));
      const delta = ending === 'content' ? {content: 'new content'} : ending === 'refusal'
        ? {refusal: 'new refusal'}
        : {tool_calls: [{index: 0, id: 'late-call', type: 'function', function: {name: 'unregistered_tool', arguments: '{}'}}]};
      wire += frame(chunk(delta));
    }
    if (ending !== 'eof') wire += 'data: [DONE]\n\n';
    const nativeFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wire, {headers: {'content-type': 'text/event-stream'}}));
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const result = await runtime.analyze('query', `invalid-chat-${ending}`, 'trace', {providerId: null});
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(result.completion.status).not.toBe('completed');
    expect(result.partial).toBe(true);
    if (ending === 'eof') {
      expect(result.conclusion).toBe('protocol body');
      expect(result.completion.sdkFinishReason).toBeUndefined();
    }
  });
  it('forwards SSE bytes unchanged while parsing split protocol frames', async () => {
    const wire = 'data: {"id":"chat-wire","choices":[{"index":0,"finish_reason":"length","delta":{}}]}\r\n\r\ndata: [DONE]\n\n';
    const encoder = new TextEncoder(); let terminal: any;
    const wrapped = __testing.createOpenAiTerminalFetch(jest.fn<typeof fetch>(async () => new Response(new ReadableStream({start(controller) {
      for (const piece of [wire.slice(0, 17), wire.slice(17, 49), wire.slice(49)]) controller.enqueue(encoder.encode(piece)); controller.close();
    }}), {headers: {'content-type': 'text/event-stream'}})), value => {terminal = value;});
    const response = await wrapped('https://provider.invalid/v1/chat/completions');
    expect(await response.text()).toBe(wire); expect(terminal).toEqual({responseId: 'chat-wire', finishReason: 'length'});
  });
});

describe('OpenAI cancellation and bounded recovery', () => {
  it('cancels during classification before context preparation or provider execution', async () => {
    const entered = createDeferred<void>();
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockImplementation(input => new Promise((_resolve, reject) => {
      entered.resolve(); input.signal!.addEventListener('abort', () => reject(input.signal!.reason), {once: true});
    }));
    const runtime = createOpenAiRuntimeForTest(); const prepare = prepareStub(runtime); const run = mockRun();
    const pending = runtime.analyze('query', 'cancel-classify', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession('cancel-classify'); await rejected;
    expect(prepare).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });
  it('ignores late tool results from an already cancelled stream', async () => {
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun({currentTurn: 1, finalOutput: 'late', history: [], completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      entered.resolve(); await release.promise;
      yield {type: 'run_item_stream_event', name: 'tool_output', item: {rawItem: {callId: 'late', output: '{"success":true}'}}};
    }});
    const pending = runtime.analyze('query', 'cancel-late', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession('cancel-late'); release.resolve(); await rejected;
    expect(updates.filter(update => update.type === 'agent_response')).toHaveLength(0);
  });
  it('rejects same-session overlap while allowing different sessions to proceed', async () => {
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockImplementationOnce(async () => {entered.resolve(); await release.promise; return sdkStream('first');});
    const first = runtime.analyze('query', 'overlap', 'trace', {providerId: null}); await entered.promise;
    await expect(runtime.analyze('other', 'overlap', 'other', {providerId: null})).rejects.toThrow();
    expect((await runtime.analyze('parallel', 'independent', 'trace', {providerId: null})).success).toBe(true);
    release.resolve(); expect((await first).success).toBe(true);
  });
  it('cancels immediately even when provider creation ignores its abort signal', async () => {
    const entered = createDeferred<void>();
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun().mockImplementation(() => {entered.resolve(); return new Promise(() => undefined);});
    const pending = runtime.analyze('query', 'cancel-stalled-provider', 'trace', {providerId: null});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise;
    runtime.abortSession('cancel-stalled-provider'); await rejected;
  });
  it('records the actual native turn cap without adding fixed plan or report loops', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun().mockRejectedValue(new MaxTurnsExceededError('native turn cap'));
    const result = await runtime.analyze('query', 'native-turn-cap', 'trace', {analysisMode: 'fast', providerId: null});
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({partial: true, rounds: 2, terminationReason: 'max_turns', completion: {status: 'incomplete', reason: 'turn_limit'}});
  });
  it('returns a candidate-bound timeout without re-entering the provider', async () => {
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(), streamIdleTimeoutMs: 10});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    const run = mockRun(); run.mockImplementation(() => new Promise(() => undefined));
    const result = await runtime.analyze('query', 'timeout', 'trace', {providerId: null});
    expect(run).toHaveBeenCalledTimes(1); expect(result.completion).toMatchObject({status: 'incomplete', reason: 'timeout'});
    expect(result.conclusion).toBe(''); expect(result.partial).toBe(true);
  });
  it('retries a typed missing previous response once without classifying or preparing again', async () => {
    const runtime = createOpenAiRuntimeForTest(); const prepare = prepareStub(runtime);
    runtime.sessionMap.set('retry', {lastResponseId: 'expired', history: [{role: 'user', content: 'prior'}], updatedAt: Date.now()});
    const run = mockRun(); run.mockRejectedValueOnce({status: 404, code: 'response_not_found', param: 'previous_response_id'}).mockResolvedValueOnce(sdkStream('recovered'));
    const result = await runtime.analyze('query', 'retry', 'trace', {providerId: null});
    expect(result.completion.status).toBe('completed'); expect(run).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(1); expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2]).toMatchObject({previousResponseId: 'expired'});
    expect(run.mock.calls[1][2]).not.toHaveProperty('previousResponseId');
  });
  it('does not treat prose describing a missing response as a retry authorization', () => {
    expect(__testing.isMissingOpenAIPreviousResponseError(new Error('No response found with id old'), 'old')).toBe(false);
    expect(__testing.isMissingOpenAIPreviousResponseError({status: 404, param: 'previous_response_id'}, 'old')).toBe(true);
  });
  it('does not commit when cancellation arrives while provider close is pending', async () => {
    const scope = new __testing.RuntimeAnalysisAbortScope(); const close = createDeferred<void>(); const commit = jest.fn();
    const pending = __testing.commitAfterProviderClose(() => close.promise, scope, commit);
    const rejected = expect(pending).rejects.toThrow(); scope.abort(); close.resolve(); await rejected;
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('OpenAI shared tool receipt and private projection', () => {
  it('records OpenAI tool calls into the active analysis plan', () => {
    const { runtime } = createRuntimeWithUpdates();
    const p1 = phase('p1', 'in_progress');
    p1.expectedCalls = [{ tool: 'invoke_skill', skillId: 'scrolling_analysis' }];
    runtime.sessionPlans.set('s-tools', {
      current: plan([p1]),
      history: [],
    });
    const context = streamContext('s-tools', false);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {
        rawItem: {
          callId: 'call-1',
          id: 'item-1',
          name: 'invoke_skill',
          arguments: JSON.stringify({ skillId: 'scrolling_analysis', params: { process_name: 'demo' } }),
        },
      },
    }, 'zh-CN', context);

    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {
        rawItem: {
          callId: 'call-1',
          output: JSON.stringify([{ type: 'text', text: '{"success":true,"planPhaseId":"p1"}' }]),
        },
      },
    }, 'zh-CN', context);

    expect(runtime.sessionPlans.get('s-tools')!.current!.toolCallLog).toContainEqual(expect.objectContaining({
      toolName: 'invoke_skill',
      skillId: 'scrolling_analysis',
      matchedPhaseId: 'p1',
    }));
  });

  it('records and publishes each real tool result ID once while retaining distinct calls', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const p1 = phase('p1', 'in_progress');
    p1.expectedTools = ['execute_sql'];
    runtime.sessionPlans.set('s-dedup', {current: plan([p1]), history: []});
    const onToolCalled = jest.fn();
    const context = {...streamContext('s-dedup', false), processedToolResultIds: new Set<string>(), onToolCalled};
    for (const callId of ['call-a', 'call-b']) {
      const dispatch = {type: 'run_item_stream_event', name: 'tool_called', item: {rawItem: {
        callId, name: 'execute_sql', arguments: '{"sql":"SELECT 1"}',
      }}};
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
      const result = {type: 'run_item_stream_event', name: 'tool_output', item: {rawItem: {
        callId, output: '{"success":true,"planPhaseId":"p1"}',
      }}};
      runtime.handleStreamEvent(result, 'zh-CN', context);
      runtime.handleStreamEvent(result, 'zh-CN', context);
      runtime.handleStreamEvent(dispatch, 'zh-CN', context);
    }
    expect(runtime.sessionPlans.get('s-dedup')?.current?.toolCallLog.map((call: AnalysisPlanV3['toolCallLog'][number]) => call.toolCallId)).toEqual(['call-a', 'call-b']);
    expect(updates.filter(update => update.type === 'agent_response')).toHaveLength(2);
    expect(updates.filter(update => update.type === 'agent_task_dispatched')).toHaveLength(2);
    expect(onToolCalled).toHaveBeenCalledTimes(2);
  });

  it('projects private wiki tool output before emitting it', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    const context = streamContext('s-private-wiki', false);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: {rawItem: {
        callId: 'wiki-call',
        name: 'lookup_blog_knowledge',
        arguments: JSON.stringify({source: 'android_internals_wiki'}),
      }},
    }, 'zh-CN', context);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {rawItem: {
        callId: 'wiki-call',
        output: JSON.stringify({result: {
          query: 'Handler',
          probed: ['android_internals_wiki'],
          retrievedAt: 1,
          legacyPath: false,
          hits: [{
            chunkId: 'wiki-1',
            score: 1,
            metadata: {kind: 'android_internals_wiki', knowledgeSourceId: 'source-a'},
            snippet: 'OPENAI_PRIVATE_WIKI_CANARY',
          }],
        }}),
      }},
    }, 'zh-CN', context);

    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENAI_PRIVATE_WIKI_CANARY');
    expect(serialized).toContain('snippetHash');
  });

  it('records source references before projecting private tool output', () => {
    const { runtime, updates } = createRuntimeWithUpdates();
    const sourcePhase = phase('p-source', 'in_progress');
    sourcePhase.expectedCalls = [{ tool: 'lookup_app_source' }];
    runtime.sessionPlans.set('s-private-source', {
      current: plan([sourcePhase]),
      history: [],
    });
    const context = streamContext('s-private-source', false);
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_called',
      item: { rawItem: {
        callId: 'source-call',
        name: 'lookup_app_source',
        arguments: JSON.stringify({ query: 'StartupHooks' }),
      } },
    }, 'zh-CN', context);
    const rawSourceResult = JSON.stringify({ success: true, result: {
      query: 'StartupHooks',
      hits: [{
        chunkId: 'source-1',
        score: 1,
        metadata: {
          kind: 'app_source',
          codebaseId: 'codebase-a',
          filePath: 'app/src/main/java/com/example/StartupHooks.kt',
          lineRange: { start: 10, end: 20 },
        },
        snippet: 'OPENAI_PRIVATE_SOURCE_CANARY',
      }],
    } });
    runtime.handleStreamEvent({
      type: 'run_item_stream_event',
      name: 'tool_output',
      item: {
        output: { type: 'text', text: rawSourceResult },
        rawItem: {
          callId: 'source-call',
          output: [{ type: 'input_text', text: rawSourceResult }],
        },
      },
    }, 'zh-CN', context);

    const currentPlan = runtime.sessionPlans.get('s-private-source')!.current!;
    expect(currentPlan.toolCallLog)
      .toContainEqual(expect.objectContaining({
        toolName: 'lookup_app_source',
        matchedPhaseId: 'p-source',
        success: true,
        returnedCodeReferences: true,
      }));
    expect(getSourceLookupCodeReferences(currentPlan)).toEqual([{
      chunkId: 'source-1',
      codebaseId: 'codebase-a',
      filePath: 'app/src/main/java/com/example/StartupHooks.kt',
      lineRange: {start: 10, end: 20},
    }]);
    expect(JSON.stringify(currentPlan)).not.toContain('StartupHooks.kt');
    const serialized = JSON.stringify(updates.filter(update => update.type === 'agent_response'));
    expect(serialized).not.toContain('OPENAI_PRIVATE_SOURCE_CANARY');
    expect(serialized).not.toContain('app/src/main/java/com/example/StartupHooks.kt');
    expect(serialized).toContain('snippetHash');
  });

  it('streams current assistant text before an optional plan is submitted', () => {
    const {runtime, updates} = createRuntimeWithUpdates();
    const text = '自然回答无需等待 submit_plan';
    runtime.handleStreamEvent({type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: text}}, 'zh-CN', streamContext('no-plan', false));
    expect(updates.filter(update => update.type === 'answer_token').map(update => update.content.token)).toEqual([text]);
  });
});

describe('OpenAI provisional memory boundary', () => {
  it('does not promote a runtime draft as verified and selects the bucket from semantic scope', () => {
    const runtime = createOpenAiRuntimeForTest();
    jest.mocked(runtime.recordPatternMemory).mockRestore();
    jest.spyOn(patternMemory, 'extractKeyInsights').mockReturnValue(['an observed fact']);
    const quick = jest.spyOn(patternMemory, 'saveQuickPathPattern').mockResolvedValue(undefined);
    const full = jest.spyOn(patternMemory, 'saveAnalysisPattern').mockResolvedValue(undefined);
    const promote = jest.spyOn(patternMemory, 'promoteQuickPatternIfMatching').mockResolvedValue(false);
    const input = {sessionId: 'memory-draft', previousTurnCount: 0, quickMode: false, sceneType: 'general', options: {},
      result: {conclusion: 'body', findings: [{title: 'fact'}], turnIntent: decision}};
    runtime.recordPatternMemory(input);
    expect(quick).toHaveBeenCalledTimes(1); expect(full).not.toHaveBeenCalled();
    runtime.recordPatternMemory({...input, quickMode: true, result: {...input.result,
      turnIntent: {...decision, scope: 'scene_wide', deliverable: 'report'}}});
    expect(full).toHaveBeenCalledTimes(1);
    expect(full.mock.calls[0][5]).toMatchObject({status: 'provisional'});
    expect(promote).not.toHaveBeenCalled();
  });
});

describe('OpenAI source finalization parity', () => {
  it('preserves native provider completion while recording pending source access', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: mcpModule.createClaudeMcpServer, sessionId: 'pending-source'});
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime, fixture.sourceUse); mockRun();
    try {
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', {
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      });
      expect(result).toMatchObject({success: true, sourceUseDecision: {status: 'pending'}, sourceReferences: [],
        completion: {status: 'completed'}});
      expect(result.partial).toBeUndefined();
      expect(result.terminationReason).toBeUndefined();
      expect(result.conclusion).toBe('回答已完成');
      expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    } finally {fixture.cleanup();}
  });
  it('binds the projected candidate and never inherits an earlier turn source ledger', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({createMcpServer: mcpModule.createClaudeMcpServer, sessionId: 'bound-source'});
    const runtime = createOpenAiRuntimeForTest();
    try {
      const {decision: sourceDecision} = await fixture.executeProviderSourceLookup();
      const prepare = prepareStub(runtime, fixture.sourceUse);
      const run = mockRun(sdkStream(SOURCE_FINALIZATION_RAW_SOURCE));
      const result = await runtime.analyze('source context', fixture.sessionId, 'trace', {
        analysisMode: 'fast', providerId: null, codeAwareMode: 'provider_send', codebaseIds: [fixture.codebaseId],
      });
      expect(result.sourceUseDecision).toEqual(sourceDecision); expect(result.sourceReferences).toEqual(sourceDecision.references);
      expect(JSON.stringify(result)).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
      prepare.mockRestore(); prepareStub(runtime); run.mockResolvedValue(sdkStream('public second answer'));
      const next = await runtime.analyze('another request', fixture.sessionId, 'trace', {analysisMode: 'fast', providerId: null, codeAwareMode: 'off'});
      expect(next.sourceUseDecision).toBeUndefined(); expect(next.sourceReferences).toBeUndefined();
      expect(next.completion.candidateRef).not.toBe(result.completion.candidateRef);
    } finally {fixture.cleanup();}
  });
});

describe('OpenAI candidate-bound privacy projection', () => {
  it.each(['zh-CN', 'en'] as const)('consumes redacted receipts and the returned context in %s', async outputLanguage => {
    const sessionId = `redacted-candidate-${outputLanguage}`; privacySessions.push(sessionId);
    const nativeBody = outputLanguage === 'en' ? 'Before PRIVATE_CANARY after' : '前文 PRIVATE_CANARY 后文';
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(nativeBody));
    const projected = jest.spyOn(sourceProjection, 'finalizeSourceAwareAnalysisResultWithProjection');
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({outputOrigin: 'sdk_final', completion: {status: 'completed'}});
    expect(result.partial).toBeUndefined();
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    const originalContext = projected.mock.calls[0][2]?.context;
    expect(result.completion.candidateRef).not.toBe(originalContext?.entry === 'runtime_draft'
      ? originalContext.acceptedCandidate?.candidateRef : undefined);
    expect(verified.mock.calls[0][2]?.deliveryContext).toBe(outcome.deliveryContext);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(result)).not.toContain(outcome.conclusionProjection.inputFingerprint);
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
  });
  it.each([
    {outputLanguage: 'zh-CN' as const, nativeBody: '原生回答'},
    {outputLanguage: 'en' as const, nativeBody: 'Native answer'},
    {outputLanguage: 'en' as const, nativeBody: ''},
  ])('keeps whole replacement separate from native completion for $outputLanguage / $nativeBody', async ({outputLanguage, nativeBody}) => {
    const sessionId = `replaced-candidate-${outputLanguage}-${nativeBody.length}`; privacySessions.push(sessionId);
    revokeCodeAwareOutputGuards(sessionId);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream(nativeBody));
    const projected = jest.spyOn(sourceProjection, 'finalizeSourceAwareAnalysisResultWithProjection');
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, outputLanguage, knowledgeSourceIds: ['private-source']});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('replaced');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'runtime_fallback', completion: {status: 'unknown'}, quickRun: {stopReason: 'partial'}});
    expect(verified.mock.calls[0][2]?.deliveryContext).toBe(outcome.deliveryContext);
    expect(result.completion.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
    if (!nativeBody) {
      const context = projected.mock.calls[0][2]?.context;
      expect(context?.entry === 'runtime_draft' && context.completion?.status).toBe('unknown');
      expect(result.confidence).toBe(0);
    }
  });
  it('keeps literal placeholder text as model content when no replacement occurred', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('[PRIVATE_OUTPUT_SUPPRESSED]'));
    const projected = jest.spyOn(sourceProjection, 'finalizeSourceAwareAnalysisResultWithProjection');
    const result = await runtime.analyze('query', 'literal-placeholder', 'trace', {providerId: null});
    const outcome = projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeSourceAwareAnalysisResultWithProjection>;
    expect(outcome.conclusionProjection.disposition).toBe('preserved');
    expect(result).toMatchObject({success: true, outputOrigin: 'sdk_final', completion: {status: 'completed'}});
    expect(result.partial).toBeUndefined();
  });
  it.each(['completed', 'incomplete'] as const)('redaction transfers native %s and does not restore an earlier context', async status => {
    const sessionId = `projection-status-${status}`; privacySessions.push(sessionId);
    registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun(sdkStream('Before PRIVATE_CANARY after', {status}));
    const verified = jest.spyOn(verifier, 'verifyConclusion');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect(result.completion.status).toBe(status);
    const context = verified.mock.calls[0][2]?.deliveryContext;
    expect(context?.entry === 'runtime_draft' && context.completion).toEqual(result.completion);
    expect(context?.entry === 'runtime_draft' && context.acceptedCandidate?.conclusionFingerprint).toBe(analysisDeliveryFingerprint(result.conclusion));
  });
  it('projects a failed stream candidate and its error without upgrading native failure', async () => {
    const sessionId = 'projection-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime);
    mockRun({currentTurn: 1, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      throw new Error('PRIVATE_CANARY provider failure');
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeSourceAwareAnalysisResultWithProjection');
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect((projected.mock.results[0].value as ReturnType<typeof sourceProjection.finalizeSourceAwareAnalysisResultWithProjection>).conclusionProjection.disposition).toBe('redacted');
    expect(result).toMatchObject({success: false, partial: true, outputOrigin: 'assistant_stream', completion: {status: 'failed', reason: 'provider_error'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  });
  it('projects setup failure diagnostics before emitting them without inventing model output', async () => {
    const sessionId = 'projection-setup-failed'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const {runtime, updates} = createRuntimeWithUpdates();
    prepareStub(runtime).mockRejectedValue(new Error('PRIVATE_CANARY setup failed'));
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    expect(result).toMatchObject({success: false, partial: true, conclusion: '', outputOrigin: 'runtime_fallback',
      completion: {status: 'failed', reason: 'provider_error'}});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
  });
  it('cannot transfer a receipt issued for another native body', () => {
    privacySessions.push('receipt-mismatch'); registerCodeAwareCanary('receipt-mismatch', 'PRIVATE_CANARY');
    const projection = createCodeAwareStreamingTextProjection('receipt-mismatch', 'unrelated');
    const receipt = projection.projectCompleteWithReceipt('another PRIVATE_CANARY body');
    const projected = __testing.finalizeOpenAiCandidate({
      result: {sessionId: 'receipt-mismatch', success: true, findings: [], hypotheses: [], conclusion: 'current body', confidence: 0.5, rounds: 1, totalDurationMs: 1},
      runId: 'run-current', attemptId: 'attempt-current', finish: {status: 'completed'}, outputOrigin: 'sdk_final',
      projection: {...projection, projectCompleteWithReceipt: () => receipt},
    });
    expect(projected.result.completion).toBeUndefined();
    expect(projected.deliveryContext.entry === 'runtime_draft' && projected.deliveryContext.completion).toBeUndefined();
  });
  it('cancellation never finalizes or publishes an unprojected stream body', async () => {
    const sessionId = 'projection-cancelled'; privacySessions.push(sessionId); registerCodeAwareCanary(sessionId, 'PRIVATE_CANARY');
    const entered = createDeferred<void>(); const release = createDeferred<void>();
    const {runtime, updates} = createRuntimeWithUpdates(); prepareStub(runtime);
    mockRun({currentTurn: 1, completed: Promise.resolve(), async *[Symbol.asyncIterator]() {
      yield {type: 'raw_model_stream_event', data: {type: 'output_text_delta', delta: 'Before PRIVATE_CANARY after'}};
      entered.resolve(); await release.promise;
    }});
    const projected = jest.spyOn(sourceProjection, 'finalizeSourceAwareAnalysisResultWithProjection');
    const pending = runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    const rejected = expect(pending).rejects.toThrow(); await entered.promise; runtime.abortSession(sessionId); release.resolve(); await rejected;
    expect(projected).not.toHaveBeenCalled();
    expect(updates.filter(update => update.type === 'conclusion')).toHaveLength(0);
    expect(JSON.stringify(updates)).not.toContain('PRIVATE_CANARY');
    expect(runtime.sessionMap.has(sessionId)).toBe(false);
  });
});

describe('OpenAI finalization handoff', () => {
  function takeContext(result: any): finalization.RuntimeFinalizationContext {
    const context = finalization.takeFinalizationContext(result);
    if (!context) throw new Error('Missing runtime finalization context');
    finalizationContexts.push(context);
    return context;
  }
  const transportInput = () => ({prompt: 'semantic review input', systemPrompt: 'semantic review protocol',
    signal: new AbortController().signal, deadlineMs: Date.now() + 60_000, outputByteLimit: 128 * 1024});

  it('attaches once to the returned object after the SDK provider closes', async () => {
    const order: string[] = [];
    jest.spyOn(OpenAIProvider.prototype, 'close').mockImplementation(async () => {order.push('close');});
    const originalAttach = finalization.attachFinalizationContext;
    const attach = jest.spyOn(finalization, 'attachFinalizationContext').mockImplementation((result, context) => {
      order.push('attach'); originalAttach(result, context);
    });
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const options = {providerId: null, runId: 'current-run', analysisContextFingerprint: 'openai-auth-pin'};
    const result = await runtime.analyze('query', 'finalization-once', 'trace', options);
    expect(order).toEqual(['close', 'attach']); expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0][0]).toBe(result);
    expect(finalization.takeFinalizationContext({...result})).toBeUndefined();
    const context = takeContext(result);
    options.analysisContextFingerprint = 'later-auth-context';
    const providerQuery = context.getProviderQuery(new AbortController().signal);
    expect(providerQuery).toEqual({text: 'query', analysisContextFingerprint: 'openai-auth-pin'});
    expect(Object.isFrozen(providerQuery)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('"providerQuery"');
    expect(finalization.takeFinalizationContext(result)).toBeUndefined();
    expect(context.runId).toBe('current-run');
    expect(context.deliveryContext.entry === 'runtime_draft' && context.deliveryContext.completion).toEqual(result.completion);
    expect(JSON.stringify(result)).not.toContain('test-only');
    expect(result).not.toHaveProperty('dispatchText'); expect(result).not.toHaveProperty('strategyRegistry');
  });
  it('reviews through a fresh no-tools transport pinned to the original primary after provider close', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-primary', 'trace', {providerId: null, analysisMode: 'fast'});
    const context = takeContext(result);
    jest.mocked(configModule.loadOpenAIConfig).mockReturnValue({...createOpenAiConfigForTest(),
      model: 'later-primary', apiKey: 'later-key', baseURL: 'https://later.invalid/v1'});
    jest.mocked(intentTransport.runOpenAiIntentTransport).mockResolvedValue({status: 'ok', text: 'semantic review output'});
    const input = transportInput();
    const reviewed = await context.dispatchText(input);
    expect(reviewed).toMatchObject({status: 'ok', text: 'semantic review output'});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(2);
    const call = jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[1][0];
    expect(call).toMatchObject({config: {lightModel: 'pinned-primary', apiKey: 'test-only',
      baseURL: 'https://provider.invalid/v1', protocol: 'responses'},
      maxOutputTokens: finalization.FINALIZATION_MAX_OUTPUT_TOKENS});
    expect(call.deadlineMs).toBeLessThanOrEqual(context.deadlineMs);
    expect(call.signal).not.toBe(jest.mocked(intentTransport.runOpenAiIntentTransport).mock.calls[0][0].signal);
    expect(call.signal?.aborted).toBe(false);
  });
  it('does not restart the original run deadline for semantic review', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-deadline', 'trace', {providerId: null});
    const context = takeContext(result);
    jest.spyOn(Date, 'now').mockReturnValue(context.deadlineMs + 1);
    expect(await context.dispatchText(transportInput())).toEqual({status: 'unavailable', reason: 'timeout'});
    expect(intentTransport.runOpenAiIntentTransport).toHaveBeenCalledTimes(1);
  });
  it('reads the captured row beyond the display preview and denies another trace without querying', async () => {
    const query = jest.fn(async () => ({columns: [], rows: [], durationMs: 0}));
    const runtime = createOpenAiRuntimeForTest({query, getTrace: jest.fn()} as unknown as TraceProcessorService);
    const store = new ArtifactStore();
    const captured = {columns: ['value'], rows: Array.from({length: 601}, (_, value) => [value])};
    const id = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[0]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    store.registerEvidenceCapture(id, captureEvidenceTable(captured), {evidenceRefId: 'ev-native-captured'});
    const foreignId = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[900]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'another-trace', traceSide: 'current'})});
    store.registerEvidenceCapture(foreignId, captureEvidenceTable({columns: ['value'], rows: [[900]]}), {evidenceRefId: 'ev-foreign'});
    runtime.artifactStores.set('finalization-read', store); prepareStub(runtime); mockRun();
    const readView = jest.spyOn(store, 'createEvidenceReadView');
    const result = await runtime.analyze('query', 'finalization-read', 'trace', {
      providerId: null, runId: 'read-run', tenantId: 'tenant', workspaceId: 'workspace', userId: 'user',
      analysisContextFingerprint: 'authorized-context',
    });
    const context = takeContext(result);
    expect(readView.mock.calls[0][0]).toMatchObject({allowedTraces: [{traceId: 'trace', traceSide: 'current'}], ownerKey: expect.any(String)});
    expect(readView.mock.calls[0][0].ownerKey.length).toBeGreaterThan(0);
    const refs = await context.resolveReferences([
      {key: 'full-row', reference: {evidenceRefId: 'ev-native-captured', rowIndex: 600, column: 'value'}, requiredColumns: ['value']},
      {key: 'foreign', reference: {evidenceRefId: 'ev-foreign', rowIndex: 0, column: 'value'}, requiredColumns: ['value']},
    ], new AbortController().signal);
    expect(refs[0]).toMatchObject({status: 'resolved', originalRowIndex: 600, row: {value: 600}});
    expect(refs[1]).toMatchObject({status: 'denied'}); expect(query).not.toHaveBeenCalled();
    const futureId = store.store({skillId: 'execute_sql', data: {columns: ['value'], rows: [[999]]},
      traceProvenance: buildTraceProcessorQueryProvenance({traceId: 'trace', traceSide: 'current'})});
    store.registerEvidenceCapture(futureId, captureEvidenceTable({columns: ['value'], rows: [[999]]}), {evidenceRefId: 'ev-next-run'});
    expect((await context.resolveReferences([{key: 'future', reference: {evidenceRefId: 'ev-next-run', rowIndex: 0}, requiredColumns: ['value']}], new AbortController().signal))[0])
      .toMatchObject({status: 'missing'});
    store.clear();
    expect((await context.resolveReferences([{key: 'evicted', reference: {evidenceRefId: 'ev-native-captured', rowIndex: 600}, requiredColumns: ['value']}], new AbortController().signal))[0]).toMatchObject({status: 'missing'});
  });
  it('does not invent an evidence reader when the runtime has no artifact store', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', 'finalization-no-store', 'trace', {providerId: null});
    const context = takeContext(result);
    expect(await context.resolveReferences([{key: 'missing', reference: {evidenceRefId: 'anything'}, requiredColumns: []}], new AbortController().signal))
      .toEqual([{key: 'missing', status: 'missing', reason: 'capture_unavailable'}]);
  });
  it('does not grant a Conversation placeholder trace to the evidence reader', async () => {
    const runtime = createOpenAiRuntimeForTest(); const store = new ArtifactStore();
    runtime.artifactStores.set('finalization-no-trace', store); prepareStub(runtime); mockRun();
    const view = jest.spyOn(store, 'createEvidenceReadView');
    const result = await runtime.analyze('query', 'finalization-no-trace', 'conversation-placeholder', {
      providerId: null, assistantSurface: 'conversation', conversationTraceAttached: false,
    });
    const context = takeContext(result);
    expect(context.traceIdentity.currentTraceId).toBeUndefined();
    expect(view.mock.calls[0][0].allowedTraces).toEqual([]);
  });
  it('attaches the privacy-returned context rather than the replaced native one', async () => {
    const sessionId = 'finalization-replaced'; privacySessions.push(sessionId); revokeCodeAwareOutputGuards(sessionId);
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime); mockRun();
    const result = await runtime.analyze('query', sessionId, 'trace', {providerId: null, knowledgeSourceIds: ['private-source']});
    const context = takeContext(result);
    expect(context.deliveryContext).toMatchObject({outputOrigin: 'runtime_fallback', completion: {status: 'unknown',
      conclusionFingerprint: analysisDeliveryFingerprint(result.conclusion)}});
    expect(result.completion).toEqual(context.deliveryContext.entry === 'runtime_draft' && context.deliveryContext.completion);
  });
  it('does not attach a fabricated finalization context for setup failure', async () => {
    const runtime = createOpenAiRuntimeForTest(); prepareStub(runtime).mockRejectedValue(new Error('setup failure'));
    const result = await runtime.analyze('query', 'finalization-setup-failure', 'trace', {providerId: null});
    expect(result.success).toBe(false); expect(finalization.takeFinalizationContext(result)).toBeUndefined();
  });
});

describe('OpenAI SDK token and storage contracts', () => {
  it('disables provider response storage for private model calls', () => {
    const config = createOpenAiConfigForTest();
    expect(__testing.buildOpenAIModelSettings(config, config.model, false)).toEqual(expect.objectContaining({
      store: false,
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
    }));
    expect(__testing.buildOpenAIModelSettings(config, config.model, true).store).toBe(true);
  });

  it('uses max_completion_tokens for GPT-5.6 Chat Completions without emitting maxTokens', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'gpt-5.6-sol',
    };
    const settings = __testing.buildOpenAIModelSettings(config, config.model, false);

    expect(settings).toEqual({
      providerData: { max_completion_tokens: config.maxOutputTokens },
      parallelToolCalls: false,
      store: false,
    });
    expect(settings).not.toHaveProperty('maxTokens');
  });

  it('keeps maxTokens for GPT-5.6 on the Responses protocol', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      model: 'gpt-5.6-sol',
    };

    expect(__testing.buildOpenAIModelSettings(config, config.model, true)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: true,
    });
  });

  it('serializes the GPT-5.6 token limit through the Agents SDK request boundary', async () => {
    const createCompletion = jest.fn(async (_body: unknown, _options?: unknown) => ({
      id: 'chatcmpl-test',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'ok' },
      }],
      created: 0,
      model: 'gpt-5.6-sol',
      object: 'chat.completion',
    }));
    const model = new OpenAIChatCompletionsModel({
      chat: { completions: { create: createCompletion } },
    } as any, 'gpt-5.6-sol');
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'gpt-5.6-sol',
    };

    await withTrace('OpenAIRuntime token serialization test', async () => {
      await model.getResponse({
        input: [{ role: 'user', content: 'hi' }],
        systemInstructions: 'answer briefly',
        modelSettings: __testing.buildOpenAIModelSettings(config, config.model, false),
        tools: [],
        handoffs: [],
        outputType: 'text',
        tracing: false,
      } as any);
    });

    const requestBody = createCompletion.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(requestBody.max_completion_tokens).toBe(config.maxOutputTokens);
    expect(requestBody.max_tokens).toBeUndefined();
    expect(JSON.parse(JSON.stringify(requestBody))).not.toHaveProperty('max_tokens');
  });

  it('keeps maxTokens for legacy Chat Completions models', () => {
    const config = {
      ...createOpenAiConfigForTest(),
      protocol: 'chat_completions' as const,
      model: 'deepseek-v4-pro',
    };

    expect(__testing.buildOpenAIModelSettings(config, config.model, true)).toEqual({
      maxTokens: config.maxOutputTokens,
      parallelToolCalls: false,
      store: true,
    });
  });

 });

describe('OpenAI snapshot compatibility', () => {
  it('does not persist stale OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    runtime.sessionMap.set('s1', {
      history: [{ role: 'user', content: 'previous question' }],
      lastResponseId: 'resp_stale',
      updatedAt: now - (5 * 60 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBeUndefined();
      expect(snapshot.openAILastResponseId).toBeUndefined();
      expect(snapshot.openAIHistory).toBeUndefined();
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
      }));
      expect(snapshot.engineState?.openai.lastResponseId).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    const history = [{ role: 'user', content: 'previous question' }];
    runtime.sessionMap.set('s1', {
      history,
      lastResponseId: 'resp_fresh',
      runState: '{"state":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.sdkSessionId).toBe('resp_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"state":true}');
      expect(snapshot.engineState).toEqual(expect.objectContaining({
        kind: 'openai-agents-sdk',
        provider: {
          providerId: null,
          providerSnapshotHash: null,
        },
        openai: {
          history,
          lastResponseId: 'resp_fresh',
          runState: '{"state":true}',
        },
      }));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('persists fresh comparison OpenAI response mappings into snapshots', () => {
    const now = 1_700_000_000_000;
    const runtime = createOpenAiRuntimeForTest();
    const history = [{ role: 'user', content: 'previous comparison question' }];
    runtime.sessionMap.set('s1:ref:trace-b', {
      history,
      lastResponseId: 'resp_compare_fresh',
      runState: '{"compare":true}',
      updatedAt: now - (30 * 60 * 1000),
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const snapshot = runtime.takeSnapshot('s1', 'trace-1', {
        referenceTraceId: 'trace-b',
        comparisonSource: 'raw_trace_pair',
        conversationSteps: [],
        queryHistory: [],
        conclusionHistory: [],
        agentDialogue: [],
        agentResponses: [],
        dataEnvelopes: [],
        hypotheses: [],
        runSequence: 0,
        conversationOrdinal: 0,
      });

      expect(snapshot.referenceTraceId).toBe('trace-b');
      expect(snapshot.comparisonSource).toBe('raw_trace_pair');
      expect(snapshot.sdkSessionId).toBe('resp_compare_fresh');
      expect(snapshot.openAILastResponseId).toBe('resp_compare_fresh');
      expect(snapshot.openAIHistory).toBe(history);
      expect(snapshot.openAIRunState).toBe('{"compare":true}');
      expect(snapshot.engineState?.kind).toBe('openai-agents-sdk');
      expect(snapshot.engineState?.openai.lastResponseId).toBe('resp_compare_fresh');
    } finally {
      nowSpy.mockRestore();
    }
  });


  it('restores OpenAI response mappings with the snapshot timestamp', () => {
    const runtime = createOpenAiRuntimeForTest();
    const snapshotTimestamp = Date.now() - (5 * 60 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      engineState: {
        kind: 'openai-agents-sdk',
        provider: { providerId: null, providerSnapshotHash: null },
        openai: {
          history: [{ role: 'user', content: 'previous question' }],
          lastResponseId: 'resp_old',
        },
      },
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_old',
      updatedAt: snapshotTimestamp,
    }));
  });

  it('restores comparison OpenAI response mappings under the comparison key', () => {
    const runtime = createOpenAiRuntimeForTest();
    const snapshotTimestamp = Date.now() - (30 * 60 * 1000);

    runtime.restoreFromSnapshot('s1', 'trace-1', {
      version: 1,
      snapshotTimestamp,
      sessionId: 's1',
      traceId: 'trace-1',
      referenceTraceId: 'trace-b',
      comparisonSource: 'raw_trace_pair',
      conversationSteps: [],
      queryHistory: [],
      conclusionHistory: [],
      agentDialogue: [],
      agentResponses: [],
      dataEnvelopes: [],
      hypotheses: [],
      analysisNotes: [],
      analysisPlan: null,
      planHistory: [],
      uncertaintyFlags: [],
      openAIHistory: [{ role: 'user', content: 'previous comparison question' }],
      openAILastResponseId: 'resp_compare_old',
      runSequence: 0,
      conversationOrdinal: 0,
    });

    expect(runtime.sessionMap.get('s1')).toBeUndefined();
    expect(runtime.sessionMap.get('s1:ref:trace-b')).toEqual(expect.objectContaining({
      lastResponseId: 'resp_compare_old',
      updatedAt: snapshotTimestamp,
    }));
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_old');
  });

  it('restores explicit OpenAI session mappings under the comparison key', () => {
    const runtime = createOpenAiRuntimeForTest();

    runtime.restoreSessionMapping('s1', 'resp_compare_restored', 'trace-b');

    expect(runtime.getSdkSessionId('s1')).toBeUndefined();
    expect(runtime.getSdkSessionId('s1', 'trace-b')).toBe('resp_compare_restored');
  });
});
