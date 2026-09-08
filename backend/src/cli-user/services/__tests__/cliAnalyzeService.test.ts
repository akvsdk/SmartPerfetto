// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import { createDataEnvelope } from '../../../types/dataContract';
import type { ConclusionContract } from '../../../agent/core/conclusionContract';
import { runClaimVerification } from '../../../services/verifier/claimVerificationRunner';
import {
  envelopesFromStreamingUpdate,
  shouldExposeLiveStreamingUpdate,
} from '../cliAnalyzeService';

describe('CliAnalyzeService streaming data collection', () => {
  it('preserves valid DataEnvelope updates without treating transport data as execution proof', () => {
    const envelope = createDataEnvelope({
      columns: ['blocked_ms'],
      rows: [[120]],
    }, {
      type: 'skill_result',
      source: 'startup_main_thread_blocking',
      title: 'Main thread blocking',
      layer: 'overview',
      format: 'table',
      evidenceRefId: 'data:skill:test',
      sourceToolCallId: 'invoke_skill:test',
      traceId: 'trace-a',
      traceSide: 'current',
    });
    const collected = envelopesFromStreamingUpdate({
      type: 'data',
      content: [envelope, { bad: 'shape' }],
      timestamp: Date.now(),
    });
    const conclusionContract: ConclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{
        id: 'claim-main-thread-blocked',
        kind: 'numeric',
        text: '主线程 blocked_ms 为 120',
        references: [{
          evidenceRefId: 'data:skill:test',
          sourceToolCallId: 'invoke_skill:test',
          rowIndex: 0,
          column: 'blocked_ms',
          value: 120,
        }],
      }],
      uncertainties: [],
      nextSteps: [],
      metadata: {},
    };

    const result = runClaimVerification({
      conclusionContract,
      dataEnvelopes: collected,
    });

    expect(collected).toEqual([envelope]);
    expect(collected[0].data).toEqual({columns: ['blocked_ms'], rows: [[120]]});
    expect(result.claimVerificationResult).toMatchObject({
      schemaVersion: 'claim_verifier@2', status: 'not_checked', passed: false, unsupportedClaimCount: 0,
      claimResults: [{claimId: 'claim-main-thread-blocked', status: 'not_checked'}],
    });
  });

  it('does not expose pre-verifier narrative events to live machine streams', () => {
    expect(shouldExposeLiveStreamingUpdate({
      type: 'answer_token',
      content: { token: 'draft final answer' },
      timestamp: Date.now(),
    })).toBe(false);
    expect(shouldExposeLiveStreamingUpdate({
      type: 'conclusion',
      content: { conclusion: 'draft final answer' },
      timestamp: Date.now(),
    })).toBe(false);
    expect(shouldExposeLiveStreamingUpdate({
      type: 'data',
      content: [],
      timestamp: Date.now(),
    })).toBe(true);
  });
});
