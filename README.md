# Control - MIDI message editor

A local-first React + TypeScript website for building MIDI control-change and
program-change sequences. No note editor, account, backend, external fonts, or
file uploads. Includes a demo sequence on first launch.

## Run

Requires Node.js 22.12+ (or Node.js 24+) and npm.

```powershell
npm ci
npm run dev
```

Open the local address printed by Vite (normally http://127.0.0.1:5173).

```powershell
npm test
npm run build
npm run preview
```

The production build is in `dist`. Host it on a static web server. Use a consistent
origin/port to retain browser auto-saves. Opening the HTML directly from disk is
not supported.

## Editing

- Global tempo: 4-999 BPM, including decimals.
- Time signature: numerator 1-32; denominator 1, 2, 4, 8, 16, or 32.
- Global MIDI channel: 1-16.
- Message types: CC (controller + value) and PC (program number).
- All MIDI data values use the raw 0-127 range. Devices displaying programs
  1-128 are showing the same numbers offset by one.
- Time uses `bar:beat:tick`, with bars/beats starting at 1 and ticks at 0.
  Resolution is 960 ticks per quarter note. The signature denominator defines a
  displayed beat: in 6/8, a beat is 480 ticks and a bar is 2,880 ticks.
- Editing a time automatically sorts the grid. Same-time messages retain their
  relative order, which matters for bank-select and program-change sequences.
- Editing the first message's time shifts every message by the same amount,
  preserving relative spacing and simultaneous events. Other time edits affect
  only that message. Undo restores the entire shift; out-of-range shifts are rejected.
- Changing the signature preserves absolute ticks and relabels bars/beats.
  Changing tempo preserves musical positions but changes elapsed duration.
- Enter in a cell commits the edit and adds a row after it, inheriting message
  type and CC number, with value/program 0. Enter in the focused grid adds after
  the active row, or the last row when no row is active.
- Invalid input is highlighted and blocks export and row operations. Escape in
  that input cancels the edit.

## Layout

- Use the chevrons beside MIDI settings, Sequence overview, and Saved groups
  to collapse or expand each section without clearing drafts or selection.
- The header's sidebar toggle frees horizontal space on desktop. New sequence
  and Save project remain available below the grid when the sidebar is hidden.
- The grid's scroll area scales with viewport height. Collapsing sections makes
  more rows visible without scrolling the page. Layout choices last until reload.
- Correct an invalid tempo before collapsing MIDI settings.

## Smart timing

At the active row, the editor considers the last five distinct message times
(up to four positive intervals). It picks the most common interval, choosing
the most recent in a tie. Simultaneous events are excluded from interval
inference. With no interval yet, the default is one bar.

For example, copying messages at bars 1, 2, 3, and 4 and pasting with bar 4
active creates messages at bars 5, 6, 7, and 8.

Paste places all copied messages after the last selected row in grid order,
starting one inferred interval later and preserving all copied relative offsets,
including simultaneous events. With no selection, it uses the active row, or
the last row when no row is active.
In an empty sequence, paste starts at tick 0. Existing messages never shift;
collisions create simultaneous events and are reported.

Adding a row follows the same inferred interval unless another message occupies
or precedes that time. In that case it uses the midpoint to the next distinct
message time; if only one tick separates the rows, the new row shares the
anchor's time. Existing messages are not moved.

## Selection, clipboard, and movement

- Click a row to select; Ctrl/Cmd-click toggles; Shift-click selects a range.
- Checkboxes toggle individual rows. The header checkbox selects all.
- Copy/Paste buttons support multi-row clipboard within the editor.
- Copy also attempts to write tab-separated text to the system clipboard.
  If permission is denied, the editor reports it and retains its own copy.
- Keyboard Ctrl/Cmd+C and Ctrl/Cmd+V work when the grid, rather than a cell,
  is focused. Click the row number or a non-editable part of a row first.
- Keyboard paste also accepts spreadsheet TSV with four columns:
  `Time`, `Type`, `CC`, `Value`. The header is optional. Use `CC` or `PC`
  for Type, `-` for the unused PC controller, and a time such as `2:1:000`.
  External TSV times are interpreted in the current signature; the internal
  clipboard retains absolute tick offsets across signature changes.
- Inside inputs, native text copy/paste and undo are preserved.
- Drag the dotted handle onto another row. The earliest selected message aligns
  to the target row's time and the whole selection moves by the same delta.
  The target row and all other unselected messages remain in place.
- Earlier/later toolbar arrows and Alt+Up/Down move the selection by an inferred
  step, one beat, or one bar. Use these or direct time editing for empty times.
- Movement before tick 0 or after 268,435,455 ticks is rejected, not clamped.
- Up/Down navigate rows; Shift+Up/Down extend selection.
- Ctrl/Cmd+A selects all, Delete/Backspace deletes rows, Escape clears selection.
- Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes in the focused grid.
  Toolbar undo/redo also works. History retains up to 50 edits for the current
  session; it is not saved across reloads. Project name typing is auto-saved but
  is not a separate undo step.

## Saved groups

- Select rows, enter a name in Saved groups, and choose Save group.
- Each group is an independent snapshot of the selected messages, including
  CC/PC values, ordering, simultaneous events, and relative tick spacing.
  Editing or deleting the original rows does not change the saved group.
- Use a group's plus button to insert all its messages below the last selected
  row, following the same timing rules as paste. With no selection, it uses
  the active row or the last row; an empty grid starts at tick 0.
- Each insertion creates independent rows and supports the grid's undo/redo.
  Inserted messages use the current sequence's global MIDI settings.
- Groups persist locally in this browser and remain available across new
  sequences and imports. They are separate from project backups and MIDI exports.
- Group names must be unique (case-insensitive) and contain 1-120 characters.
  Delete a group with its trash button and confirmation; grid rows are unaffected.
- Storage failures are reported without changing the library. Invalid saved
  group data is left untouched, and library changes pause until it is repaired.

## Import, export, and persistence

- Import standard `.mid`/`.midi` files or `.control.json` project backups.
- Every import has a preview and requires confirmation before replacing the
  sequence. Replacement can be undone.
- MIDI export is a single-track format-0 Standard MIDI File at 960 PPQ containing
  only CC, PC, global tempo/time-signature metadata at tick 0, and end-of-track.
- MIDI import supports PPQ-based format 0 and 1 and merges tracks chronologically.
  Different source PPQ is rounded to the nearest editor tick.
- Notes and unsupported events are discarded with warnings. Multiple channels
  are flattened onto the first CC/PC channel. Tempo/meter maps are flattened to
  the earliest settings and moved to the beginning, with warnings.
- Format 2 and SMPTE-division files are rejected. Malformed files and unsupported
  setting ranges are rejected explicitly.
- This is a CC/PC editor, **not a lossless general MIDI round-trip tool**. Track
  names, notes, SysEx, pitch bend, aftertouch, and other metadata are not retained.
  Trailing silence after the last retained message is not preserved.
- Maximum import file size: 10 MB. Maximum project/paste size: 10,000 messages.
  The overview displays only the first 1,000 messages for large projects;
  the grid and export retain all messages.
- Auto-save uses localStorage on this browser/origin. Storage errors are visible.
  A corrupt saved project pauses auto-save rather than overwriting it with the
  demo; import a backup or explicitly create a new sequence to resume.
- Save project downloads a portable JSON backup with settings and messages.
- Export MIDI downloads `.mid` for your DAW or hardware workflow. This version
  edits files only: it does not play sequences or send live Web MIDI.

## Code

- `src/lib/model.ts`: typed project model and validation.
- `src/lib/editor.ts`: musical timing, inference, movement, TSV, project files.
- `src/lib/midi.ts`: bounded binary MIDI reader/writer.
- `src/lib/*.test.ts`: timing, editing, persistence, and MIDI codec tests.
- `src/App.tsx`: React editor and browser interactions.
- `src/styles.css`: responsive dark interface.
