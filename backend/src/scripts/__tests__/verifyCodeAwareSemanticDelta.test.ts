// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildFollowUpVerificationChecks,
  parseArgs as parseAgentSseArgs,
  setupAnalysisContext,
} from '../verifyAgentSseScrolling';
import {
  DETERMINISTIC_EVIDENCE_KIND,
  loadConstructedSourceGroundTruth,
  runDeterministicSemanticDeltaVerification,
} from '../verifyCodeAwareSemanticDelta';

const repoRoot = path.resolve(__dirname, '../../../..');
const sourceRoot = path.join(repoRoot, 'backend/tests/e2e/context-fixtures/app');

describe('register-only Agent SSE setup', () => {
  it('applies non-partial, verifier, and degraded checks to follow-up runs', () => {
    const options = parseAgentSseArgs([
      '--follow-up-query', '只解释上一轮证据',
      '--require-non-partial',
      '--require-claim-verifier-ok',
      '--forbid-degraded-fallback', 'final_result_quality_gate',
    ]);
    const summary = {
      progressCount: 1,
      conclusionCount: 0,
      analysisCompletedConclusionChars: 1209,
      terminalEvent: 'analysis_completed',
      errorEvents: [],
      planSubmittedCount: 0,
      requiredTextMatches: {},
      toolCallCounts: {},
      degradedFallbackCounts: {},
      analysisCompletedPartial: false,
      claimVerifierStatus: 'passed',
      claimVerifierPassed: true,
      claimVerifierUnsupportedClaimCount: 0,
    } as any;

    expect(Object.values(buildFollowUpVerificationChecks(summary, options)).every(Boolean))
      .toBe(true);

    const failedChecks = buildFollowUpVerificationChecks({
      ...summary,
      degradedFallbackCounts: {final_result_quality_gate: 1},
      analysisCompletedPartial: true,
      claimVerifierStatus: 'partial',
      claimVerifierPassed: false,
      claimVerifierUnsupportedClaimCount: 1,
    }, options);
    expect(failedChecks).toEqual(expect.objectContaining({
      'followUpForbidsDegradedFallback:final_result_quality_gate': false,
      followUpAnalysisCompletedNotPartial: false,
      followUpClaimVerifierPassed: false,
      followUpClaimVerifierHasNoUnsupportedClaims: false,
    }));
  });

  it('defaults a follow-up to auto without changing the initial requested mode', () => {
    const options = parseAgentSseArgs(['--mode', 'full', '--follow-up-query', '只解释上一轮证据']);
    expect(options.analysisMode).toBe('full');
    expect(options.followUpAnalysisMode).toBe('auto');
  });

  it('accepts an explicit per-turn follow-up mode override', () => {
    const options = parseAgentSseArgs([
      '--mode', 'full',
      '--follow-up-query', '重新生成完整报告',
      '--follow-up-mode', 'full',
    ]);
    expect(options.followUpAnalysisMode).toBe('full');
  });

  it('requires a codebase root when setup mode is explicit', () => {
    expect(() => parseAgentSseArgs([
      '--setup-codebase-mode',
      'register-only',
    ])).toThrow('--setup-codebase-mode requires --setup-codebase-root');
  });

  it('proves register-only state from the post-registration audit without reindexing', async () => {
    const options = parseAgentSseArgs([
      '--setup-codebase-root',
      sourceRoot,
      '--setup-codebase-mode',
      'register-only',
    ]);
    const routes: string[] = [];
    const request = jest.fn(async (
      _baseUrl: string,
      route: string,
      _body?: Record<string, unknown>,
      method?: 'GET' | 'POST',
    ) => {
      routes.push(`${method ?? 'POST'} ${route}`);
      if (route.endsWith('/audit')) {
        return {
          success: true,
          audit: {
            codebaseId: 'cb-register-only',
            activeIndexState: 'none',
            chunkCount: 0,
          },
        };
      }
      return {success: true, codebase: {codebaseId: 'cb-register-only'}};
    });

    const result = await setupAnalysisContext('http://127.0.0.1:1', options, request);

    expect(routes).toEqual([
      'POST /api/rag/codebases/register',
      'GET /api/rag/codebases/cb-register-only/audit',
    ]);
    expect(routes.some(route => route.includes('/reindex'))).toBe(false);
    expect(result.codebases).toEqual([{
      codebaseId: 'cb-register-only',
      setupMode: 'register-only',
      chunkCount: 0,
      activeIndexState: 'none',
      activeGeneration: undefined,
      pendingGeneration: false,
      reindexRequests: 0,
    }]);
  });

  it('rejects a lying reindex response when the post-reindex audit is still inactive', async () => {
    const options = parseAgentSseArgs(['--setup-codebase-root', sourceRoot]);
    const request = jest.fn(async (
      _baseUrl: string,
      route: string,
      _body?: Record<string, unknown>,
      _method?: 'GET' | 'POST',
    ) => {
      if (route.endsWith('/reindex')) {
        return {success: true, result: {chunksAdded: 7, generation: 'claimed-active'}};
      }
      if (route.endsWith('/audit')) {
        return {
          success: true,
          audit: {
            codebaseId: 'cb-indexed',
            activeIndexState: 'none',
            chunkCount: 0,
          },
        };
      }
      return {success: true, codebase: {codebaseId: 'cb-indexed'}};
    });

    await expect(setupAnalysisContext('http://127.0.0.1:1', options, request))
      .rejects.toThrow('register-and-index setup did not produce an active audited index');
  });
});

