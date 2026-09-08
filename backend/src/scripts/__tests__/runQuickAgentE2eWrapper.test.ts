// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { execFile, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getTraceProcessorPath } from '../../services/workingTraceProcessor';
import { resolveTraceCase } from '../../utils/traceCorpus';

const backendRoot = path.resolve(__dirname, '../../..');
const wrapperPath = path.join(backendRoot, 'scripts/run-quick-agent-e2e.cjs');
const {frameFactExpectation} = require(path.join(backendRoot, 'scripts/run-deepseek-agent-e2e.cjs')) as {
  frameFactExpectation: () => {facts: Array<{id: string; oracle: {sql: string}}>};
};
const execFileAsync = promisify(execFile);
const launchLightTracePath = resolveTraceCase('launch_light.pftrace', path.resolve(backendRoot, '..'));
const traceProcessorPath = getTraceProcessorPath();
const itWithLaunchLightTraceProcessor = fs.existsSync(traceProcessorPath) && fs.existsSync(launchLightTracePath)
  ? it
  : it.skip;

function runWrapper(args: string[]) {
  return spawnSync(process.execPath, [wrapperPath, ...args], {
    cwd: backendRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOTENV_CONFIG_QUIET: 'true',
    },
  });
}

describe('run-quick-agent-e2e wrapper', () => {
  itWithLaunchLightTraceProcessor('matches the independent frame population oracle to launch_light', async () => {
    const fact = frameFactExpectation().facts.find(item => item.id === 'total_frames');
    expect(fact).toBeDefined();
    const {stdout} = await execFileAsync(traceProcessorPath, ['query', launchLightTracePath, fact!.oracle.sql], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 30_000,
    });
    const text = String(stdout);
    expect(text).toMatch(/^"total_frames","jank_frames"\r?$/m);
    expect(text).toMatch(/^291,\d+\r?$/m);
    expect(text).not.toMatch(/^248,\d+\r?$/m);
  }, 45_000);

  it('dry-runs the mixed trace/scrolling quick suite with strict quick-mode gates', () => {
    const result = runWrapper([
      '--suite',
      'mixed-trace-scrolling',
      '--runtime',
      'claude-agent-sdk',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] suite=mixed-trace-scrolling');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('SMARTPERFETTO_AGENT_RUNTIME=claude-agent-sdk');
    expect(result.stdout).toContain('--require-quick-run');
    expect(result.stdout).toContain('--require-data-envelope');
    expect(result.stdout).toContain('--forbid-degraded-fallback quick_full_report_shape');
    expect(result.stdout).toContain('--max-analysis-completed-conclusion-chars 900');
    expect(result.stdout).not.toContain('--max-rounds');
    expect(result.stdout).toContain('--expectation-json');
    expect(result.stdout).toContain('total_frames');
    expect(result.stdout).toContain('jank_frames');
    expect(result.stdout).not.toContain('--require-text');
    expect(result.stdout).not.toContain('--require-skill');
  });

  it('dry-runs the all-runtime matrix without provider credential requirements', () => {
    const result = runWrapper([
      '--suite',
      'trace-fact',
      '--runtime',
      'all',
      '--dry-run',
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('[quick-e2e] runtime=claude-agent-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=openai-agents-sdk');
    expect(result.stdout).toContain('[quick-e2e] runtime=pi-agent-core');
    expect(result.stdout).toContain('[quick-e2e] runtime=opencode');
    expect(result.stdout).not.toContain('DEEPSEEK_API_KEY');
    expect(result.stdout).not.toContain('OPENAI_API_KEY is required');
  });
});
