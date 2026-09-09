// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { createRenderer, parseOutputFormat, parseTextJsonFormat } from '../renderer';

describe('CLI renderer', () => {
  test('renders one JSON object after completion', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.onEvent({ type: 'progress', content: { phase: 'x', message: 'ignored' } } as any);
      renderer.printConclusion('done', { confidence: 0.8, rounds: 2, durationMs: 1234 });
      renderer.printCompletion({ sessionId: 's1', sessionDir: '/tmp/s1', reportPath: '/tmp/s1/report.html' });
    });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      ok: true,
      sessionId: 's1',
      conclusion: 'done',
      confidence: 0.8,
      rounds: 2,
      durationMs: 1234,
    });
  });

  test('keeps investigation deficits separate from machine completion', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format: 'json'});
      renderer.printConclusion('done', {investigationAssurance: {investigation: 'passed', investigationEvidence: 'coverage_incomplete'}});
      renderer.printCompletion({sessionId: 'system', sessionDir: '/tmp/system', reportPath: '/tmp/system/report.html', success: true});
    });
    expect(JSON.parse(output)).toMatchObject({ok: true, conclusion: 'done',
      investigationAssurance: {investigation: 'passed', investigationEvidence: 'coverage_incomplete'}});
  });

  test('renders NDJSON event, conclusion, and completion records', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.onEvent({ type: 'progress', content: { phase: 'load', message: 'loading' } } as any);
      renderer.printConclusion('done', { confidence: 0.9 });
      renderer.printCompletion({ sessionId: 's2', sessionDir: '/tmp/s2', reportPath: '/tmp/s2/report.html' });
    });

    const lines = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ type: 'event', eventType: 'progress' });
    expect(lines[1]).toMatchObject({ type: 'conclusion', conclusion: 'done', confidence: 0.9 });
    expect(lines[2]).toMatchObject({ type: 'complete', ok: true, sessionId: 's2' });
  });

  test('machine conclusion includes deterministic verifier verdict', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'ndjson' });
      renderer.printConclusion('done', {
        confidence: 0.9,
        claimVerification: {
          status: 'passed',
          checkedClaimCount: 1,
          unsupportedClaimCount: 0,
          issueCount: 0,
        },
      });
    });

    expect(JSON.parse(output)).toMatchObject({
      type: 'conclusion',
      conclusion: 'done',
      claimVerification: {
        status: 'passed',
        checkedClaimCount: 1,
      },
    });
  });

  test('machine completion reflects failed analysis status', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'json' });
      renderer.printConclusion('failed', { confidence: 0.1 });
      renderer.printCompletion({
        sessionId: 's3',
        sessionDir: '/tmp/s3',
        reportPath: '/tmp/s3/report.html',
        success: false,
      });
    });

    expect(JSON.parse(output)).toMatchObject({ ok: false, sessionId: 's3' });
  });

  test('text completion suggests valid follow-up commands', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({ verbose: false, useColor: false, format: 'text' });
      renderer.printCompletion({
        sessionId: 's4',
        sessionDir: '/tmp/s4',
        reportPath: '/tmp/s4/report.html',
      });
    });

    expect(output).toContain('smp ask s4 "..."');
    expect(output).toContain('smp repl --resume s4');
    expect(output).not.toContain('smp resume s4');
  });

  test('rejects unknown output formats', () => {
    expect(() => parseOutputFormat('xml')).toThrow('Invalid --format value');
  });

  test('explains a quality failure without claiming that a narrative is missing', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false});
      renderer.printConclusion('Evidence and limitations are present.', {});
      renderer.printCompletion({sessionId: 'gate', sessionDir: '/tmp/gate', reportPath: '/tmp/gate/report.html',
        partial: true, hasConclusion: true, terminationReason: 'quality_gate_failed',
        terminationMessage: '13 claims have invalid declarations or bindings.'});
    });
    expect(output).toMatch(/已有正文，但未通过质量校验|a narrative is available, but quality checks did not pass/);
    expect(output).toContain('13 claims have invalid declarations or bindings.');
    expect(output).not.toContain('结果为部分内容');
  });

  test('states that no deliverable was produced when a turn cap has no body', () => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false});
      renderer.printConclusion('   ', {confidence: 0});
      renderer.printCompletion({sessionId: 'empty', sessionDir: '/tmp/empty', reportPath: '/tmp/empty/report.html',
        partial: true, hasConclusion: false, terminationReason: 'max_turns'});
    });
    expect(output).toMatch(/未生成可交付结论|without a deliverable conclusion/);
    expect(output).toContain('max_turns');
    expect(output).not.toContain('(空)');
    expect(output).not.toContain('结果为部分内容');
  });

  test.each(['json', 'ndjson'] as const)('preserves termination diagnostics in %s', format => {
    const output = captureStdout(() => {
      const renderer = createRenderer({verbose: false, useColor: false, format});
      renderer.printConclusion('', {});
      renderer.printCompletion({sessionId: 'empty', sessionDir: '/tmp/empty', reportPath: '/tmp/empty/report.html',
        partial: true, hasConclusion: false, terminationReason: 'max_turns', terminationMessage: 'Turn budget exhausted.'});
    });
    const records = output.trim().split('\n').map(line => JSON.parse(line));
    expect(records[records.length - 1]).toMatchObject({partial: true, hasConclusion: false,
      terminationReason: 'max_turns', terminationMessage: 'Turn budget exhausted.'});
  });

  test('rejects ndjson for text/json-only commands', () => {
    expect(parseTextJsonFormat('json')).toBe('json');
    expect(() => parseTextJsonFormat('ndjson')).toThrow('Expected text or json');
  });
});

function captureStdout(fn: () => void): string {
  const original = process.stdout.write;
  const originalConsoleLog = console.log;
  let output = '';
  (process.stdout.write as any) = (chunk: any) => {
    output += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    return true;
  };
  console.log = (...values: unknown[]) => {
    output += `${values.map(String).join(' ')}\n`;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
    console.log = originalConsoleLog;
  }
  return output;
}
