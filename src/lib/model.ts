export const PPQ = 960;
export const MAX_TICK = 0x0fffffff;
export const DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

export interface Settings {
  tempo: number;
  numerator: number;
  denominator: number;
  channel: number;
}

export interface MidiRow {
  id: string;
  tick: number;
  type: 'cc' | 'pc';
  controller: number;
  value: number;
}

export interface Project {
  name: string;
  settings: Settings;
  rows: MidiRow[];
}

export const DEFAULT_SETTINGS: Settings = {
  tempo: 120,
  numerator: 4,
  denominator: 4,
  channel: 1,
};

export function newId(): string {
  return crypto.randomUUID();
}

export function sortRows(rows: MidiRow[]): MidiRow[] {
  return [...rows].sort((a, b) => a.tick - b.tick);
}

export function validateSettings(settings: Settings): void {
  if (!Number.isFinite(settings.tempo) || settings.tempo < 4 || settings.tempo > 999) {
    throw new Error('Tempo must be between 4 and 999 BPM.');
  }
  if (!Number.isInteger(settings.numerator) || settings.numerator < 1 || settings.numerator > 32) {
    throw new Error('Time signature numerator must be between 1 and 32.');
  }
  if (!DENOMINATORS.some((value) => value === settings.denominator)) {
    throw new Error('Time signature denominator must be 1, 2, 4, 8, 16, or 32.');
  }
  if (!Number.isInteger(settings.channel) || settings.channel < 1 || settings.channel > 16) {
    throw new Error('MIDI channel must be between 1 and 16.');
  }
}

export function validateRows(rows: MidiRow[]): void {
  for (const row of rows) {
    if (!Number.isInteger(row.tick) || row.tick < 0 || row.tick > MAX_TICK) {
      throw new Error(`Message time must be between 0 and ${MAX_TICK} ticks.`);
    }
    if (row.type !== 'cc' && row.type !== 'pc') {
      throw new Error('Only CC and PC messages are supported.');
    }
    if (!Number.isInteger(row.controller) || row.controller < 0 || row.controller > 127
      || !Number.isInteger(row.value) || row.value < 0 || row.value > 127) {
      throw new Error('Controller, value, and program numbers must be integers from 0 to 127.');
    }
  }
}
