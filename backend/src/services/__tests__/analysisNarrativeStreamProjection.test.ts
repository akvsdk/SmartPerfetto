// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  ConclusionSidecarFramingScanner,
  parseConclusionContractSidecar,
  renderConclusionContractSidecar,
  type ConclusionContract,
} from '../../agent/core/conclusionContract';
import type {StreamingUpdate} from '../../agent/types';
import {AnalysisNarrativeStreamProjection} from '../analysisNarrativeStreamProjection';

const contract: ConclusionContract = {
  schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
  conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: [],
};
const marker = renderConclusionContractSidecar(contract);
const prefix = '<!-- smartperfetto:conclusion-contract@';

function update(content: unknown, type: StreamingUpdate['type'] = 'answer_token'): StreamingUpdate {
  return {type, content, timestamp: 1234, id: 'transport-event'};
}

function text(event: StreamingUpdate | undefined): string {
  if (!event) return '';
  if (typeof event.content === 'string') return event.content;
  return event.content.token ?? event.content.delta ?? event.content.conclusion ?? '';
}

function project(chunks: string[]): string {
  const projection = new AnalysisNarrativeStreamProjection();
  return chunks.map(chunk => text(projection.project(update({token: chunk})))).join('') + text(projection.finish());
}

describe('sidecar narrative framing', () => {
  const ordinaryExamples = [
    'First token, with no newline or final punctuation',
    '<function_calls><invoke name="execute_sql">ordinary XML</invoke></function_calls>',
    '<｜DSML｜function_calls>ordinary DSML</｜DSML｜function_calls>',
    '````text\n' + marker + '\n````',
    `~~~example\n${marker}\n~~~`,
    marker.split('\n').map(line => `> ${line}`).join('\n'),
    marker.split('\n').map(line => `    ${line}`).join('\n'),
    `<!-- example\n${marker}\n-->`,
    JSON.stringify({example: marker}),
    `"${prefix}1"`,
    `Inline ${prefix}1 example`,
    ` ${prefix}1\nprivate only when explicit at column zero\n-->`,
    '<!-- smartperfetto:conversation-control {"kind":"answered"} -->',
  ];

  it.each(ordinaryExamples)('preserves ordinary text and quoted/fenced examples: %s', raw => {
    expect(parseConclusionContractSidecar(raw)).toMatchObject({status: 'absent', narrative: raw, machineSegments: []});
    expect(project([...raw])).toBe(raw);
  });

  const framingCases = [
    {raw: `Body\n${marker}\nTail`, narrative: 'Body\n\nTail', status: 'valid'},
    {raw: `😀\r\n${marker.replace(/\n/g, '\r\n')}\r\n尾`, narrative: '😀\r\n\r\n尾', status: 'valid'},
    {raw: `${marker}\n${marker}`, narrative: '\n', status: 'invalid'},
    {raw: `Body\n${prefix}2\ninvalid version\n-->\nTail`, narrative: 'Body\n\nTail', status: 'invalid'},
    {raw: `Body\n${prefix}`, narrative: 'Body\n', status: 'invalid'},
    {raw: `Body\n${prefix}1\nunterminated`, narrative: 'Body\n', status: 'invalid'},
    {raw: `Body\n${prefix}1\n--> trailing\nnot visible`, narrative: 'Body\n', status: 'invalid'},
    {raw: `Body\n${prefix}1\n-->\r`, narrative: 'Body\n', status: 'invalid'},
    {raw: `Body\n${prefix}1\n -->\nnot visible`, narrative: 'Body\n', status: 'invalid'},
    {raw: `Body\n${prefix}1\ninline --> payload\n-->\nTail`, narrative: 'Body\n\nTail', status: 'invalid'},
    {raw: `Body\n${prefix}1\n${prefix}1\n-->\nTail`, narrative: 'Body\n\nTail', status: 'invalid'},
    {raw: `<!-- ordinary -->\n${marker}`, narrative: '<!-- ordinary -->\n', status: 'valid'},
    {raw: '```info`\n' + marker, narrative: '```info`\n', status: 'valid'},
    {raw: `~~~has\rbare CR\n${marker}`, narrative: '~~~has\rbare CR\n', status: 'valid'},
    {raw: `~~~has\u2028separator\n${marker}`, narrative: '~~~has\u2028separator\n', status: 'valid'},
    {raw: `~~~has\u2029separator\n${marker}`, narrative: '~~~has\u2029separator\n', status: 'valid'},
  ] as const;

  it.each(framingCases)('retains exact final-parser framing at every token boundary: $raw', ({raw, narrative, status}) => {
    const parsed = parseConclusionContractSidecar(raw);
    expect(parsed.narrative).toBe(narrative);
    expect(parsed.status).toBe(status);
    for (let split = 0; split <= raw.length; split++) {
      expect(project([raw.slice(0, split), raw.slice(split)])).toBe(narrative);
    }
    expect(project(raw.split(''))).toBe(narrative);
  });

  it('preserves UTF-16 segment offsets, CRLF boundaries and duplicate eligibility', () => {
    const first = marker.replace(/\n/g, '\r\n');
    const raw = `前😀\r\n${first}\r\n中\n${marker}\n尾`;
    const firstStart = '前😀\r\n'.length;
    const secondStart = firstStart + first.length + '\r\n中\n'.length;
    expect(parseConclusionContractSidecar(raw)).toMatchObject({
      status: 'invalid', bindingEligibility: 'ineligible', narrative: '前😀\r\n\r\n中\n\n尾',
      issues: [{code: 'duplicate_marker', path: '$'}],
      machineSegments: [{start: firstStart, end: firstStart + first.length},
        {start: secondStart, end: secondStart + marker.length}],
    });
    const interrupted = `Before\n${prefix}1\n${'x'.repeat(100)}`;
    expect(parseConclusionContractSidecar(interrupted).machineSegments).toEqual([{start: 7, end: interrupted.length}]);
  });

  it('counts a nested marker without splitting its containing machine segment', () => {
    const raw = `${prefix}1\n${marker}\nTail`;
    expect(parseConclusionContractSidecar(raw)).toMatchObject({
      status: 'invalid', narrative: '\nTail', issues: [{code: 'duplicate_marker', path: '$'}],
      machineSegments: [{start: 0, end: raw.length - '\nTail'.length}],
    });
  });

  it('streams ordinary first tokens immediately and withholds only an ambiguous marker prefix', () => {
    const scanner = new ConclusionSidecarFramingScanner();
    expect(scanner.write('First')).toBe('First');
    expect(scanner.write(' token\n<')).toBe(' token\n');
    expect(scanner.bufferedCharacterCount).toBe(1);
    expect(scanner.write('tag>XML')).toBe('<tag>XML');
    expect(scanner.write('\n<!-- smartperfetto:conclusion-')).toBe('\n');
    expect(scanner.write('example')).toBe('<!-- smartperfetto:conclusion-example');
    expect(scanner.finish()).toBe('');
  });

  it('does not wait for an arbitrarily long prose, comment, or fence-opening line', () => {
    const scanner = new ConclusionSidecarFramingScanner();
    const prose = 'n'.repeat(100_000);
    expect(scanner.write(prose)).toBe(prose);
    expect(scanner.write('\n<!-- ordinary ')).toBe('\n<!-- ordinary ');
    expect(scanner.write(prose)).toBe(prose);
    expect(scanner.write(' -->\n```language ')).toBe(' -->\n```language ');
    expect(scanner.write(prose)).toBe(prose);
    // The late backtick invalidates this opening line, as the final parser does.
    expect(scanner.write('`\n' + marker)).toBe('`\n');
    expect(scanner.finish()).toBe('');
  });

  it('discards a large machine payload while keeping marker and terminator state bounded', () => {
    const scanner = new ConclusionSidecarFramingScanner();
    expect(scanner.write(`${prefix}1\n{"machine":"`)).toBe('');
    const block = 'PRIVATE_MACHINE_CANARY'.repeat(5000);
    for (let index = 0; index < 10; index++) {
      expect(scanner.write(block)).toBe('');
      expect(scanner.bufferedCharacterCount).toBe(0);
    }
    expect(scanner.write('"}\n--')).toBe('');
    expect(scanner.write('>\r')).toBe('');
    expect(scanner.write('\nVisible')).toBe('\r\nVisible');
    expect(scanner.finish()).toBe('');
  });

  it('preserves fence lengths without retaining the fence text', () => {
    const fence = '~'.repeat(5000);
    const raw = `${fence}\n~~~\n${marker}\n${fence}\n${marker}`;
    const narrative = `${fence}\n~~~\n${marker}\n${fence}\n`;
    expect(project(raw.split(''))).toBe(narrative);
    expect(parseConclusionContractSidecar(raw)).toMatchObject({narrative, status: 'valid'});
  });
});

