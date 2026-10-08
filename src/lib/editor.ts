import { DEFAULT_SETTINGS, MAX_TICK, PPQ, newId, sortRows, validateRows, validateSettings } from './model';
import type { MidiRow, Project, Settings } from './model';

export function beatTicks(settings: Settings): number {
  return PPQ * 4 / settings.denominator;
}

export function barTicks(settings: Settings): number {
  return beatTicks(settings) * settings.numerator;
}

export function formatTime(tick: number, settings: Settings): string {
  const bar = barTicks(settings);
  const beat = beatTicks(settings);
  return `${Math.floor(tick / bar) + 1}:${Math.floor((tick % bar) / beat) + 1}:${String(tick % beat).padStart(3, '0')}`;
}

export function parseTime(text: string, settings: Settings): number {
  const match = /^(\d+):(\d+):(\d+)$/.exec(text.trim());
  if (!match) throw new Error('Use bar:beat:tick, for example 2:1:000.');
  const [, barText, beatText, tickText] = match;
  const [bar, beat, tick] = [Number(barText), Number(beatText), Number(tickText)];
  if (bar < 1 || beat < 1 || beat > settings.numerator || tick >= beatTicks(settings)) {
    throw new Error(`Bars start at 1; beats are 1-${settings.numerator}; ticks are 0-${beatTicks(settings) - 1}.`);
  }
  const result = (bar - 1) * barTicks(settings) + (beat - 1) * beatTicks(settings) + tick;
  if (!Number.isSafeInteger(result) || result > MAX_TICK) throw new Error('Message time is too large.');
  return result;
}

export function inferStep(rows: MidiRow[], anchorTick: number, settings: Settings): number {
  const times = [...new Set(rows.filter((row) => row.tick <= anchorTick).map((row) => row.tick))]
    .sort((a, b) => a - b).slice(-5);
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  if (!gaps.length) return barTicks(settings);
  const counts = new Map<number, number>();
  for (const gap of gaps) counts.set(gap, (counts.get(gap) ?? 0) + 1);
  // Prefer the most recent interval when equally frequent patterns compete.
  return [...gaps].reverse().sort((a, b) => counts.get(b)! - counts.get(a)!)[0];
}

export function insertionTick(rows: MidiRow[], anchorId: string | undefined, settings: Settings): number {
  const sorted = sortRows(rows);
  const anchor = sorted.find((row) => row.id === anchorId) ?? sorted.at(-1);
  if (!anchor) return 0;
  const step = inferStep(sorted, anchor.tick, settings);
  const next = sorted.find((row) => row.tick > anchor.tick);
  const tick = next && next.tick <= anchor.tick + step
    ? anchor.tick + Math.floor((next.tick - anchor.tick) / 2)
    : anchor.tick + step;
  if (tick > MAX_TICK) throw new Error('Cannot add a message beyond the maximum time.');
  return tick;
}

export function pasteRows(
  rows: MidiRow[], copied: MidiRow[], anchorId: string | undefined, settings: Settings,
): MidiRow[] {
  if (!copied.length) throw new Error('Copy one or more rows first.');
  const source = sortRows(copied);
  const anchor = rows.find((row) => row.id === anchorId) ?? sortRows(rows).at(-1);
  const start = anchor ? anchor.tick + inferStep(rows, anchor.tick, settings) : 0;
  const pasted = source.map((row) => ({ ...row, id: newId(), tick: start + row.tick - source[0].tick }));
  validateRows(pasted);
  return pasted;
}

export function moveRows(rows: MidiRow[], ids: Set<string>, delta: number): MidiRow[] {
  const moved = rows.map((row) => ids.has(row.id) ? { ...row, tick: row.tick + delta } : row);
  validateRows(moved);
  return sortRows(moved);
}

export function retimeRow(rows: MidiRow[], id: string, tick: number): MidiRow[] {
  const sorted = sortRows(rows);
  const target = sorted.find((row) => row.id === id);
  if (!target) throw new Error('Message not found.');
  const ids = new Set(target === sorted[0] ? sorted.map((row) => row.id) : [id]);
  return moveRows(sorted, ids, tick - target.tick);
}

export function rowsToTsv(rows: MidiRow[], settings: Settings): string {
  return ['Time\tType\tCC\tValue', ...sortRows(rows).map((row) =>
    `${formatTime(row.tick, settings)}\t${row.type.toUpperCase()}\t${row.type === 'cc' ? row.controller : '-'}\t${row.value}`,
  )].join('\n');
}

