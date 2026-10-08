import {
  DEFAULT_SETTINGS, MAX_TICK, PPQ, newId, sortRows, validateRows, validateSettings,
  type MidiRow, type Project, type Settings,
} from './model';

function vlq(value: number): number[] {
  const bytes = [value & 0x7f];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift((value & 0x7f) | 0x80);
  return bytes;
}

/** Export a single-track SMF, preserving the input order of simultaneous messages. */
export function exportMidi(project: Project): Uint8Array {
  validateSettings(project.settings);
  validateRows(project.rows);
  const { tempo, numerator, denominator, channel } = project.settings;
  // Keep quantization at the upper BPM boundary inside the supported range on reimport.
  const micros = Math.max(Math.ceil(60_000_000 / 999), Math.round(60_000_000 / tempo));
  const track = [
    0, 0xff, 0x51, 3, (micros >>> 16) & 255, (micros >>> 8) & 255, micros & 255,
    0, 0xff, 0x58, 4, numerator, Math.log2(denominator), 24, 8,
  ];
  let previous = 0;
  for (const row of sortRows(project.rows)) {
    track.push(...vlq(row.tick - previous));
    if (row.type === 'cc') track.push(0xb0 | (channel - 1), row.controller, row.value);
    else track.push(0xc0 | (channel - 1), row.value);
    previous = row.tick;
  }
  track.push(0, 0xff, 0x2f, 0);
  if (track.length > 0xffffffff) throw new Error('MIDI track is too large.');
  const result = new Uint8Array(22 + track.length);
  result.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >>> 8, PPQ & 255]);
  result.set([0x4d, 0x54, 0x72, 0x6b], 14);
  new DataView(result.buffer).setUint32(18, track.length);
  result.set(track, 22);
  return result;
}

class Reader {
  position = 0;
  constructor(readonly data: Uint8Array) {}

  get remaining(): number { return this.data.length - this.position; }

  byte(): number {
    if (!this.remaining) throw new Error('Truncated MIDI file.');
    return this.data[this.position++]!;
  }

  bytes(length: number): Uint8Array {
    if (length > this.remaining) throw new Error('Truncated MIDI chunk or event length.');
    const result = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return result;
  }

  u16(): number { return this.byte() * 256 + this.byte(); }
  u32(): number { return this.u16() * 65536 + this.u16(); }
  tag(): string { return String.fromCharCode(...this.bytes(4)); }

  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.byte();
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('Invalid MIDI VLQ: more than four bytes.');
  }

  dataByte(): number {
    const byte = this.byte();
    if (byte > 127) throw new Error('Invalid MIDI data byte.');
    return byte;
  }
}

type Event =
  | { tick: number; kind: 'row'; row: MidiRow; channel: number }
  | { tick: number; kind: 'tempo'; tempo: number }
  | { tick: number; kind: 'signature'; numerator: number; denominator: number };