describe('constructed source/trace ground truth', () => {
  it('is generator-owned and hash-binds the exact fixture marker, symbol, line, and trace', () => {
    const groundTruth = loadConstructedSourceGroundTruth(repoRoot);
    const source = fs.readFileSync(path.join(repoRoot, groundTruth.relativeSourcePath), 'utf8');
    const sourceLines = source.split(/\r?\n/);
    const caseDefinition = JSON.parse(fs.readFileSync(
      path.join(repoRoot, 'Trace/constructed/source-analysis-semantic/case.json'),
      'utf8',
    )) as Record<string, any>;

    expect(source).toContain(`TRACE_SOURCE_MARKER = "${groundTruth.marker}"`);
    expect(sourceLines[groundTruth.lineRange.start - 1]).toContain('fun initializeOnMainThread');
    expect(groundTruth).toMatchObject({
      relativeSourcePath: 'backend/tests/e2e/context-fixtures/app/StartupHooks.kt',
      symbol: 'StartupHooks.initializeOnMainThread',
      callChain: [
        'Application.onCreate',
        'StartupHooks.initializeOnMainThread',
        'synchronous startup policy check',
      ],
      trace: {
        materialization: 'committed-base-plus-overlay',
        overlaySha256: caseDefinition.trace.sha256,
      },
    });
    expect(groundTruth.trace.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('registers clean-checkout preparation and the existing Task 7 runtime gate', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'backend/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['prepare:code-aware-semantic-delta']).toBe(
      'npm run trace-processor:ensure && npm run trace:materialize',
    );
    expect(pkg.scripts['test:code-aware-semantic-delta']).toContain(
      'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts',
    );
    expect(pkg.scripts['test:code-aware-semantic-delta']).toContain(
      'npm run prepare:code-aware-semantic-delta',
    );
    expect(pkg.scripts['verify:code-aware-semantic-delta']).toContain(
      'npm run prepare:code-aware-semantic-delta',
    );
    expect(pkg.scripts['verify:code-aware-semantic-delta']).toContain(
      'src/services/__tests__/sourceProvenanceSurfaces.test.ts',
    );
  });
});

describe('deterministic code-aware semantic delta', () => {
  it('derives A0-A4 from real trace, audit, source handlers, SSE projection, and verifiers', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-delta-'));
    try {
      const summary = await runDeterministicSemanticDeltaVerification({repoRoot, outputDir}) as any;

      expect(summary).not.toHaveProperty('runtimes');
      expect(summary).not.toHaveProperty('surfaces');
      expect(summary).not.toHaveProperty('blockedSurfaces');
      expect(summary).toMatchObject({
        schemaVersion: 'code_aware_semantic_delta_summary@2',
        evidenceKind: DETERMINISTIC_EVIDENCE_KIND,
        realProviderAcceptance: false,
        passedMeaning: 'deterministic_assertions_only',
        semanticCoverage: {status: 'INCONCLUSIVE'},
        passed: true,
        queryCount: 3,
        surfaceProof: {
          gate: 'src/services/__tests__/sourceProvenanceSurfaces.test.ts',
          status: 'invoked_by_registered_command',
          surfaces: ['report', 'cli', 'snapshot', 'web_receipt'],
        },
        runtimeProof: {
          gate: 'src/agentRuntime/__tests__/sourceUseResultAttachment.test.ts',
          status: 'invoked_by_registered_command',
        },
      });

      expect(summary.traceFacts).toMatchObject({
        occurrenceCount: 1,
        marker: summary.groundTruth.marker,
        durationNs: summary.groundTruth.traceFacts.durationNs,
        process: summary.groundTruth.traceFacts.process,
        thread: summary.groundTruth.traceFacts.thread,
      });
      expect(summary.conditions.A0.setup).toBeUndefined();
      for (const condition of ['A1', 'A2'] as const) {
        expect(summary.conditions[condition].setup).toMatchObject({
          setupMode: 'register-only',
          chunkCount: 0,
          activeIndexState: 'none',
          activeGeneration: undefined,
          pendingGeneration: false,
          reindexRequests: 0,
        });
      }
      expect(summary.conditions.A3.setup).toMatchObject({
        setupMode: 'register-and-index',
        activeIndexState: 'active',
        reindexRequests: 1,
      });
      expect(summary.conditions.A3.setup.chunkCount).toBeGreaterThan(0);
      expect(summary.conditions.A3.setup.activeGeneration).toEqual(expect.any(String));

      for (const condition of ['A2', 'A3'] as const) {
        expect(summary.conditions[condition].sourceUse).toMatchObject({
          status: 'corroborated',
          references: expect.arrayContaining([expect.objectContaining({
            filePath: 'StartupHooks.kt',
            lineRange: {start: summary.groundTruth.lineRange.start, end: summary.groundTruth.lineRange.end},
          })]),
        });
        expect(summary.conditions[condition].sourceFacts).toMatchObject({
          exactRelativeFile: true,
          exactSymbol: true,
          exactLine: true,
          callChainMapped: true,
          traceMarkerMapped: true,
          actionableSeam: true,
        });
        expect(summary.conditions[condition].finiteProofPassed).toBe(true);
        expect(summary.conditions[condition].claimVerification.claimVerificationResult.status).toBe('partial');
        expect(summary.conditions[condition].semanticCoverage).toBe('INCONCLUSIVE');
        expect(summary.conditions[condition].wrongNumericVerification.claimVerificationResult.status).toBe('failed');
        expect(summary.conditions[condition].originalWrongClaim.semantics.numeric.value)
          .toBe(summary.traceFacts.durationNs + 1);
        expect(summary.conditions[condition].originalWrongClaim.references[0].value)
          .toBe(summary.traceFacts.durationNs);
        expect(summary.conditions[condition].sourceClaimVerification.status).toBe('passed');
        expect(summary.conditions[condition].codeRefOnlyOccurrence.status).not.toBe('passed');
      }

      expect(summary.conditions.A4).toMatchObject({
        wrongReferenceRejected: true,
        sourceClaimVerification: {
          status: 'failed',
          issues: expect.arrayContaining([
            expect.objectContaining({code: 'source_reference_outside_selection'}),
          ]),
        },
      });
      expect(summary.queries.find((query: any) => query.kind === 'quantitative-only')).toMatchObject({
        sourceUseDecision: {
          status: 'pending',
          attemptedTools: [],
          references: [],
        },
      });
      expect(summary.sse).toMatchObject({
        rawSourceCanarySuppressed: true,
        analysisCompletionSourceAttached: true,
      });
      expect(JSON.stringify(summary)).not.toContain(sourceRoot);
      expect(JSON.stringify(summary)).not.toContain('val startupPolicy =');
      expect(fs.existsSync(path.join(outputDir, 'deterministic-summary.json'))).toBe(true);
    } finally {
      fs.rmSync(outputDir, {recursive: true, force: true});
    }
  });
});

