import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_TICK } from './model';
import type { MidiRow } from './model';
import { barTicks, createRowGroup, formatTime, inferStep, insertionTick, moveRows, parseProject, parseRowGroups, parseTime, pasteRows, retimeRow, rowsFromTsv, rowsToTsv, serializeProject } from './editor';

const s = DEFAULT_SETTINGS;
const rows = (ticks: number[]): MidiRow[] => ticks.map((tick, i) => ({ id: String(i), tick, type: 'cc', controller: 11, value: 64 }));

describe('musical timing', () => {
  it('roundtrips 1-based bars and beats, including non-quarter signatures', () => {
    for (const denominator of [1, 2, 4, 8, 16, 32]) {
      const settings = { ...s, numerator: 7, denominator };
      for (const tick of [0, 119, 960, 3840, 15001, MAX_TICK]) {
        expect(parseTime(formatTime(tick, settings), settings)).toBe(tick);
      }
    }
    expect(barTicks({ ...s, numerator: 6, denominator: 8 })).toBe(2880);
    expect(formatTime(3840, s)).toBe('2:1:000');
  });
  it('rejects invalid and out of range times', () => {
    for (const text of ['0:1:000', '1:5:000', '1:1:960', '-1:1:0', '1.5:1:0', '1:1', '999999999999:1:0']) {
      expect(() => parseTime(text, s)).toThrow();
    }
  });
});

describe('intelligent insertion and paste', () => {
  it('continues four consecutive bars on the next bar', () => {
    const source = rows([0, 3840, 7680, 11520]);
    expect(inferStep(source, 11520, s)).toBe(3840);
    expect(insertionTick(source, '3', s)).toBe(15360);
    expect(pasteRows(source, [source[3]], '3', s)[0].tick).toBe(15360);
    expect(pasteRows(source, source, '3', s).map((r) => r.tick)).toEqual([15360, 19200, 23040, 26880]);
  });
  it('ignores simultaneous messages and learns the recent pattern', () => {
    expect(inferStep(rows([0, 0, 3840, 7680, 11520]), 11520, s)).toBe(3840);
    expect(inferStep(rows([0, 100, 200, 210, 220, 230, 240]), 240, s)).toBe(10);
    expect(inferStep(rows([0, 960, 1440]), 1440, s)).toBe(480);
  });
  it('inserts between existing rows without moving them', () => {
    const source = rows([0, 3840, 7680]);
    expect(insertionTick(source, '0', s)).toBe(1920);
    expect(insertionTick(rows([0, 1]), '0', s)).toBe(0);
    expect(source.map((r) => r.tick)).toEqual([0, 3840, 7680]);
  });
  it('preserves multi-row relative timing and creates new identities', () => {
    const source = rows([960, 960, 2880]);
    const pasted = pasteRows([], source, undefined, s);
    expect(pasted.map((r) => r.tick)).toEqual([0, 0, 1920]);
    expect(pasted.every((r) => !source.some((original) => original.id === r.id))).toBe(true);
  });
  it('uses a bar by default and rejects overflow', () => {
    expect(insertionTick([], undefined, s)).toBe(0);
    expect(insertionTick(rows([0]), '0', s)).toBe(3840);
    expect(() => insertionTick(rows([MAX_TICK]), '0', s)).toThrow();
    expect(() => pasteRows(rows([MAX_TICK]), rows([0]), '0', s)).toThrow();
    expect(() => pasteRows([], [], undefined, s)).toThrow();
  });
});

