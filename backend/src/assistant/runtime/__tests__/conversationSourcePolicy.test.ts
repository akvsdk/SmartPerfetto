// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolvePrimaryConversationSourceUse} from '../conversationSourcePolicy';

describe('conversationSourcePolicy', () => {
  it.each([
    '为什么这次启动很慢？',
    '分析主线程卡顿的主要原因',
    'What caused the startup slowdown?',
    '这个数据的来源是什么？',
    '结合源码看看 Choreographer#doFrame 为什么慢',
    'Which source file implements recoverDatabase?',
    'recoverRetryProbeDatabase 为什么返回 restore snapshot？',
    '完整审查整个源码',
    '',
  ])('keeps selected source available to the primary run independently of wording: %s', query => {
    for (const codeAwareMode of ['metadata_only', 'provider_send'] as const) {
      expect(resolvePrimaryConversationSourceUse({
        query, codeAwareMode, codebaseIds: ['app'],
      })).toBe('explicit');
    }
  });

  it.each([
    {hasAuthorizedCodebase: true},
    {codeAwareMode: 'off' as const, codebaseIds: ['app'], hasAuthorizedCodebase: true},
    {codeAwareMode: 'provider_send' as const, codebaseIds: [], hasAuthorizedCodebase: true},
    {codebaseIds: ['app']},
    {codeAwareMode: 'metadata_only' as const},
    {codeAwareMode: 'provider_send' as const, codebaseIds: ['app'], hasAuthorizedCodebase: false},
  ])('requires enabled mode and selected IDs and honors authorization denial: %j', selection => {
    expect(resolvePrimaryConversationSourceUse({query: '看看源码里的 Foo#bar', ...selection})).toBe('dormant');
  });
});
