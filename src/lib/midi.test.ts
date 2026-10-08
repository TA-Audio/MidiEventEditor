import { describe, expect, it } from 'vitest';
import { exportMidi, importMidi } from './midi';
import { DEFAULT_SETTINGS, MAX_TICK, PPQ, type MidiRow, type Project } from './model';

const eot = [0, 0xff, 0x2f, 0];
const tempo = [0, 0xff, 0x51, 3, 7, 0xa1, 0x20];
const signature = [0, 0xff, 0x58, 4, 7, 3, 24, 8];
const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (tag: string, bytes: number[]) => [...Array.from(tag, (c) => c.charCodeAt(0)), ...u32(bytes.length), ...bytes];
const smf = (tracks: number[][], division = PPQ, format = tracks.length === 1 ? 0 : 1) => new Uint8Array([
  ...chunk('MThd', [0, format, tracks.length >>> 8, tracks.length & 255, division >>> 8, division & 255]),
  ...tracks.flatMap((track) => chunk('MTrk', track)),
]);
const row = (tick: number, type: 'cc' | 'pc', value: number, controller = 0): MidiRow => ({ id: `${tick}-${type}-${value}`, tick, type, value, controller });
const project = (rows: MidiRow[] = []): Project => ({ name: 'Test', settings: { ...DEFAULT_SETTINGS }, rows });
const messages = (rows: MidiRow[]) => rows.map(({ id: _id, ...message }) => message);

describe('MIDI export', () => {
  it('writes format 0, PPQ 960, one track, tempo, signature, and EOT', () => {
    const bytes = exportMidi(project());
    expect([...bytes]).toEqual([...smf([[...tempo, 0, 0xff, 0x58, 4, 4, 2, 24, 8, ...eot]])]);
    expect(importMidi(bytes)).toEqual({ settings: DEFAULT_SETTINGS, rows: [], warnings: [] });
  });

  it('roundtrips CC/PC on channel 16 with stable simultaneous order and no mutation', () => {
    const input = project([row(960, 'cc', 100, 74), row(0, 'pc', 127), row(960, 'pc', 0), row(960, 'cc', 0, 127)]);
    input.settings = { tempo: 120, numerator: 7, denominator: 8, channel: 16 };
    const before = structuredClone(input);
    const bytes = exportMidi(input);
    const output = importMidi(bytes);
    expect(output.settings).toEqual(input.settings);
    expect(messages(output.rows)).toEqual(messages([input.rows[1]!, input.rows[0]!, input.rows[2]!, input.rows[3]!]));
    expect(output.warnings).toEqual([]);
    expect(new Set(output.rows.map((r) => r.id)).size).toBe(4);
    expect(input).toEqual(before);
    expect([...bytes]).toContain(0xbf);
    expect([...bytes]).toContain(0xcf);
  });

  it('uses value as program number, not controller', () => {
    expect(importMidi(exportMidi(project([row(0, 'pc', 42, 99)]))).rows[0]).toMatchObject({ type: 'pc', controller: 0, value: 42 });
  });

  it.each([0, 127, 128, 16383, 16384, 2097151, 2097152, MAX_TICK])('roundtrips VLQ boundary %i', (tick) => {
    expect(importMidi(exportMidi(project([row(tick, 'cc', 1)]))).rows[0]!.tick).toBe(tick);
  });

  it.each([4, 60, 120, 137.25, 999])('keeps tempo %s within SMF quantization accuracy', (bpm) => {
    const input = project();
    input.settings.tempo = bpm;
    expect(importMidi(exportMidi(input)).settings.tempo).toBeCloseTo(bpm, 1);
  });

  it.each([1, 2, 4, 8, 16, 32])('roundtrips denominator %i', (denominator) => {
    const input = project();
    input.settings = { ...input.settings, numerator: 32, denominator };
    expect(importMidi(exportMidi(input)).settings).toEqual(input.settings);
  });

  it.each([
    { tempo: NaN }, { tempo: 3 }, { tempo: 1000 }, { numerator: 0 }, { denominator: 3 }, { channel: 0 }, { channel: 17 },
  ])('rejects invalid export settings %j', (settings) => {
    const input = project();
    Object.assign(input.settings, settings);
    expect(() => exportMidi(input)).toThrow();
  });

  it.each([
    { tick: -1 }, { tick: MAX_TICK + 1 }, { tick: 0.5 }, { value: 128 }, { value: -1 }, { controller: 128 }, { type: 'note' },
  ])('rejects invalid export row %j', (patch) => {
    const input = project([Object.assign(row(0, 'cc', 0), patch) as MidiRow]);
    expect(() => exportMidi(input)).toThrow();
  });
});