describe('row movement and clipboard', () => {
  it('retimes the first message and preserves every relative offset and identity', () => {
    const source = rows([960, 960, 1500, 3840]);
    source[0].type = 'pc';
    const shifted = retimeRow(source, '0', 4800);
    expect(shifted).toEqual(source.map((row) => ({ ...row, tick: row.tick + 3840 })));
    expect(retimeRow(shifted, '0', 0)).toEqual(source.map((row) => ({ ...row, tick: row.tick - 960 })));
    expect(source.map((row) => row.tick)).toEqual([960, 960, 1500, 3840]);
    expect(retimeRow(rows([0]), '0', 960)[0].tick).toBe(960);
  });
  it('keeps later message edits independent, including simultaneous messages', () => {
    const source = rows([0, 0, 3840]);
    expect(retimeRow(source, '1', 960).map((row) => row.tick)).toEqual([0, 960, 3840]);
    expect(retimeRow(source, '2', 7680).map((row) => row.tick)).toEqual([0, 0, 7680]);
  });
  it('rejects sequence overflow atomically even when the new first time is valid', () => {
    const source = rows([0, MAX_TICK]);
    expect(() => retimeRow(source, '0', 1)).toThrow();
    expect(() => retimeRow(source, '0', -1)).toThrow();
    expect(source.map((row) => row.tick)).toEqual([0, MAX_TICK]);
  });
  it('moves a group by one delta and leaves other rows alone', () => {
    const moved = moveRows(rows([0, 3840, 7680]), new Set(['1', '2']), -960);
    expect(moved.map((r) => r.tick)).toEqual([0, 2880, 6720]);
    expect(() => moveRows(rows([0]), new Set(['0']), -1)).toThrow();
    expect(() => moveRows(rows([MAX_TICK]), new Set(['0']), 1)).toThrow();
  });
  it('roundtrips CC/PC TSV with simultaneous events', () => {
    const source = rows([0, 3840]);
    source[0].type = 'pc';
    source[0].controller = 0;
    expect(rowsFromTsv(rowsToTsv(source, s), s).map(({ id: _id, ...r }) => r))
      .toEqual(source.map(({ id: _id, ...r }) => r));
  });
  it('rejects malformed clipboard data without partial paste', () => {
    for (const text of ['', 'hello', '1:1:000\tNOTE\t11\t1', '1:1:000\tCC\t128\t1',
      '1:1:000\tCC\t11\t', '1:1:000\tPC\t-\t1.2']) {
      expect(() => rowsFromTsv(text, s)).toThrow();
    }
  });
});

describe('saved row groups', () => {
  it('saves independent sorted snapshots with relative timing and simultaneous messages', () => {
    const source = rows([2880, 960, 960]);
    source[1].type = 'pc';
    const group = createRowGroup('  Intro  ', source);
    expect(group.name).toBe('Intro');
    expect(group.rows.map((row) => row.tick)).toEqual([0, 0, 1920]);
    expect(group.rows.map((row) => row.type)).toEqual(['pc', 'cc', 'cc']);
    source[1].value = 0;
    expect(group.rows[0].value).toBe(64);
    expect(group.rows.every((row) => !source.some((original) => original.id === row.id))).toBe(true);
  });
  it('restores groups and inserts every row with fresh identities on each use', () => {
    const group = createRowGroup('Intro', rows([960, 960, 2880]));
    const [restored] = parseRowGroups(JSON.stringify({ version: 1, groups: [group] }));
    expect(restored.name).toBe('Intro');
    expect(restored.rows.map(({ id: _id, ...row }) => row)).toEqual(group.rows.map(({ id: _id, ...row }) => row));
    const target = rows([0, 3840]);
    const first = pasteRows(target, restored.rows, '1', s);
    const second = pasteRows(target, restored.rows, '1', s);
    expect(first.map((row) => row.tick)).toEqual([7680, 7680, 9600]);
    expect(new Set([...group.rows, ...restored.rows, ...first, ...second].map((row) => row.id)).size).toBe(12);
    expect(pasteRows([], restored.rows, undefined, s).map((row) => row.tick)).toEqual([0, 0, 1920]);
  });
  it('rejects invalid groups and malformed storage without partial restoration', () => {
    expect(() => createRowGroup(' ', rows([0]))).toThrow();
    expect(() => createRowGroup('a'.repeat(121), rows([0]))).toThrow();
    expect(() => createRowGroup('Empty', [])).toThrow();
    expect(() => createRowGroup('Too many', rows(Array(10001).fill(0)))).toThrow();
    expect(() => createRowGroup('Invalid', rows([-1]))).toThrow();
    expect(parseRowGroups('{"version":1,"groups":[]}')).toEqual([]);
    for (const invalid of [null, {}, { version: 2, groups: [] }, { version: 1, groups: [null] },
      { version: 1, groups: [{ name: 'Bad', rows: [{ tick: 0 }] }] },
      { version: 1, groups: [{ name: 'Bad', rows: rows([MAX_TICK + 1]) }] }]) {
      expect(() => parseRowGroups(JSON.stringify(invalid))).toThrow();
    }
  });
});

describe('project persistence validation', () => {
  it('roundtrips project data', () => {
    const project = { name: 'Test', settings: s, rows: rows([0, 3840]) };
    const restored = parseProject(serializeProject(project));
    expect(restored.name).toBe('Test');
    expect(restored.settings).toEqual(s);
    expect(restored.rows.map((r) => r.tick)).toEqual([0, 3840]);
  });
  it('rejects invalid settings and messages', () => {
    expect(() => parseProject('{}')).toThrow();
    expect(() => parseProject(serializeProject({ name: 'Bad', settings: { ...s, channel: 17 }, rows: [] }))).toThrow();
    expect(() => parseProject(serializeProject({ name: 'Bad', settings: s, rows: rows([-1]) }))).toThrow();
  });
});
