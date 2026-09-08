// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {ConclusionSidecarFramingScanner} from '../agent/core/conclusionContract';
import type {StreamingUpdate} from '../agent/types';

type TextKey = 'token' | 'delta' | 'conclusion';

function contentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function replaceText(update: StreamingUpdate, text: string, keys: TextKey[], totalChars: number): StreamingUpdate {
  if (typeof update.content === 'string') return {...update, content: text};
  const content = {...update.content};
  // Some transports carry both token/delta aliases. Neither may retain raw text.
  for (const key of keys) content[key] = text;
  if ('totalChars' in content) content.totalChars = totalChars;
  return {...update, content};
}

/**
 * One instance per physical run. This is display-only: retain the original
 * updates and AnalysisResult for finalization, evidence, and persistence.
 */
export class AnalysisNarrativeStreamProjection {
  private scanner = new ConclusionSidecarFramingScanner();
  private lastAnswer: StreamingUpdate | undefined;
  private lastKeys: TextKey[] = [];
  private visibleChars = 0;
  private ended = false;
  private incrementalSuppression: 'conflicting_text_aliases' | undefined;

  /** Display diagnostic only; it never changes native completion or recovery. */
  get suppressionReason(): 'conflicting_text_aliases' | undefined {
    return this.incrementalSuppression;
  }

  project(update: StreamingUpdate): StreamingUpdate | undefined {
    if (update.type !== 'answer_token' && update.type !== 'conclusion') return update;
    const content = update.content as unknown;
    const keys: TextKey[] = (update.type === 'conclusion' ? ['conclusion'] as const : ['token', 'delta'] as const)
      .filter(key => contentRecord(content) && typeof content[key] === 'string');
    const text = typeof content === 'string' ? content : keys.length && contentRecord(content)
      ? content[keys[0]] as string : '';

    if (update.type === 'conclusion') {
      if (typeof content !== 'string' && keys.length === 0) return update;
      const scanner = new ConclusionSidecarFramingScanner();
      const visible = scanner.write(text) + scanner.finish();
      // A full conclusion replaces the incremental answer, including any suffix
      // still waiting for marker disambiguation. Do not append that suffix twice.
      this.scanner.reset();
      this.lastAnswer = undefined;
      this.visibleChars = visible.length;
      this.ended = true;
      return replaceText(update, visible, keys, this.visibleChars);
    }

    const done = contentRecord(content) && content.done === true;
    if (!this.ended && keys.length > 1 && contentRecord(content) && content[keys[0]] !== content[keys[1]]) {
      // The transport supplied two different deltas. Do not guess which one
      // drives framing; abandon incremental projection until the full answer.
      this.scanner.reset();
      this.lastAnswer = undefined;
      this.lastKeys = [];
      this.incrementalSuppression = 'conflicting_text_aliases';
      this.ended = true;
    }
    if (this.ended) {
      return done ? replaceText(update, '', keys, this.visibleChars) : undefined;
    }
    if (typeof content !== 'string' && keys.length === 0 && !done) return update;
    // Retain only the envelope needed to flush a withheld prefix, never its raw
    // token: a single SDK token can contain the entire machine declaration.
    this.lastAnswer = replaceText(update, '', keys, 0);
    this.lastKeys = keys;
    let visible = this.scanner.write(text);
    if (done) {
      visible += this.scanner.finish();
      this.ended = true;
    }
    this.visibleChars += visible.length;
    if (!visible && !done) return undefined;
    return replaceText(update, visible, keys.length ? keys : ['token'], this.visibleChars);
  }

  /** Flush an unfinished ordinary prefix; does not create a completion event. */
  finish(): StreamingUpdate | undefined {
    if (this.ended) return undefined;
    this.ended = true;
    const visible = this.scanner.finish();
    this.visibleChars += visible.length;
    if (!visible || !this.lastAnswer) return undefined;
    const tail = replaceText(this.lastAnswer, visible, this.lastKeys, this.visibleChars);
    // This is a new projection event. Reusing the last SDK event ID would make
    // reconnect/deduplication consumers discard the withheld suffix.
    delete tail.id;
    return tail;
  }

  /** Cancellation/disposal discards pending text and all state from this run. */
  reset(): void {
    this.scanner.reset();
    this.lastAnswer = undefined;
    this.lastKeys = [];
    this.visibleChars = 0;
    this.ended = false;
    this.incrementalSuppression = undefined;
  }
}