export function rowsFromTsv(text: string, settings: Settings): MidiRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0]?.toLowerCase() === 'time\ttype\tcc\tvalue') lines.shift();
  if (!lines.length || !lines[0]) throw new Error('Clipboard is empty.');
  if (lines.length > 10000) throw new Error('Paste is limited to 10,000 rows at a time.');
  const rows = lines.map((line, index): MidiRow => {
    const parts = line.split('\t');
    if (parts.length !== 4) throw new Error(`Clipboard row ${index + 1}: expected Time, Type, CC, Value separated by tabs.`);
    const [time, kind, cc, value] = parts.map((part) => part.trim());
    const type = kind.toLowerCase();
    if (type !== 'cc' && type !== 'pc') throw new Error(`Clipboard row ${index + 1}: type must be CC or PC.`);
    if (!/^\d+$/.test(value) || (type === 'cc' && !/^\d+$/.test(cc))) {
      throw new Error(`Clipboard row ${index + 1}: CC and value must be integers from 0 to 127.`);
    }
    return { id: newId(), tick: parseTime(time, settings), type, controller: type === 'cc' ? Number(cc) : 0, value: Number(value) };
  });
  validateRows(rows);
  return sortRows(rows);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface RowGroup {
  id: string;
  name: string;
  rows: MidiRow[];
}

export function createRowGroup(name: string, rows: MidiRow[]): RowGroup {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120) throw new Error('Group names must contain 1-120 characters.');
  if (!rows.length) throw new Error('Select one or more rows to save as a group.');
  if (rows.length > 10000) throw new Error('Groups are limited to 10,000 messages.');
  validateRows(rows);
  return { id: newId(), name: trimmed, rows: pasteRows([], rows, undefined, DEFAULT_SETTINGS) };
}

function parseStoredRows(data: unknown): MidiRow[] {
  if (!Array.isArray(data) || data.length > 10000) throw new Error('Expected up to 10,000 messages.');
  const rows = data.map((row): MidiRow => {
    if (!isRecord(row) || typeof row.tick !== 'number' || (row.type !== 'cc' && row.type !== 'pc')
      || typeof row.controller !== 'number' || typeof row.value !== 'number') throw new Error('Invalid saved message.');
    return { id: newId(), tick: row.tick, type: row.type, controller: row.controller, value: row.value };
  });
  validateRows(rows);
  return sortRows(rows);
}

export function parseRowGroups(text: string): RowGroup[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.groups)) {
    throw new Error('Not a supported group library (version 1).');
  }
  return data.groups.map((group) => {
    if (!isRecord(group) || typeof group.name !== 'string') throw new Error('Invalid saved group.');
    return createRowGroup(group.name, parseStoredRows(group.rows));
  });
}

export function parseProject(text: string): Project {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.settings) || !Array.isArray(data.rows)
    || typeof data.name !== 'string') throw new Error('Not a supported Control project (version 1).');
  const s = data.settings;
  if (typeof s.tempo !== 'number' || typeof s.numerator !== 'number'
    || typeof s.denominator !== 'number' || typeof s.channel !== 'number') {
    throw new Error('Project settings are invalid.');
  }
  const settings: Settings = { tempo: s.tempo, numerator: s.numerator, denominator: s.denominator, channel: s.channel };
  validateSettings(settings);
  if (data.rows.length > 10000) throw new Error('Projects are limited to 10,000 messages.');
  return { name: data.name.slice(0, 120), settings, rows: parseStoredRows(data.rows) };
}

export function serializeProject(project: Project): string {
  return JSON.stringify({ version: 1, ...project }, null, 2);
}

export function createDemo(): Project {
  return {
    name: 'Opening sequence',
    settings: { ...DEFAULT_SETTINGS },
    rows: [
      { id: newId(), tick: 0, type: 'pc', controller: 0, value: 12 },
      ...[0, 1, 2, 3].map((bar): MidiRow => ({
        id: newId(), tick: bar * 3840, type: 'cc', controller: 11, value: [32, 56, 88, 112][bar],
      })),
    ],
  };
}

export const CC_NAMES: Record<number, string> = {
  0: 'Bank select', 1: 'Modulation', 2: 'Breath', 4: 'Foot controller', 5: 'Portamento time',
  7: 'Channel volume', 10: 'Pan', 11: 'Expression', 32: 'Bank select LSB', 64: 'Sustain',
  65: 'Portamento', 71: 'Resonance', 74: 'Brightness', 91: 'Reverb', 93: 'Chorus',
  120: 'All sound off', 121: 'Reset controllers', 123: 'All notes off',
};