describe('MIDI import', () => {
  it('supports CC and one-byte PC running status', () => {
    const result = importMidi(smf([[0, 0xb2, 1, 2, 10, 3, 4, 0, 0xc2, 42, 10, 43, ...eot]]));
    expect(result.settings.channel).toBe(3);
    expect(messages(result.rows)).toEqual(messages([row(0, 'cc', 2, 1), row(10, 'cc', 4, 3), row(10, 'pc', 42), row(20, 'pc', 43)]));
  });

  it('merges format 1 tracks chronologically with track-order ties', () => {
    const result = importMidi(smf([
      [20, 0xb3, 1, 2, 0, 0xc3, 5, ...eot],
      [10, 0xc3, 3, 10, 0xb3, 1, 4, ...eot],
    ]));
    expect(messages(result.rows)).toEqual(messages([row(10, 'pc', 3), row(20, 'cc', 2, 1), row(20, 'pc', 5), row(20, 'cc', 4, 1)]));
  });

  it('selects earliest metadata/channel rather than first parsed track', () => {
    const result = importMidi(smf([
      [20, ...tempo.slice(1), 0, ...signature.slice(1), 0, 0xb0, 1, 2, ...eot],
      [0, 0xff, 0x51, 3, 15, 0x42, 0x40, 0, 0xff, 0x58, 4, 3, 2, 24, 8, 10, 0xcF, 5, ...eot],
    ]));
    expect(result.settings).toEqual({ tempo: 60, numerator: 3, denominator: 4, channel: 16 });
    expect(result.warnings.join(' ')).toMatch(/Tempo changes/);
    expect(result.warnings.join(' ')).toMatch(/Time signature changes/);
    expect(result.warnings.join(' ')).toMatch(/Multiple MIDI channels/);
  });

  it('does not warn on identical repeated metadata', () => {
    expect(importMidi(smf([[...tempo, ...tempo, ...signature, ...signature, ...eot]])).warnings).toEqual([]);
  });

  it('applies late first metadata globally with warnings', () => {
    const result = importMidi(smf([[10, ...tempo.slice(1), 10, ...signature.slice(1), ...eot]]));
    expect(result.settings).toEqual({ ...DEFAULT_SETTINGS, numerator: 7, denominator: 8 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.includes('after tick 0'))).toBe(true);
  });

  it.each([[480, 240, 480], [1920, 1, 1], [1000, 2, 2], [32767, 127, 4]])('normalizes PPQ %i', (division, sourceTick, expected) => {
    const delta = sourceTick! < 128 ? [sourceTick!] : [0x81, 0x70];
    expect(importMidi(smf([[...delta, 0xc0, 1, ...eot]], division)).rows[0]!.tick).toBe(expected);
  });

  it('rounds absolute time, not individual deltas', () => {
    expect(importMidi(smf([[1, 0xc0, 1, 1, 2, 1, 3, ...eot]], 1920)).rows.map((r) => r.tick)).toEqual([1, 1, 2]);
  });

  it('ignores notes, pressure, pitch bend, text and sysex without losing time', () => {
    const result = importMidi(smf([[
      0, 0x9f, 60, 100, 1, 61, 0, 1, 0x8f, 60, 0,
      1, 0xa0, 60, 20, 1, 0xd0, 30, 1, 0xe0, 0, 64,
      1, 0xff, 1, 3, 65, 66, 67, 1, 0xf0, 3, 1, 2, 0xf7,
      1, 0xf7, 2, 0x90, 0xff, 1, 0xc1, 50, ...eot,
    ]]));
    expect(messages(result.rows)).toEqual(messages([row(9, 'pc', 50)]));
    expect(result.settings.channel).toBe(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(' ')).toMatch(/Note events/);
    expect(result.warnings.join(' ')).toMatch(/Unsupported MIDI events/);
  });

  it('accepts header extensions, unknown chunks and Uint8Array offsets', () => {
    const bytes = new Uint8Array([
      99, ...chunk('MThd', [0, 0, 0, 1, 3, 192, 99, 99]), ...chunk('JUNK', [1, 2]),
      ...chunk('MTrk', [0, 0xc0, 7, ...eot]), 99,
    ]);
    const result = importMidi(bytes.subarray(1, bytes.length - 1));
    expect(result.rows[0]!.value).toBe(7);
    expect(result.warnings.join()).toMatch(/Unknown MIDI chunk/);
  });
});