describe('real-provider semantic delta wrapper contract', () => {
  const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs') as {
    parseArgs?: (argv: string[]) => Record<string, unknown>;
    semanticDeltaQueries?: () => Array<Record<string, unknown>>;
    semanticConditionArgs?: (
      query: Record<string, unknown>,
      condition: string,
      outputPath: string,
      timeoutMs: number,
    ) => string[];
    evaluateSemanticConditionReport?: (input: Record<string, unknown>) => Record<string, any>;
    runSemanticPreflight: (options: Record<string, unknown>) => Record<string, unknown>;
    scenarioSliceSelector: (caseId: string, scenario: unknown) => Record<string, string>;
    realProviderAvailability?: (
      runtime: string,
      env?: Record<string, string | undefined>,
      fileExists?: (filePath: string) => boolean,
    ) => Record<string, unknown>;
  };

  it('parses repeat five and exposes all three observable query classes', () => {
    expect(wrapper.parseArgs?.([
      '--suite',
      'code-aware-semantic-delta',
      '--runtime',
      'all',
      '--repeat',
      '5',
      '--output-dir',
      'test-output/code-aware-semantic-delta/real-provider',
    ])).toMatchObject({
      suite: 'code-aware-semantic-delta',
      runtime: 'all',
      repeat: 5,
      outputDir: expect.stringContaining('test-output/code-aware-semantic-delta/real-provider'),
    });
    expect(wrapper.semanticDeltaQueries?.().map(query => query.kind)).toEqual([
      'autonomous-diagnosis',
      'quantitative-only',
      'explicit-source-location',
    ]);
  });

  it('permits one existing query and condition only in explicitly diagnostic preflight mode', () => {
    const args = ['--suite', 'code-aware-semantic-delta', '--runtime', 'openai', '--preflight',
      '--query-id', 'explicit-source-location', '--condition', 'A2'];
    expect(wrapper.parseArgs?.(args)).toMatchObject({preflight: true, repeat: 1,
      queryId: 'explicit-source-location', condition: 'A2', timeoutMs: 1_200_000});
    for (const invalid of [args.concat('--repeat', '5'), args.concat('--runtime', 'all'),
      args.concat('--query-id', 'injected-answer'), args.concat('--condition', 'A4'),
      args.filter(arg => arg !== '--preflight'), ['--suite', 'code-aware-semantic-delta']]) {
      expect(() => wrapper.parseArgs?.(invalid)).toThrow();
    }
  });

  it('uses structured facts and source bindings instead of required answer wording', () => {
    for (const query of wrapper.semanticDeltaQueries?.() ?? []) {
      for (const condition of ['A0', 'A2', 'A3']) {
        const args = wrapper.semanticConditionArgs?.(query, condition, 'case.json', 1000) ?? [];
        expect(args).not.toContain('--require-text');
        expect(args[args.indexOf('--query') + 1]).toBe(query.text);
        expect(args).toContain('--expectation-json');
      }
    }
  });

  it('uses one scenario-derived target for all source conditions without changing any query', () => {
    const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot,
      'Trace/constructed/source-analysis-semantic/scenario.json'), 'utf8'));
    const selected = wrapper.scenarioSliceSelector('source-analysis-semantic', scenario);
    expect(selected).toEqual({processName: 'com.smartperfetto.fixture', threadName: 'main',
      eventName: 'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy'});
    const originalQueries = [
      '诊断这次启动变慢的主要机制，区分本次 Trace 事实与源码机制解释。',
      'Trace 中 StartupHooks.initializeOnMainThread#before-first-frame-sync-policy 这个标记区间持续多久？只回答 Trace 中的量化事实。',
      '指出本次启动标记对应的源码位置、调用链和最小可操作修改点。',
    ];
    expect(wrapper.semanticDeltaQueries!().map(query => query.text)).toEqual(originalQueries);
    for (const query of wrapper.semanticDeltaQueries!()) {
      for (const condition of ['A0', 'A2', 'A3']) {
        const args = wrapper.semanticConditionArgs!(query, condition, 'selected-case.json', 1000);
        const parsed = parseAgentSseArgs(args);
        expect(parsed.sliceSelectionTarget).toEqual(selected);
        expect(parsed.query).toBe(query.text);
        expect(parsed.selectionContext).toBeUndefined();
        expect(parsed.traceContext).toBeUndefined();
        expect(parsed.expectation?.facts[0]).toMatchObject({id: 'source_marker_duration', value: 42_000_000, unit: 'ns'});
      }
    }
    const durationChanged = structuredClone(scenario);
    durationChanged.signals.forEach((signal: Record<string, unknown>) => { signal.duration_ns = '999'; });
    expect(wrapper.scenarioSliceSelector('source-analysis-semantic', durationChanged)).toEqual(selected);
    const ambiguous = structuredClone(scenario);
    ambiguous.signals.push(ambiguous.signals[ambiguous.signals.length - 1]);
    expect(() => wrapper.scenarioSliceSelector('source-analysis-semantic', ambiguous)).toThrow('exactly one target slice');
    const missingActor = structuredClone(scenario);
    missingActor.actors.threads = [];
    expect(() => wrapper.scenarioSliceSelector('source-analysis-semantic', missingActor)).toThrow('identities are missing or ambiguous');
  });

  it('writes unavailable preflight evidence without starting a provider or claiming full acceptance', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'smartperfetto-preflight-unavailable-'));
    const environment = jest.replaceProperty(process, 'env', {...process.env, DEEPSEEK_API_KEY: '', OPENAI_API_KEY: ''});
    const output = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const options = wrapper.parseArgs!(['--suite', 'code-aware-semantic-delta', '--runtime', 'openai', '--preflight',
        '--query-id', 'explicit-source-location', '--condition', 'A2', '--output-dir', directory]);
      expect(wrapper.runSemanticPreflight(options)).toMatchObject({preflightPassed: false, completeAcceptance: false,
        status: 'REAL PROVIDER NOT AVAILABLE', condition: 'A2'});
      const artifact = JSON.parse(fs.readFileSync(path.join(directory,
        'openai-agents-sdk/preflight/explicit-source-location/A2.preflight.json'), 'utf8'));
      expect(artifact.passedMeaning).toBe('single_scenario_diagnostic_only_not_repeated_provider_acceptance');
      expect(artifact.record).toBeUndefined();
    } finally {
      environment.restore();
      output.mockRestore();
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('keeps the real privacy canary inside the unchanged source ground-truth read window', () => {
    const groundTruth = loadConstructedSourceGroundTruth(repoRoot);
    const lines = fs.readFileSync(path.join(sourceRoot, 'StartupHooks.kt'), 'utf8').split(/\r?\n/);
    expect(lines[8]).toContain('fun initializeOnMainThread()');
    expect(lines.slice(groundTruth.lineRange.start - 1, groundTruth.lineRange.end).join('\n'))
      .toContain('SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT');
  });

  it('distinguishes canary diagnostic keys from actual leaked content', () => {
    const canary = 'SEMANTIC_DELTA_PRIVATE_SOURCE_CANARY_NEVER_EMIT';
    const query = wrapper.semanticDeltaQueries!()[0];
    const report = {checks: {[`forbidsText:${canary}`]: true},
      summary: {forbiddenTextMatches: {[canary]: false}, terminalAnalysis: {conclusion: 'Safe conclusion.'}}};
    const evaluatePrivacy = () => wrapper.evaluateSemanticConditionReport!({query, report, condition: 'A0', sourceRoot}).privacyPassed;
    expect(evaluatePrivacy()).toBe(true);
    report.summary.terminalAnalysis.conclusion = canary;
    expect(evaluatePrivacy()).toBe(false);
    report.summary.terminalAnalysis.conclusion = 'Safe conclusion.';
    report.summary.forbiddenTextMatches[canary] = true;
    expect(evaluatePrivacy()).toBe(false);
  });

  it('keeps Claude independently available when local Claude auth exists', () => {
    expect(wrapper.realProviderAvailability?.(
      'claude-agent-sdk',
      {CLAUDE_CODE_OAUTH_TOKEN: 'present'},
      () => false,
    )).toMatchObject({available: true});
  });

  it('makes A0 source leakage an explicit failure instead of missing-key evidence', () => {
    const query = wrapper.semanticDeltaQueries?.()[0];
    expect(query).toBeDefined();
    const args = wrapper.semanticConditionArgs?.(query!, 'A0', 'a0.json', 1_000);
    expect(args).toBeDefined();
    const forbidden = args!
      .map((arg, index) => arg === '--forbid-text' ? args![index + 1] : undefined)
      .filter(Boolean);
    expect(forbidden).toEqual(expect.arrayContaining([
      'backend/tests/e2e/context-fixtures/app/StartupHooks.kt',
      'StartupHooks.kt',
      '[Code:',
    ]));
    expect(forbidden).not.toContain('avoid synchronous disk I/O before first frame');
    // This symbol is already public trace-marker text, not source-only evidence.
    expect(forbidden).not.toContain('StartupHooks.initializeOnMainThread');
    // Android lifecycle names are public background knowledge, not a private-source canary.
    expect(forbidden).not.toContain('Application.onCreate');
    expect(forbidden.every(text => !'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy'.includes(String(text)))).toBe(true);
    expect(args).toContain('--expectation-json');

    const evaluated = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A0',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {codebaseIds: []},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
          },
          forbiddenTextMatches: {'StartupHooks.kt': true},
          claimVerifierStatus: 'passed',
          claimVerifierPassed: true,
          claimVerifierCheckedClaimCount: 1,
          claimVerifierUnsupportedClaimCount: 0,
          toolCallCounts: {},
        },
      },
    });
    expect(evaluated).toMatchObject({sourceLeakFree: false});
  });

  it('rejects marker repetition without verified trace claims or source bindings', () => {
    const [query] = wrapper.semanticDeltaQueries?.() ?? [];
    const markerOnly = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A0',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {codebaseIds: []},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
          },
          forbiddenTextMatches: {},
          toolCallCounts: {},
        },
      },
    });
    expect(markerOnly).toMatchObject({traceFactPassed: false});

    const sourceBindingFailed = wrapper.evaluateSemanticConditionReport?.({
      query,
      condition: 'A2',
      sourceRoot,
      report: {
        passed: true,
        analysisContext: {setup: {codebases: [{
          setupMode: 'register-only',
          chunkCount: 0,
          activeIndexState: 'none',
          pendingGeneration: false,
          reindexRequests: 0,
        }]}},
        summary: {
          requiredTextMatches: {
            'StartupHooks.initializeOnMainThread#before-first-frame-sync-policy': true,
            'StartupHooks.kt': true,
            'StartupHooks.initializeOnMainThread': true,
            'Application.onCreate': true,
            'avoid synchronous disk I/O before first frame': true,
          },
          forbiddenTextMatches: {},
          claimVerifierStatus: 'passed',
          claimVerifierPassed: true,
          claimVerifierCheckedClaimCount: 1,
          claimVerifierUnsupportedClaimCount: 0,
          conclusionHasConcreteCodeRefs: true,
          analysisCompletedSourceUseStatus: 'corroborated',
          analysisCompletedSourceReferenceCount: 1,
          analysisCompletedSourceBindingCount: 1,
          analysisCompletedSourceClaimVerifierStatus: 'failed',
          analysisCompletedSourceMechanismStatuses: ['corroborated'],
          analysisCompletedSourceReferenceMembershipPassed: false,
          toolCallCounts: {search_codebase: 1, read_codebase_file: 1},
        },
      },
    });
    expect(sourceBindingFailed).toMatchObject({sourceSemanticPassed: false});
  });

  it('records every missing Qoder authentication boundary without calling it a pass', () => {
    expect(wrapper.realProviderAvailability?.('qoder-agent-sdk', {}, () => false)).toEqual({
      available: false,
      reason:
        'DEEPSEEK_API_KEY_OR_OPENAI_API_KEY_MISSING;QODER_PERSONAL_ACCESS_TOKEN_OR_QODERCLI_PATH_MISSING',
    });
  });
});