describe('analysis narrative StreamingUpdate projection', () => {
  it.each(['string', 'token', 'delta'] as const)('projects %s payloads without mutating raw input', shape => {
    const projection = new AnalysisNarrativeStreamProjection();
    const raw = `Readable\n${marker}\nEnd`;
    const original = update(shape === 'string' ? raw : {[shape]: raw, totalChars: raw.length, custom: 7});
    const before = structuredClone(original);
    const projected = projection.project(original)!;
    expect(text(projected) + text(projection.finish())).toBe('Readable\n\nEnd');
    expect(original).toEqual(before);
    expect(projected).toMatchObject({type: 'answer_token', timestamp: 1234, id: 'transport-event'});
    if (shape !== 'string') expect(projected.content).toMatchObject({totalChars: 'Readable\n\nEnd'.length, custom: 7});
  });

  it('projects both token aliases so neither exposes the machine payload', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    const projected = projection.project(update({token: `Body\n${marker}`, delta: `Body\n${marker}`}))!;
    expect(projected.content).toEqual({token: 'Body\n', delta: 'Body\n'});
    expect(projection.suppressionReason).toBeUndefined();
  });

  it.each([
    {token: 'A', delta: 'B'},
    {token: '', delta: 'B'},
    {token: 'A', delta: ''},
  ])('abandons ambiguous incremental aliases without choosing either text: %j', aliases => {
    const projection = new AnalysisNarrativeStreamProjection();
    expect(text(projection.project(update({token: 'Body\n<!'})))).toBe('Body\n');
    const original = update(aliases);
    const before = structuredClone(original);
    expect(projection.project(original)).toBeUndefined();
    expect(original).toEqual(before);
    expect(projection.suppressionReason).toBe('conflicting_text_aliases');
    expect(projection.project(update({token: 'Later text'}))).toBeUndefined();
    expect(projection.finish()).toBeUndefined();
    expect(projection.project(update({done: true, totalChars: 999}))?.content).toEqual({done: true, totalChars: 5});

    const raw = `Final\n${marker}\nText`;
    const final = update({conclusion: raw, totalChars: raw.length}, 'conclusion');
    expect(projection.project(final)?.content).toEqual({conclusion: 'Final\n\nText', totalChars: 11});
    expect(final.content.conclusion).toBe(raw);
    expect(projection.finish()).toBeUndefined();
    projection.reset();
    expect(projection.suppressionReason).toBeUndefined();
    expect(text(projection.project(update('New run')))).toBe('New run');
  });

  it('preserves done metadata while suppressing conflicting aliases on the done event', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    projection.project(update({token: 'Body\n<!'}));
    const original = update({token: 'A', delta: 'B', done: true, totalChars: 999});
    expect(projection.project(original)?.content).toEqual({token: '', delta: '', done: true, totalChars: 5});
    expect(original.content).toEqual({token: 'A', delta: 'B', done: true, totalChars: 999});
    expect(projection.finish()).toBeUndefined();
  });

  it('keeps done events and counts only visible text, including a flushed ordinary prefix', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    expect(text(projection.project(update({delta: 'Body\n<!'})))).toBe('Body\n');
    const done = update({done: true, totalChars: 100});
    expect(projection.project(done)?.content).toEqual({done: true, totalChars: 7, token: '<!'});
    expect(done.content).toEqual({done: true, totalChars: 100});
    expect(projection.finish()).toBeUndefined();
    expect(projection.project(update({token: 'late'}))).toBeUndefined();
  });

  it('flushes a pending ordinary prefix without manufacturing completion', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    expect(projection.project(update({delta: '<!-- smartperfetto:'}))).toBeUndefined();
    expect(projection.finish()).toEqual({type: 'answer_token', content: {delta: '<!-- smartperfetto:'}, timestamp: 1234});
    expect(projection.finish()).toBeUndefined();
  });

  it('does not reuse a delivered event ID for the synthetic suffix flush', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    const original = update({token: 'Body\n<'});
    expect(projection.project(original)).toEqual(update({token: 'Body\n'}));
    const tail = projection.finish()!;
    expect(tail.content).toEqual({token: '<'});
    expect(tail).not.toHaveProperty('id');
    expect(tail.content).not.toHaveProperty('done');
    expect(original.id).toBe('transport-event');
  });

  it('discards an interrupted machine payload on done, without a completion/error decision', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    expect(text(projection.project(update(`Body\n${prefix}1\nPRIVATE`)))).toBe('Body\n');
    expect(projection.project(update({done: true, totalChars: 999}))?.content)
      .toEqual({done: true, totalChars: 5, token: ''});
  });

  it.each(['string', 'object'] as const)('projects the authoritative %s conclusion independently of partial tokens', shape => {
    const projection = new AnalysisNarrativeStreamProjection();
    projection.project(update({token: `Earlier\n${prefix}1\nPARTIAL`}));
    const raw = `Final\n${marker}\nText`;
    const original = update(shape === 'string' ? raw : {conclusion: raw, totalChars: raw.length, turns: 1}, 'conclusion');
    const before = structuredClone(original);
    expect(text(projection.project(original))).toBe('Final\n\nText');
    expect(original).toEqual(before);
    expect(projection.finish()).toBeUndefined();
    expect(projection.project(update({done: true, totalChars: 999}))?.content).toEqual({done: true, totalChars: 11});
  });

  it('passes raw data, tool updates and errors through without changing their authority', () => {
    const projection = new AnalysisNarrativeStreamProjection();
    for (const type of ['data', 'tool_call', 'error', 'progress'] as const) {
      const original = update({raw: marker}, type);
      expect(projection.project(original)).toBe(original);
    }
  });

  it.each([prefix.slice(0, -3), `${prefix}1\nPRIVATE`, '```example\n', '<!-- ordinary\n'])(
    'reset abandons a cancelled run and clears prefix, machine, fence and comment state: %s', partial => {
      const projection = new AnalysisNarrativeStreamProjection();
      projection.project(update({token: partial}));
      projection.reset();
      expect(text(projection.project(update(`New\n${marker}\nVisible`)))).toBe('New\n\nVisible');
      expect(projection.finish()).toBeUndefined();
    },
  );
});