describe('malformed and unsupported MIDI', () => {
  it('rejects every truncation of an exported file', () => {
    const bytes = exportMidi(project([row(128, 'cc', 64, 74), row(MAX_TICK, 'pc', 42)]));
    for (let length = 0; length < bytes.length; length++) {
      expect(() => importMidi(bytes.subarray(0, length)), `prefix length ${length}`).toThrow();
    }
  });

  it.each([
    [0, 1, 2, ...eot],
    [0, 0xb0, 128, 0, ...eot],
    [0, 0xb0, 0, 255, ...eot],
    [0, 0xc0, 128, ...eot],
    [0, 0x90, 60, 128, ...eot],
    [0, 0xc0],
    [0, 0xb0, 1],
    [0x80],
    [0x81, 0x80, 0x80, 0x80, 0, 0xc0, 1, ...eot],
    [0, 0xff, 1, 0x80, 0x80, 0x80, 0x80, 0, ...eot],
    [0, 0xf0, 0x80, 0x80, 0x80, 0x80, 0, ...eot],
    [0, 0xff, 1, 127, ...eot],
    [0, 0xf0, 127, ...eot],
    [0, 0xff, 128, 0, ...eot],
    [0, 0xff, 0x51, 2, 1, 2, ...eot],
    [0, 0xff, 0x58, 3, 4, 2, 24, ...eot],
    [0, 0xff, 0x2f, 1, 0],
    [0, 0xc0, 1],
    [...eot, 0, 0xc0, 1],
    [],
  ])('rejects invalid event stream %j', (...track) => {
    expect(() => importMidi(smf([track]))).toThrow();
  });

  it.each([0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf8, 0xfa, 0xfb, 0xfc, 0xfe])('rejects non-SMF status %i', (status) => {
    expect(() => importMidi(smf([[0, status, 0, 0, ...eot]]))).toThrow(/status/);
  });

  it.each([[...tempo], [0, 0xf0, 1, 0xf7], [0, 0xf7, 0]])('clears running status after meta/sysex %j', (...event) => {
    expect(() => importMidi(smf([[0, 0xc0, 1, ...event, 0, 2, ...eot]]))).toThrow(/running status/);
  });

  it.each([2, 3])('rejects format %i', (format) => {
    expect(() => importMidi(smf([[...eot]], PPQ, format))).toThrow(/format/);
  });

  it.each([0x8000, 0xe728])('rejects SMPTE division %i', (division) => {
    expect(() => importMidi(smf([[...eot]], division))).toThrow(/SMPTE/);
  });

  it('rejects zero division, missing/extra tracks, invalid header and trailing garbage', () => {
    expect(() => importMidi(smf([[...eot]], 0))).toThrow(/division/);
    expect(() => importMidi(smf([]))).toThrow(/track count/);
    expect(() => importMidi(smf([[...eot], [...eot]], PPQ, 0))).toThrow(/track count/);
    const bytes = smf([[...eot]]);
    bytes[11] = 2;
    bytes[9] = 1;
    expect(() => importMidi(bytes)).toThrow(/track count/);
    const extra = smf([[...eot], [...eot]]);
    extra[11] = 1;
    expect(() => importMidi(extra)).toThrow(/more tracks/);
    expect(() => importMidi(new Uint8Array(chunk('NOPE', [])))).toThrow(/header/);
    expect(() => importMidi(new Uint8Array(chunk('MThd', [0, 0])))).toThrow(/header length/);
    expect(() => importMidi(new Uint8Array([...smf([[...eot]]), 1]))).toThrow();
  });

  it('rejects oversized chunk lengths without allocating', () => {
    const bytes = smf([[...eot]]);
    bytes.set([255, 255, 255, 255], 18);
    expect(() => importMidi(bytes)).toThrow(/length/);
    bytes.set([255, 255, 255, 255], 4);
    expect(() => importMidi(bytes)).toThrow(/length/);
  });

  it.each([
    [0, 0xff, 0x51, 3, 0, 0, 0],
    [0, 0xff, 0x51, 3, 0, 0, 1],
    [0, 0xff, 0x51, 3, 255, 255, 255],
    [0, 0xff, 0x58, 4, 0, 2, 24, 8],
    [0, 0xff, 0x58, 4, 33, 2, 24, 8],
    [0, 0xff, 0x58, 4, 4, 6, 24, 8],
    [0, 0xff, 0x58, 4, 4, 255, 24, 8],
  ])('rejects unsupported metadata ranges even after valid metadata %j', (...event) => {
    expect(() => importMidi(smf([[...tempo, ...signature, ...event, ...eot]]))).toThrow();
  });

  it('rejects accumulated and PPQ-scaled tick overflow, including ignored events and EOT', () => {
    const maxDelta = [255, 255, 255, 127];
    expect(() => importMidi(smf([[...maxDelta, 0xc0, 1, 1, 0xc0, 2, ...eot]]))).toThrow(/range/);
    expect(() => importMidi(smf([[...maxDelta, 0x90, 60, 0, ...eot]], 480))).toThrow(/range/);
    expect(() => importMidi(smf([[...maxDelta, 0xc0, 1, 1, 0xff, 0x2f, 0]]))).toThrow(/range/);
  });
});