describe('real-provider task fact configuration', () => {
  const wrapper = require('../../../scripts/run-deepseek-agent-e2e.cjs');

  it('allows scrolling to choose its tools while declaring independently queried frame facts', () => {
    const args: string[] = wrapper.suites.scrolling.args;
    expect(args).not.toContain('--require-skill');
    expect(args).not.toContain('--require-tool');
    const expectation = parseAgentSseArgs(args).expectation;
    expect(expectation?.facts.map(fact => fact.id)).toEqual(['total_frames', 'jank_frames']);
    expect(expectation?.facts.every(fact => fact.verification === 'proved' && fact.oracle?.sql)).toBe(true);
  });

  it('keeps explicit connector invocation checks and removes startup sentence polarity traps', () => {
    expect(wrapper.suites['external-issue'].args).toContain('anr_analysis');
    expect(wrapper.suites.startup.args).not.toContain('--require-text');
    expect(wrapper.suites.startup.args).not.toContain('--forbid-text');
    const expectation = parseAgentSseArgs(wrapper.suites.startup.args).expectation;
    expect(expectation?.facts.find(fact => fact.id === 'startup_type')?.verification).toBe('reference_only');
  });

  it('reports source action semantics as uncovered instead of requiring an English sentence', () => {
    const query = wrapper.semanticDeltaQueries()[0];
    const args = wrapper.semanticConditionArgs(query, 'A3', 'a3.json', 1000);
    expect(args).not.toContain('avoid synchronous disk I/O before first frame');
    const expectation = parseAgentSseArgs(args).expectation;
    expect(expectation?.uncoveredFacets).toContain('source recommendation action semantics');
    expect(expectation?.facts[0]).toMatchObject({id: 'source_marker_duration', value: 42_000_000, unit: 'ns'});
  });

  it('keeps successful observed facts separate from incomplete aggregate semantic acceptance', () => {
    const result = wrapper.summarizeSemanticRuntimeRecords([{hardPassed: true, sourceUpliftPassed: true,
      uncoveredFacets: ['source recommendation action semantics']}], 1);
    expect(result).toMatchObject({status: 'REAL PROVIDER INCONCLUSIVE', observedChecksPassed: true,
      semanticAcceptance: 'INCONCLUSIVE', completeAcceptance: false, hardPassCount: 1, sourceUpliftPassCount: 1});
  });

  it.each(['pending', 'attempted', 'not_needed'])('accepts trace-only output independently of optional source audit state %s', status => {
    const query = wrapper.semanticDeltaQueries().find((item: any) => item.kind === 'quantitative-only');
    const report = {traceId: 'trace', taskVerification: {checks: {originalClaimsVerified: true, 'fact:source_marker_duration': true},
      facts: {source_marker_duration: {matched: true, proposition: 'proved',
        matchedClaimIds: ['duration'], matchedAnchorIds: ['anchor-duration']}}, uncoveredFacets: []},
      summary: {analysisCompletedSourceUseStatus: status, toolCallCounts: {lookup_app_source: 1},
        terminalAnalysis: {conclusionContract: {claims: [{id: 'duration', kind: 'numeric', semantics: {scope: {population: 'cited_rows'}}}]},
          claimSupport: [{claimId: 'duration', anchors: [{anchorId: 'anchor-duration', evidenceRefId: 'data-duration',
            context: {traceId: 'trace', traceSide: 'current'}}]}],
          claimVerificationResult: {schemaVersion: 'claim_verifier@2', claimResults: [{claimId: 'duration', status: 'verified',
            deterministicProof: {kind: 'numeric_cell', status: 'proved', anchorIds: ['anchor-duration'], evidenceRefIds: ['data-duration']},
            propositionCoverage: {status: 'complete', uncovered: []},
            referenceCells: [{anchorId: 'anchor-duration', evidenceRefId: 'data-duration', column: 'dur', status: 'matched'}]}]}}}};
    expect(wrapper.evaluateSemanticConditionReport({query, report, condition: 'A3', sourceRoot}).sourceSemanticPassed).toBe(true);
    report.summary.terminalAnalysis.conclusionContract.claims[0].kind = 'recommendation';
    expect(wrapper.evaluateSemanticConditionReport({query, report, condition: 'A3', sourceRoot}).sourceSemanticPassed).toBe(false);
  });

  it('accepts verified source bindings after a located lookup without a corroborated audit ceremony', () => {
    const query = wrapper.semanticDeltaQueries()[0];
    const report = {traceId: 'trace', analysisContext: {codebaseIds: ['cb-source']},
      taskVerification: {checks: {originalClaimsVerified: true, 'fact:source_marker_duration': true},
      facts: {source_marker_duration: {matched: true, proposition: 'proved',
        matchedClaimIds: ['trace-duration'], matchedAnchorIds: ['anchor-marker']}}, uncoveredFacets: []},
      summary: {analysisCompletedSourceUseStatus: 'located', analysisCompletedSourceReferenceCount: 1,
        analysisCompletedSourceBindingCount: 1, analysisCompletedSourceClaimVerifierStatus: 'passed',
        analysisCompletedSourceReferenceMembershipPassed: true, analysisCompletedSourceMechanismStatuses: ['compatible'],
        analysisCompletedVerifiedSourceBindings: [{claimId: 'trace-duration', mechanismStatus: 'compatible',
          sourceReferenceIds: ['source-ref-v1-issued'], traceEvidenceRefIds: ['data-marker']}],
        terminalAnalysis: {claimSupport: [{claimId: 'trace-duration', anchors: [{anchorId: 'anchor-marker',
          evidenceRefId: 'data-marker', context: {traceId: 'trace', traceSide: 'current'},
          timeRange: {startTs: '1000', endTs: '42001000', unit: 'ns'}, identity: {upid: 10, utid: 11},
          cells: [{column: 'dur', rowSelector: {slice_id: 50, track_id: 5}}]}]}],
          claimVerificationResult: {schemaVersion: 'claim_verifier@2', claimResults: [{claimId: 'trace-duration', status: 'verified',
            deterministicProof: {kind: 'numeric_cell', status: 'proved', anchorIds: ['anchor-marker'], evidenceRefIds: ['data-marker']},
            propositionCoverage: {status: 'complete', uncovered: []},
            referenceCells: [{anchorId: 'anchor-marker', evidenceRefId: 'data-marker', column: 'dur', status: 'matched'}]}]},
          conclusionContract: {claims: [{id: 'trace-duration', kind: 'numeric'}], sourceUseDecision: {references: [{id: 'source-ref-v1-issued',
          codebaseId: 'cb-source', lookupKind: 'body', filePath: 'StartupHooks.kt', lineRange: {start: 1, end: 20}}]}}}}};
    expect(wrapper.evaluateSemanticConditionReport({query, report, condition: 'A3', sourceRoot}))
      .toMatchObject({sourceSemanticPassed: true, privacyCanaryCovered: true});
    const reference = report.summary.terminalAnalysis.conclusionContract.sourceUseDecision.references[0];
    for (const changed of [{codebaseId: 'cb-other'}, {filePath: 'other/StartupHooks.kt'},
      {lookupKind: 'metadata'}, {lineRange: {start: 10, end: 20}}]) {
      const invalid = structuredClone(report);
      invalid.summary.terminalAnalysis.conclusionContract.sourceUseDecision.references[0] = {...reference, ...changed};
      expect(wrapper.evaluateSemanticConditionReport({query, report: invalid, condition: 'A2', sourceRoot}).sourceIdentityPassed).toBe(false);
    }
    for (const changed of [{sourceReferenceIds: ['source-ref-v1-unrelated']}, {claimId: 'unrelated-claim'},
      {traceEvidenceRefIds: ['data-unrelated']}, {mechanismStatus: 'unverified'}]) {
      const invalid = structuredClone(report);
      invalid.summary.analysisCompletedVerifiedSourceBindings[0] = {
        ...invalid.summary.analysisCompletedVerifiedSourceBindings[0], ...changed};
      expect(wrapper.evaluateSemanticConditionReport({query, report: invalid, condition: 'A2', sourceRoot}).sourceIdentityPassed).toBe(false);
    }
    // A mechanism claim may be distinct from the numeric duration claim, while
    // still using verified evidence for the same occurrence.
    const mechanism = structuredClone(report);
    const anchor = {...structuredClone(mechanism.summary.terminalAnalysis.claimSupport[0].anchors[0]),
      anchorId: 'anchor-mechanism', evidenceRefId: 'data-mechanism'};
    mechanism.summary.terminalAnalysis.claimSupport.push({claimId: 'mechanism', anchors: [anchor]});
    mechanism.summary.analysisCompletedVerifiedSourceBindings[0].claimId = 'mechanism';
    mechanism.summary.analysisCompletedVerifiedSourceBindings[0].traceEvidenceRefIds = ['data-mechanism'];
    expect(wrapper.evaluateSemanticConditionReport({query, report: mechanism, condition: 'A2', sourceRoot}).sourceIdentityPassed).toBe(true);
    for (const changed of [
      {timeRange: {...anchor.timeRange, startTs: '2000'}},
      {timeRange: {...anchor.timeRange, endTs: '1100'}},
      {identity: {...anchor.identity, utid: 12}},
      {timeRange: {...anchor.timeRange, endTs: '1100'}, identity: {...anchor.identity, utid: 12}},
      {identity: {upid: 10, utid: undefined}},
      {cells: [{...anchor.cells[0], rowSelector: {slice_id: 51, track_id: 5}}]},
      {cells: [{...anchor.cells[0], rowSelector: {slice_id: 50, track_id: 6}}]},
    ]) {
      const invalid = structuredClone(mechanism);
      Object.assign(invalid.summary.terminalAnalysis.claimSupport[1].anchors[0], changed);
      expect(wrapper.evaluateSemanticConditionReport({query, report: invalid, condition: 'A2', sourceRoot}))
        .toMatchObject({sourceIdentityPassed: false, sourceSemanticPassed: false});
    }
  });

  it('requires a row locator for cross-claim reuse of a multi-row result set', () => {
    const oracle = {anchorId: 'anchor-duration', evidenceRefId: 'data-slices',
      context: {traceId: 'trace', traceSide: 'current'},
      cells: [{column: 'dur', rowIndex: 0}]};
    const sameRow = {...structuredClone(oracle), anchorId: 'anchor-mechanism'};
    expect(wrapper.sameTraceOccurrence(sameRow, oracle)).toBe(true);
    sameRow.cells[0].rowIndex = 1;
    expect(wrapper.sameTraceOccurrence(sameRow, oracle)).toBe(false);
    // Identical anchor ids must not override a contradictory concrete row.
    sameRow.anchorId = oracle.anchorId;
    expect(wrapper.sameTraceOccurrence(sameRow, oracle)).toBe(false);
    expect(wrapper.sameTraceOccurrence({...sameRow, anchorId: 'other', cells: []}, oracle)).toBe(false);
    const selected = {...oracle, cells: [{column: 'dur', rowSelector: {slice_id: 50, track_id: 5}}]};
    expect(wrapper.sameTraceOccurrence({...selected, anchorId: 'mechanism'}, selected)).toBe(true);
    expect(wrapper.sameTraceOccurrence({...selected, anchorId: 'mechanism',
      cells: [{column: 'dur', rowSelector: {slice_id: 51, track_id: 5}}]}, selected)).toBe(false);
  });
});