/** Merge format 0/1 tracks; ties use track order, then event order within the track. */
export function importMidi(data: Uint8Array): { settings: Settings; rows: MidiRow[]; warnings: string[] } {
  const reader = new Reader(data);
  if (reader.tag() !== 'MThd') throw new Error('Missing MIDI MThd header.');
  const header = new Reader(reader.bytes(reader.u32()));
  if (header.remaining < 6) throw new Error('Invalid MIDI header length.');
  const format = header.u16();
  if (format !== 0 && format !== 1) throw new Error(`Unsupported MIDI format ${format}; only formats 0 and 1 are supported.`);
  const trackCount = header.u16();
  if (!trackCount || (format === 0 && trackCount !== 1)) throw new Error('Invalid MIDI track count.');
  const division = header.u16();
  if (division & 0x8000) throw new Error('SMPTE MIDI timing is not supported.');
  if (!division) throw new Error('MIDI PPQ division must be greater than zero.');

  const events: Event[] = [];
  const warnings = new Set<string>();
  const unsupported = () => warnings.add('Unsupported MIDI events were discarded (only CC, PC, tempo and time signature are retained).');
  const normalizeTick = (tick: number): number => {
    const scaled = tick * PPQ / division;
    if (!Number.isSafeInteger(tick) || scaled > MAX_TICK) throw new Error(`MIDI time exceeds the supported range of 0–${MAX_TICK} ticks.`);
    return Math.round(scaled);
  };
  let tracks = 0;
  while (reader.remaining) {
    const tag = reader.tag();
    const chunk = new Reader(reader.bytes(reader.u32()));
    if (tag !== 'MTrk') {
      warnings.add(`Unknown MIDI chunk ${JSON.stringify(tag)} was discarded.`);
      continue;
    }
    if (++tracks > trackCount) throw new Error('MIDI contains more tracks than declared.');
    let tick = 0;
    let running = 0;
    let ended = false;
    while (chunk.remaining) {
      tick += chunk.vlq();
      const normalized = normalizeTick(tick);
      let status = chunk.byte();
      if (status < 0x80) {
        if (!running) throw new Error('Invalid MIDI running status without a channel status.');
        chunk.position--;
        status = running;
      }
      if (status < 0xf0) {
        running = status;
        const kind = status & 0xf0;
        const first = chunk.dataByte();
        const second = kind === 0xc0 || kind === 0xd0 ? 0 : chunk.dataByte();
        if (kind === 0xb0 || kind === 0xc0) {
          events.push({
            tick, kind: 'row', channel: (status & 15) + 1,
            row: { id: newId(), tick: normalized, type: kind === 0xb0 ? 'cc' : 'pc', controller: kind === 0xb0 ? first : 0, value: kind === 0xb0 ? second : first },
          });
        } else if (kind === 0x80 || kind === 0x90) {
          warnings.add('Note events were discarded; this editor only retains CC and PC messages.');
        } else unsupported();
      } else {
        running = 0;
        if (status === 0xff) {
          const type = chunk.dataByte();
          const payload = chunk.bytes(chunk.vlq());
          const fixedLengths: Record<number, number> = { 0x00: 2, 0x20: 1, 0x21: 1, 0x2f: 0, 0x51: 3, 0x54: 5, 0x58: 4, 0x59: 2 };
          if (fixedLengths[type] !== undefined && payload.length !== fixedLengths[type]) throw new Error('Invalid MIDI meta event length.');
          if (type === 0x2f) {
            ended = true;
            if (chunk.remaining) throw new Error('Unexpected MIDI data after end-of-track.');
          } else if (type === 0x51) {
            const micros = payload[0]! * 65536 + payload[1]! * 256 + payload[2]!;
            const tempo = 60_000_000 / micros;
            validateSettings({ ...DEFAULT_SETTINGS, tempo });
            events.push({ tick, kind: 'tempo', tempo });
          } else if (type === 0x58) {
            const numerator = payload[0]!;
            const denominator = 2 ** payload[1]!;
            validateSettings({ ...DEFAULT_SETTINGS, numerator, denominator });
            events.push({ tick, kind: 'signature', numerator, denominator });
          } else unsupported();
        } else if (status === 0xf0 || status === 0xf7) {
          chunk.bytes(chunk.vlq());
          unsupported();
        } else throw new Error(`Invalid SMF status byte 0x${status.toString(16)}.`);
      }
    }
    if (!ended) throw new Error('MIDI track is missing an end-of-track event.');
  }
  if (tracks !== trackCount) throw new Error('MIDI track count does not match the header.');

  const settings = { ...DEFAULT_SETTINGS };
  const rows: MidiRow[] = [];
  let hasTempo = false;
  let hasSignature = false;
  let hasChannel = false;
  // Sort by original ticks so PPQ rounding cannot change the earliest metadata/channel.
  for (const event of events.sort((a, b) => a.tick - b.tick)) {
    if (event.kind === 'row') {
      if (!hasChannel) {
        settings.channel = event.channel;
        hasChannel = true;
      } else if (event.channel !== settings.channel) warnings.add('Multiple MIDI channels were flattened to the first CC/PC channel.');
      rows.push(event.row);
    } else if (event.kind === 'tempo') {
      if (!hasTempo) {
        settings.tempo = event.tempo;
        hasTempo = true;
        if (event.tick > 0) warnings.add('The first tempo event occurs after tick 0 and was applied globally.');
      } else if (event.tempo !== settings.tempo) warnings.add('Tempo changes were flattened to the first tempo.');
    } else {
      if (!hasSignature) {
        settings.numerator = event.numerator;
        settings.denominator = event.denominator;
        hasSignature = true;
        if (event.tick > 0) warnings.add('The first time signature occurs after tick 0 and was applied globally.');
      } else if (event.numerator !== settings.numerator || event.denominator !== settings.denominator) warnings.add('Time signature changes were flattened to the first time signature.');
    }
  }
  validateSettings(settings);
  validateRows(rows);
  return { settings, rows: sortRows(rows), warnings: [...warnings] };
}
