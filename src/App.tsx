import { useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactNode } from 'react';
import { CC_NAMES, barTicks, beatTicks, createDemo, createRowGroup, formatTime, inferStep, insertionTick, moveRows, parseProject, parseRowGroups, parseTime, pasteRows, retimeRow, rowsFromTsv, rowsToTsv, serializeProject } from './lib/editor';
import type { RowGroup } from './lib/editor';
import { DEFAULT_SETTINGS, DENOMINATORS, PPQ, newId, sortRows, validateRows, validateSettings } from './lib/model';
import type { MidiRow, Project, Settings } from './lib/model';
import { exportMidi, importMidi } from './lib/midi';

const STORAGE_KEY = 'control-midi-project-v1';
const GROUPS_STORAGE_KEY = 'control-midi-groups-v1';
type IconName = 'grid' | 'plus' | 'copy' | 'paste' | 'download' | 'upload' | 'undo' | 'redo' | 'trash' | 'up' | 'down' | 'help' | 'close' | 'file' | 'check';

function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
    paste: <><path d="M8 5H5v16h14V5h-3" /><rect x="8" y="2" width="8" height="5" rx="1" /><path d="M9 12h6m-6 4h6" /></>,
    download: <path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" />,
    upload: <path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5" />,
    undo: <path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12" />,
    redo: <path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12" />,
    trash: <path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7" />,
    up: <path d="m6 14 6-6 6 6" />,
    down: <path d="m6 10 6 6 6-6" />,
    help: <><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 1-2 3m0 3v.1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    file: <><path d="M14 2H5v20h14V7zM14 2v5h5" /><path d="M8 12h8m-8 4h6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function CollapseButton({ label, expanded, controls, disabled, onClick }: {
  label: string; expanded: boolean; controls: string; disabled?: boolean; onClick: () => void;
}) {
  const action = `${expanded ? 'Collapse' : 'Expand'} ${label}`;
  return <button className="icon-button collapse-button" aria-label={action} title={action}
    aria-expanded={expanded} aria-controls={controls} disabled={disabled} onClick={onClick}>
    <Icon name={expanded ? 'up' : 'down'} size={15} />
  </button>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function readInitial(): { project: Project; error?: string } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return { project: saved ? parseProject(saved) : createDemo() };
  } catch (error) {
    return { project: createDemo(), error: `Could not restore the saved project: ${errorText(error)} Auto-save is paused to protect the saved data. Import a backup or start a new project.` };
  }
}

function readInitialGroups(): { groups: RowGroup[]; error?: string } {
  try {
    const saved = localStorage.getItem(GROUPS_STORAGE_KEY);
    return { groups: saved ? parseRowGroups(saved) : [] };
  } catch (error) {
    return { groups: [], error: `Could not restore saved groups: ${errorText(error)} Group changes are paused to protect saved data.` };
  }
}

function numericError(text: string, min: number, max: number, integer = true): string | undefined {
  const value = Number(text);
  if (!text.trim() || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    return `Enter ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`;
  }
}

interface EditFieldProps {
  value: string;
  label: string;
  fieldKey: string;
  validate: (text: string) => string | undefined;
  commit: (text: string, enter: boolean) => void;
  invalid: (key: string, value: boolean) => void;
  className?: string;
  numeric?: boolean;
  focusId?: string;
}

function EditField({ value, label, fieldKey, validate, commit, invalid, className = '', numeric, focusId }: EditFieldProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const cancelBlur = useRef(false);
  useEffect(() => { setDraft(value); setError(undefined); }, [value]);
  function reset() {
    setDraft(value);
    setError(undefined);
    invalid(fieldKey, false);
  }
  function save(enter: boolean) {
    const problem = validate(draft);
    setError(problem);
    invalid(fieldKey, !!problem);
    if (!problem && (draft !== value || enter)) commit(draft, enter);
  }
  return <div className={`edit-field ${className} ${error ? 'has-error' : ''}`}>
    <input aria-label={label} aria-invalid={!!error} title={error ?? label} value={draft}
      inputMode={numeric ? 'numeric' : 'text'} data-focus-id={focusId}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const problem = validate(text);
        setError(problem);
        invalid(fieldKey, !!problem);
      }}
      onBlur={() => {
        if (cancelBlur.current) cancelBlur.current = false;
        else save(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); save(true); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelBlur.current = true; reset(); event.currentTarget.blur(); }
      }} />
    {error && <span className="field-error" role="alert">{error}</span>}
  </div>;
}

function download(data: Uint8Array | string, name: string, type: string) {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : new Blob([new Uint8Array(data)], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const [initial] = useState(readInitial);
  const [initialGroups] = useState(readInitialGroups);
  const [groups, setGroups] = useState(initialGroups.groups);
  const [groupName, setGroupName] = useState('');
  const [deleteGroupId, setDeleteGroupId] = useState<string>();
  const [collapsed, setCollapsed] = useState({ settings: false, overview: false, groups: false, sidebar: false });
  const [project, setProject] = useState(initial.project);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string>();
  const rangeAnchor = useRef<string | undefined>(undefined);
  const [copied, setCopied] = useState<MidiRow[]>([]);
  const [past, setPast] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const [notice, setNotice] = useState<{ text: string; error: boolean }>({ text: initial.error ?? 'Ready. Your files stay on this device.', error: !!initial.error });
  const [saveState, setSaveState] = useState(initial.error ? 'Auto-save paused' : 'Saved on this device');
  const [saveEnabled, setSaveEnabled] = useState(!initial.error);
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const [stepMode, setStepMode] = useState('auto');
  const [dragIds, setDragIds] = useState<Set<string>>(new Set());
  const [dropId, setDropId] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ project: Project; warnings: string[] }>();
  const [focusId, setFocusId] = useState<string>();
  const [editEpoch, setEditEpoch] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { rows, settings } = project;
  const selected = rows.filter((row) => selection.has(row.id));
  const anchor = rows.find((row) => row.id === activeId) ?? rows.at(-1);
  const smartStep = inferStep(rows, anchor?.tick ?? 0, settings);
  const pasteAnchor = selected.at(-1) ?? anchor;
  const pasteStep = inferStep(rows, pasteAnchor?.tick ?? 0, settings);
  const step = stepMode === 'bar' ? barTicks(settings) : stepMode === 'beat' ? beatTicks(settings) : smartStep;
  const lastTick = rows.at(-1)?.tick ?? 0;
  const totalBars = Math.max(4, Math.floor(lastTick / barTicks(settings)) + 1);
  const modalOpen = helpOpen || newOpen || !!pendingImport;
  const blocked = invalidFields.size > 0;

  useEffect(() => {
    if (!saveEnabled) return;
    try {
      localStorage.setItem(STORAGE_KEY, serializeProject(project));
      setSaveState('Saved on this device');
    } catch (error) {
      setSaveState('Not saved');
      setNotice({ text: `Auto-save failed: ${errorText(error)} Download a project backup to keep your work.`, error: true });
    }
  }, [project, saveEnabled]);

  useEffect(() => {
    if (!focusId) return;
    const input = gridRef.current?.querySelector<HTMLInputElement>(`input[data-focus-id="${focusId}"]`);
    if (input) { input.focus(); input.select(); input.scrollIntoView({ block: 'nearest' }); }
    setFocusId(undefined);
  }, [focusId, rows]);

  useEffect(() => {
    if (modalOpen && !dialogRef.current?.open) dialogRef.current?.showModal();
    if (!modalOpen && dialogRef.current?.open) dialogRef.current?.close();
  }, [modalOpen]);

  function notify(text: string, error = false) { setNotice({ text, error }); }
  function toggleSection(section: keyof typeof collapsed) {
    setCollapsed((previous) => ({ ...previous, [section]: !previous[section] }));
  }
  function setInvalid(key: string, value: boolean) {
    setInvalidFields((previous) => {
      if (previous.has(key) === value) return previous;
      const next = new Set(previous);
      if (value) next.add(key); else next.delete(key);
      return next;
    });
  }
  function commit(next: Project) {
    validateSettings(next.settings);
    validateRows(next.rows);
    if (next.rows.length > 10000) throw new Error('A project can contain up to 10,000 messages.');
    setPast((previous) => [...previous.slice(-49), project]);
    setFuture([]);
    setProject({ ...next, rows: sortRows(next.rows) });
  }
  function attempt(action: () => void) {
    try { action(); } catch (error) { notify(errorText(error), true); }
  }
  function clearEditing() {
    setInvalidFields(new Set());
    setSelection(new Set());
    setActiveId(undefined);
    rangeAnchor.current = undefined;
    setEditEpoch((value) => value + 1);
  }
  function undo() {
    const previous = past.at(-1);
    if (!previous) return;
    setFuture((next) => [project, ...next]);
    setPast((next) => next.slice(0, -1));
    setProject(previous);
    clearEditing();
    notify('Undid the last change.');
  }
  function redo() {
    const next = future[0];
    if (!next) return;
    setPast((previous) => [...previous, project]);
    setFuture((previous) => previous.slice(1));
    setProject(next);
    clearEditing();
    notify('Redid the last change.');
  }
  function addRow(afterId = activeId, baseRows = rows) {
    const previous = baseRows.find((row) => row.id === afterId) ?? baseRows.at(-1);
    const row: MidiRow = {
      id: newId(), tick: insertionTick(baseRows, afterId, settings), type: previous?.type ?? 'cc',
      controller: previous?.controller ?? 11, value: 0,
    };
    // Insert after the anchor before stable sorting, including simultaneous events.
    const position = previous ? baseRows.findIndex((item) => item.id === previous.id) + 1 : 0;
    const next = [...baseRows];
    next.splice(position, 0, row);
    commit({ ...project, rows: next });
    setSelection(new Set([row.id]));
    setActiveId(row.id);
    rangeAnchor.current = row.id;
    setFocusId(row.id);
    notify(`Added a ${row.type.toUpperCase()} message at ${formatTime(row.tick, settings)}.`);
  }
  function editRow(id: string, field: 'tick' | 'controller' | 'value' | 'type', value: number | 'cc' | 'pc', enter = false) {
    attempt(() => {
      const next = field === 'tick' && typeof value === 'number' ? retimeRow(rows, id, value) : rows.map((row) => {
        if (row.id !== id) return row;
        if (field === 'type' && (value === 'cc' || value === 'pc')) return { ...row, type: value };
        if (field !== 'type' && typeof value === 'number') return { ...row, [field]: value };
        throw new Error('Invalid message edit.');
      });
      validateRows(next);
      const key = `${id}-${field === 'tick' ? 'time' : field === 'controller' ? 'cc' : field}`;
      if (enter && [...invalidFields].some((invalidKey) => invalidKey !== key)) {
        if (JSON.stringify(next) !== JSON.stringify(rows)) commit({ ...project, rows: next });
        notify('Correct the other invalid fields before adding a message.', true);
      } else if (enter) addRow(id, sortRows(next));
      else if (JSON.stringify(next) !== JSON.stringify(rows)) commit({ ...project, rows: next });
    });
  }
  function updateSettings(next: Settings) {
    attempt(() => {
      commit({ ...project, settings: next });
      if (next.numerator !== settings.numerator || next.denominator !== settings.denominator) {
        notify('Time signature updated. Absolute ticks are preserved; bar and beat labels have changed.');
      }
    });
  }
  function selectRow(id: string, shift: boolean, toggle: boolean) {
    const start = rows.findIndex((row) => row.id === rangeAnchor.current);
    const end = rows.findIndex((row) => row.id === id);
    if (shift && start >= 0) {
      setSelection(new Set(rows.slice(Math.min(start, end), Math.max(start, end) + 1).map((row) => row.id)));
    } else if (toggle) {
      setSelection((previous) => {
        const next = new Set(previous);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      rangeAnchor.current = id;
    } else {
      setSelection(new Set([id]));
      rangeAnchor.current = id;
    }
    setActiveId(id);
  }
  function copyRows(event?: ClipboardEvent) {
    if (!selected.length) { notify('Select one or more rows to copy.', true); return; }
    const text = rowsToTsv(selected, settings);
    setCopied(selected.map((row) => ({ ...row })));
    if (event) {
      event.preventDefault();
      event.clipboardData.setData('text/plain', text);
      notify(`Copied ${selected.length} message${selected.length === 1 ? '' : 's'} with relative timing.`);
    } else {
      if (!navigator.clipboard) {
        notify(`Copied ${selected.length} rows inside the editor. System clipboard is unavailable.`);
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => notify(`Copied ${selected.length} message${selected.length === 1 ? '' : 's'} with relative timing.`),
        () => notify(`Copied ${selected.length} rows inside the editor. System clipboard access was denied; use the Paste button.`),
      );
    }
  }
  function paste(source = copied) {
    attempt(() => {
      const added = pasteRows(rows, source, pasteAnchor?.id, settings);
      const collisions = added.some((row) => rows.some((existing) => existing.tick === row.tick));
      commit({ ...project, rows: [...rows, ...added] });
      setSelection(new Set(added.map((row) => row.id)));
      setActiveId(added.at(-1)!.id);
      rangeAnchor.current = added[0].id;
      gridRef.current?.focus();
      notify(`Pasted ${added.length} message${added.length === 1 ? '' : 's'} at ${formatTime(added[0].tick, settings)}. Relative spacing preserved.${collisions ? ' Some messages share a time; existing messages were not moved.' : ''}`);
    });
  }
  function saveGroup() {
    attempt(() => {
      if (blocked || initialGroups.error) return;
      const group = createRowGroup(groupName, selected);
      if (groups.some((existing) => existing.name.toLowerCase() === group.name.toLowerCase())) {
        throw new Error('A group with that name already exists. Choose a different name.');
      }
      const next = [...groups, group];
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify({ version: 1, groups: next }));
      setGroups(next);
      setGroupName('');
      notify(`Saved "${group.name}" with ${group.rows.length} message${group.rows.length === 1 ? '' : 's'}.`);
    });
  }
  function deleteGroup(group: RowGroup) {
    attempt(() => {
      if (initialGroups.error) return;
      const next = groups.filter((existing) => existing.id !== group.id);
      localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify({ version: 1, groups: next }));
      setGroups(next);
      setDeleteGroupId(undefined);
      notify(`Deleted group "${group.name}". Messages in the grid were not changed.`);
    });
  }
  function removeSelected() {
    if (!selected.length) return;
    commit({ ...project, rows: rows.filter((row) => !selection.has(row.id)) });
    const removed = selected.length;
    clearEditing();
    gridRef.current?.focus();
    notify(`Deleted ${removed} message${removed === 1 ? '' : 's'}. Undo is available.`);
  }
  function nudge(direction: number) {
    attempt(() => {
      commit({ ...project, rows: moveRows(rows, selection, direction * step) });
      notify(`Moved ${selected.length} message${selected.length === 1 ? '' : 's'} ${direction > 0 ? 'later' : 'earlier'} by ${step} ticks.`);
    });
  }
  function textEditing(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest('input:not([type="checkbox"]), select, textarea');
  }
  function gridKeys(event: KeyboardEvent) {
    const modifier = event.ctrlKey || event.metaKey;
    if (textEditing(event.target)) return;
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
    if (blocked) return;
    if (modifier && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelection(new Set(rows.map((row) => row.id))); }
    else if (event.key === 'Enter') { event.preventDefault(); attempt(() => addRow()); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); attempt(removeSelected); }
    else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); if (selected.length) nudge(event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const index = rows.findIndex((row) => row.id === activeId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))];
      if (next) selectRow(next.id, event.shiftKey, false);
    } else if (event.key === 'Escape') { setSelection(new Set()); }
  }
  async function importFile(file: File) {
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Please choose a file smaller than 10 MB.');
      if (/\.json$/i.test(file.name)) {
        setPendingImport({ project: parseProject(await file.text()), warnings: [] });
      } else {
        const result = importMidi(new Uint8Array(await file.arrayBuffer()));
        if (result.rows.length > 10000) throw new Error('This file contains more than 10,000 CC/PC messages.');
        setPendingImport({ project: { name: file.name.replace(/\.[^.]+$/, ''), settings: result.settings, rows: result.rows }, warnings: result.warnings });
      }
    } catch (error) { notify(`Import failed: ${errorText(error)}`, true); }
  }
  function acceptImport() {
    if (!pendingImport) return;
    attempt(() => {
      commit(pendingImport.project);
      setSaveEnabled(true);
      clearEditing();
      notify(`Imported ${pendingImport.project.rows.length} messages.${pendingImport.warnings.length ? ' Import conversions were applied as shown in the preview.' : ''}`);
      setPendingImport(undefined);
    });
  }
  function exportFile(kind: 'midi' | 'project') {
    attempt(() => {
      const name = project.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-') || 'untitled';
      if (kind === 'midi') download(exportMidi(project), `${name}.mid`, 'audio/midi');
      else download(serializeProject(project), `${name}.control.json`, 'application/json');
      notify(`Downloaded ${kind === 'midi' ? 'MIDI file' : 'project backup'}.`);
    });
  }
  const stepLabel = step === barTicks(settings) ? '1 bar' : step === beatTicks(settings) ? '1 beat' : `${step} ticks`;
  const nextPasteTick = pasteAnchor ? pasteAnchor.tick + pasteStep : 0;

  return <div className="app-shell">
    <header className="app-header">
      <button className="icon-button sidebar-toggle" aria-label={`${collapsed.sidebar ? 'Expand' : 'Collapse'} sidebar`}
        title={`${collapsed.sidebar ? 'Expand' : 'Collapse'} sidebar`} aria-expanded={!collapsed.sidebar} aria-controls="workspace-sidebar"
        onClick={() => toggleSection('sidebar')}><Icon name="grid" /></button>
      <a className="brand" href="#main" aria-label="Control, MIDI message editor"><span className="brand-mark"><i /><i /><i /><i /></span>control<span className="brand-period">.</span></a>
      <span className="header-divider" /><span className="workspace-label">MIDI WORKSPACE</span>
      <div className="header-right"><span className="local-badge"><span /> LOCAL FIRST</span><button className="icon-button" title="Help and keyboard shortcuts" aria-label="Help and keyboard shortcuts" onClick={() => setHelpOpen(true)}><Icon name="help" /></button></div>
    </header>

    <div className={`workspace${collapsed.sidebar ? ' sidebar-collapsed' : ''}`}>
      <aside id="workspace-sidebar" className="sidebar" hidden={collapsed.sidebar}>
        <div className="sidebar-label">WORKSPACE</div>
        <div className="nav-item active"><Icon name="grid" /> Message grid <span>{rows.length}</span></div>
        <button className="nav-item" disabled={blocked} onClick={() => setNewOpen(true)}><Icon name="plus" /> New sequence</button>
        <button className="nav-item" disabled={blocked} onClick={() => exportFile('project')}><Icon name="file" /> Save project</button>
        <div className="sidebar-divider" />
        <div className="sidebar-label">SEQUENCE DETAILS</div>
        <dl className="details"><div><dt>Control changes</dt><dd>{rows.filter((row) => row.type === 'cc').length}</dd></div><div><dt>Program changes</dt><dd>{rows.filter((row) => row.type === 'pc').length}</dd></div><div><dt>Resolution</dt><dd>{PPQ} PPQ</dd></div></dl>
        <div className="sidebar-note"><span className="tiny-dot" /> Control, not notes.<p>Build precise automation for your pedals, synths, and live rig.</p></div>
        <div className="shortcut-card"><div className="shortcut-title">Stay in the flow <Icon name="plus" size={14} /></div><p>Press <kbd>Enter</kbd> to add a message below the active row.</p><button className="text-button" onClick={() => setHelpOpen(true)}>All shortcuts <span aria-hidden="true">↗</span></button></div>
        <div className="sidebar-bottom">CONTROL / V1.0<span>Made for the details.</span></div>
      </aside>

      <main id="main">
        <section className="project-heading">
          <div><div className="eyebrow">SEQUENCE EDITOR <span>/</span> {String(rows.length).padStart(2, '0')} MESSAGES</div>
            <input className="project-name" aria-label="Sequence name" value={project.name} maxLength={120}
              onChange={(event) => setProject({ ...project, name: event.target.value })} />
            <div className="saved-status"><Icon name="check" size={13} /> {saveState}</div>
          </div>
          <div className="file-actions"><button className="button secondary" disabled={blocked} onClick={() => fileInput.current?.click()}><Icon name="upload" /> Import</button><button className="button primary" disabled={blocked} onClick={() => exportFile('midi')}><Icon name="download" /> Export MIDI</button></div>
          <input ref={fileInput} type="file" accept=".mid,.midi,.json" aria-label="Import MIDI or project" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
        </section>

        <section className="settings-section" aria-label="Global MIDI settings">
          <div className="panel-heading"><h2><CollapseButton label="MIDI settings" expanded={!collapsed.settings} controls="settings-content"
            disabled={invalidFields.has('tempo')} onClick={() => toggleSection('settings')} /> MIDI settings</h2></div>
          <div id="settings-content" className="settings-panel" hidden={collapsed.settings}>
          <div className="setting-block"><div className="setting-label">TEMPO</div><div className="setting-value"><span className="tempo-icon" aria-hidden="true">♩</span><EditField key={`tempo-${editEpoch}`} value={String(settings.tempo)} label="Tempo in BPM" fieldKey="tempo" validate={(text) => numericError(text, 4, 999, false)} commit={(text) => updateSettings({ ...settings, tempo: Number(text) })} invalid={setInvalid} numeric /><span className="setting-unit">BPM</span></div></div>
          <div className="setting-block"><div className="setting-label">TIME SIGNATURE</div><div className="setting-value signature"><select aria-label="Time signature numerator" disabled={blocked} value={settings.numerator} onChange={(event) => updateSettings({ ...settings, numerator: Number(event.target.value) })}>{Array.from({ length: 32 }, (_, index) => <option key={index + 1}>{index + 1}</option>)}</select><span>/</span><select aria-label="Time signature denominator" disabled={blocked} value={settings.denominator} onChange={(event) => updateSettings({ ...settings, denominator: Number(event.target.value) })}>{DENOMINATORS.map((value) => <option key={value}>{value}</option>)}</select></div></div>
          <div className="setting-block"><div className="setting-label">MIDI CHANNEL</div><div className="setting-value"><span className="channel-icon" aria-hidden="true">◉</span><select aria-label="MIDI channel" disabled={blocked} value={settings.channel} onChange={(event) => updateSettings({ ...settings, channel: Number(event.target.value) })}>{Array.from({ length: 16 }, (_, index) => <option key={index + 1} value={index + 1}>{String(index + 1).padStart(2, '0')}</option>)}</select><span className="setting-unit">ALL MESSAGES</span></div></div>
          <div className="settings-caption"><span className="tiny-dot" /> One sequence.<br />Every change in time.</div>
          </div>
        </section>

        <section className="sequence-overview" aria-label="Sequence overview">
          <div className="overview-heading"><div><CollapseButton label="sequence overview" expanded={!collapsed.overview} controls="overview-content" onClick={() => toggleSection('overview')} /><span>SEQUENCE OVERVIEW</span></div><div><span className="legend cc" /> CC <span className="legend pc" /> PC <span className="bar-count">{totalBars} bars</span></div></div>
          <div id="overview-content" hidden={collapsed.overview}>
          <div className="timeline">
            {Array.from({ length: Math.min(totalBars + 1, 9) }, (_, index) => <div className="timeline-bar" key={index}><span>{String(Math.floor(index * totalBars / Math.min(totalBars, 8)) + 1).padStart(2, '0')}</span></div>)}
            {rows.slice(0, 1000).map((row) => <button key={row.id} className={`timeline-message ${row.type} ${selection.has(row.id) ? 'chosen' : ''}`} style={{ left: `${row.tick / (totalBars * barTicks(settings)) * 100}%`, top: row.type === 'cc' ? '30px' : '49px' }} aria-label={`Select ${row.type.toUpperCase()} at ${formatTime(row.tick, settings)}`} title={`${row.type.toUpperCase()} ${row.type === 'cc' ? row.controller : row.value} · ${formatTime(row.tick, settings)}`} onClick={(event) => { selectRow(row.id, event.shiftKey, event.ctrlKey || event.metaKey); gridRef.current?.focus(); }} />)}
          </div>
          {rows.length > 1000 && <span className="overview-limit">Preview shows the first 1,000 messages. All messages remain in the grid and export.</span>}
          </div>
        </section>

        <section className="group-library" aria-labelledby="groups-heading">
          <div className="group-library-heading">
            <h2 id="groups-heading"><CollapseButton label="saved groups" expanded={!collapsed.groups} controls="group-save group-content" onClick={() => toggleSection('groups')} /> Saved groups <span className="count-pill">{groups.length}</span></h2>
            <form id="group-save" className="group-save" hidden={collapsed.groups} onSubmit={(event) => { event.preventDefault(); saveGroup(); }}>
              <input aria-label="Group name" placeholder="Group name" maxLength={120} value={groupName} disabled={!!initialGroups.error}
                onChange={(event) => setGroupName(event.target.value)} />
              <button className="button secondary" type="submit" disabled={!selected.length || !groupName.trim() || blocked || !!initialGroups.error}
                title="Save selected rows as a group"><Icon name="file" /> Save group</button>
            </form>
          </div>
          <div id="group-content" hidden={collapsed.groups}>
          {initialGroups.error ? <p className="group-error" role="alert">{initialGroups.error}</p> : !groups.length ? <p className="groups-empty">No saved groups</p> :
            <ul className="group-list">{groups.map((group) => <li key={group.id}>
              <div className="group-info"><strong>{group.name}</strong><span>{group.rows.length} message{group.rows.length === 1 ? '' : 's'}</span></div>
              {deleteGroupId === group.id ? <div className="group-actions">
                <span className="group-delete-label">Delete group?</span>
                <button className="tool-button icon-only" aria-label={`Confirm delete group ${group.name}`} title="Confirm deletion" onClick={() => deleteGroup(group)}><Icon name="check" /></button>
                <button className="tool-button icon-only" aria-label="Cancel group deletion" title="Cancel deletion" onClick={() => setDeleteGroupId(undefined)}><Icon name="close" /></button>
              </div> : <div className="group-actions">
                <button className="tool-button icon-only" disabled={blocked} aria-label={`Add group ${group.name} to grid`} title={`Add ${group.name} below the last selected row`} onClick={() => paste(group.rows)}><Icon name="plus" /></button>
                <button className="tool-button icon-only" aria-label={`Delete group ${group.name}`} title={`Delete group ${group.name}`} onClick={() => setDeleteGroupId(group.id)}><Icon name="trash" /></button>
              </div>}
            </li>)}</ul>}
          </div>
        </section>

        <section className="editor-panel" aria-label="Message editor">
          <div className="editor-title"><div><Icon name="grid" /><h2>Messages</h2><span className="count-pill">{rows.length}</span></div><span className="time-format">BAR : BEAT : TICK</span></div>
          <div className="toolbar">
            <button className="button add-button" disabled={blocked} onClick={() => attempt(() => addRow())}><Icon name="plus" /> Add message <kbd>↵</kbd></button>
            <span className="tool-divider" />
            <button className="tool-button" disabled={!selected.length || blocked} onClick={() => copyRows()} title="Copy selected rows"><Icon name="copy" /><span>Copy</span></button>
            <button className="tool-button" disabled={!copied.length || blocked} onClick={() => paste()} title="Paste rows copied inside this editor"><Icon name="paste" /><span>Paste</span>{copied.length > 0 && <small>{copied.length}</small>}</button>
            <button className="tool-button icon-only" aria-label="Delete selected rows" title="Delete selected rows" disabled={!selected.length || blocked} onClick={() => attempt(removeSelected)}><Icon name="trash" /></button>
            <span className="tool-divider" />
            <div className="move-tools"><button className="tool-button icon-only" aria-label="Move selected rows earlier" title={`Move earlier by ${stepLabel}`} disabled={!selected.length || blocked} onClick={() => nudge(-1)}><Icon name="up" /></button><button className="tool-button icon-only" aria-label="Move selected rows later" title={`Move later by ${stepLabel}`} disabled={!selected.length || blocked} onClick={() => nudge(1)}><Icon name="down" /></button><select aria-label="Move timing increment" value={stepMode} onChange={(event) => setStepMode(event.target.value)}><option value="auto">Auto step</option><option value="beat">1 beat</option><option value="bar">1 bar</option></select></div>
            <div className="history-tools"><button className="tool-button icon-only" aria-label="Undo" title="Undo" disabled={!past.length} onClick={undo}><Icon name="undo" /></button><button className="tool-button icon-only" aria-label="Redo" title="Redo" disabled={!future.length} onClick={redo}><Icon name="redo" /></button></div>
          </div>
          <div ref={gridRef} className="grid-container" tabIndex={0} aria-label="MIDI message grid; focus here for row shortcuts" onKeyDown={gridKeys}
            onCopy={(event) => { if (!textEditing(event.target) && !blocked) copyRows(event); }}
            onPaste={(event) => {
              if (textEditing(event.target)) return;
              event.preventDefault();
              if (blocked) { notify('Fix invalid fields before pasting.', true); return; }
              attempt(() => paste(rowsFromTsv(event.clipboardData.getData('text/plain'), settings)));
            }}>
            <table aria-label="MIDI messages">
              <thead><tr><th className="select-col"><input type="checkbox" aria-label="Select all messages" checked={rows.length > 0 && selected.length === rows.length} ref={(input) => { if (input) input.indeterminate = selected.length > 0 && selected.length < rows.length; }} onChange={(event) => setSelection(new Set(event.target.checked ? rows.map((row) => row.id) : []))} /></th><th className="row-number">#</th><th className="time-col">Time <span className="sort-arrow">↑</span></th><th className="type-col">Type</th><th className="cc-col">CC / Parameter</th><th className="value-col">Value / Program</th><th className="channel-col">Channel</th><th className="drag-col"><span className="sr-only">Drag</span></th></tr></thead>
              <tbody>{rows.map((row, index) => {
                const previous = rows[index - 1];
                const newBar = !previous || Math.floor(previous.tick / barTicks(settings)) !== Math.floor(row.tick / barTicks(settings));
                return <tr key={`${row.id}-${editEpoch}`} className={`${selection.has(row.id) ? 'selected' : ''} ${activeId === row.id ? 'active-row' : ''} ${newBar ? 'new-bar' : ''} ${dropId === row.id ? 'drop-target' : ''}`}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest('input, select, button')) return;
                    selectRow(row.id, event.shiftKey, event.ctrlKey || event.metaKey);
                    gridRef.current?.focus();
                  }}
                  onFocus={(event) => {
                    if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') return;
                    setActiveId(row.id);
                    if (!selection.has(row.id)) { setSelection(new Set([row.id])); rangeAnchor.current = row.id; }
                  }}
                  onDragOver={(event) => { if (dragIds.size && !dragIds.has(row.id)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropId(row.id); } }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const moving = rows.filter((item) => dragIds.has(item.id));
                    if (moving.length && !dragIds.has(row.id)) {
                      attempt(() => {
                        const delta = row.tick - moving[0].tick;
                        if (!delta) { notify('These messages already share the target time. Use the time field or move arrows for finer positioning.'); return; }
                        commit({ ...project, rows: moveRows(rows, dragIds, delta) });
                        notify(`Moved ${moving.length} messages to ${formatTime(row.tick, settings)}; relative timing preserved. Target messages kept.`);
                      });
                    }
                    setDragIds(new Set()); setDropId(undefined);
                  }}>
                  <td className="select-col"><input type="checkbox" aria-label={`Select message ${index + 1}`} checked={selection.has(row.id)} onChange={() => {}} onClick={(event) => { event.stopPropagation(); selectRow(row.id, event.shiftKey, true); }} /></td>
                  <td className="row-number">{String(index + 1).padStart(2, '0')}</td>
                  <td className="time-col"><EditField value={formatTime(row.tick, settings)} label={`Time for message ${index + 1}`} fieldKey={`${row.id}-time`} focusId={row.id} validate={(text) => { try { retimeRow(rows, row.id, parseTime(text, settings)); return undefined; } catch (error) { return errorText(error); } }} commit={(text, enter) => editRow(row.id, 'tick', parseTime(text, settings), enter)} invalid={setInvalid} /></td>
                  <td className="type-col"><select className={`message-type ${row.type}`} aria-label={`Type for message ${index + 1}`} value={row.type} disabled={blocked} onChange={(event) => editRow(row.id, 'type', event.target.value === 'cc' ? 'cc' : 'pc')} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!blocked) attempt(() => addRow(row.id)); } }}><option value="cc">CC</option><option value="pc">PC</option></select></td>
                  <td className="cc-col"><div className="parameter">{row.type === 'cc' ? <><EditField value={String(row.controller)} label={`CC for message ${index + 1}`} fieldKey={`${row.id}-cc`} numeric validate={(text) => numericError(text, 0, 127)} commit={(text, enter) => editRow(row.id, 'controller', Number(text), enter)} invalid={setInvalid} /><span>{CC_NAMES[row.controller] ?? 'Controller'}</span></> : <><span className="pc-dash">—</span><span>Program change</span></>}</div></td>
                  <td className="value-col"><div className="value-wrap"><EditField value={String(row.value)} label={`${row.type === 'pc' ? 'Program' : 'Value'} for message ${index + 1}`} fieldKey={`${row.id}-value`} numeric validate={(text) => numericError(text, 0, 127)} commit={(text, enter) => editRow(row.id, 'value', Number(text), enter)} invalid={setInvalid} /><div className={`value-meter ${row.type}`} aria-hidden="true"><span style={{ width: `${row.value / 127 * 100}%` }} /></div></div></td>
                  <td className="channel-col"><span className="channel-chip">{String(settings.channel).padStart(2, '0')}</span></td>
                  <td className="drag-col"><span className={`drag-handle ${blocked ? 'disabled' : ''}`} draggable={!blocked} role="img" aria-label={`Drag message ${index + 1} to another message time`} title="Drag to another row's time. Selected rows move together. Use move arrows for keyboard control."
                    onDragStart={(event) => {
                      const ids = selection.has(row.id) ? selection : new Set([row.id]);
                      setDragIds(ids); setSelection(ids); setActiveId(row.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', rowsToTsv(rows.filter((item) => ids.has(item.id)), settings));
                    }} onDragEnd={() => { setDragIds(new Set()); setDropId(undefined); }}>⠿</span></td>
                </tr>;
              })}</tbody>
            </table>
            {!rows.length && <div className="empty-state"><Icon name="grid" size={32} /><h3>A blank canvas for your rig.</h3><p>Add your first CC or program change, or import a MIDI file.</p><button className="button primary" disabled={blocked} onClick={() => attempt(() => addRow())}><Icon name="plus" /> Add first message</button></div>}
            {rows.length > 0 && <button className="add-row-bottom" disabled={blocked} onClick={() => attempt(() => addRow())}><Icon name="plus" size={15} /> Add a message <span>or press Enter</span></button>}
          </div>
          <div className="grid-footer"><span><strong>{selected.length}</strong> selected <span className="footer-dot">·</span> {rows.length} messages</span><span>0–127 values <span className="footer-dot">·</span> Notes excluded</span></div>
        </section>

        <div className="mobile-project-actions"><button className="button secondary" disabled={blocked} onClick={() => setNewOpen(true)}><Icon name="plus" /> New sequence</button><button className="button secondary" disabled={blocked} onClick={() => exportFile('project')}><Icon name="file" /> Save project</button></div>
        <div className="smart-hint"><span className="smart-icon" aria-hidden="true">✦</span><div><strong>Smart timing</strong><span>Next paste at <b>{formatTime(nextPasteTick, settings)}</b> · inferred spacing: <b>{pasteStep === barTicks(settings) ? '1 bar' : pasteStep === beatTicks(settings) ? '1 beat' : `${pasteStep} ticks`}</b></span></div><span className="hint-tag">RELATIVE SPACING PRESERVED</span></div>
        <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{blocked ? 'An input is invalid. Correct the highlighted field or press Escape in it to cancel. Export and row operations are paused.' : notice.text}</div>
        <footer className="main-footer"><span>No uploads. No account. Just your MIDI.</span><button className="text-button" onClick={() => setHelpOpen(true)}>Keyboard shortcuts <kbd>?</kbd></button></footer>
      </main>
    </div>

    <dialog ref={dialogRef} onCancel={() => { setHelpOpen(false); setNewOpen(false); setPendingImport(undefined); }}>
      <button className="icon-button dialog-close" aria-label="Close dialog" onClick={() => { setHelpOpen(false); setNewOpen(false); setPendingImport(undefined); }}><Icon name="close" /></button>
      {helpOpen ? <>
        <div className="eyebrow">A LITTLE LESS CLICKING</div><h2>Make every message count.</h2>
        <p>Times use <strong>bar:beat:tick</strong>. Bars and beats start at 1, ticks at 0. A quarter note is 960 ticks; in 6/8, each displayed beat is an eighth note (480 ticks).</p>
        <dl className="shortcut-list"><div><dt><kbd>Enter</kbd></dt><dd>Commit the current cell and add a row below.</dd></div><div><dt><kbd>Shift</kbd> + click</dt><dd>Select a range of rows.</dd></div><div><dt><kbd>Ctrl / ⌘</kbd> + click</dt><dd>Toggle individual rows. Checkboxes work too.</dd></div><div><dt><kbd>Ctrl / ⌘ C</kbd> / <kbd>V</kbd></dt><dd>Copy / paste selected rows when the grid is focused.</dd></div><div><dt><kbd>Ctrl / ⌘ A</kbd></dt><dd>Select all rows in the focused grid.</dd></div><div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Navigate rows. Hold Shift to extend selection.</dd></div><div><dt><kbd>Alt ↑</kbd> / <kbd>Alt ↓</kbd></dt><dd>Move selected rows earlier / later by the chosen step.</dd></div><div><dt><kbd>Delete</kbd></dt><dd>Remove selected rows. Cell text editing stays native.</dd></div><div><dt><kbd>Ctrl / ⌘ Z</kbd></dt><dd>Undo. Add Shift to redo (or Ctrl Y).</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Cancel a cell edit or clear the row selection.</dd></div></dl>
        <h3>Timing that follows your pattern</h3><p>Paste starts one inferred interval after the last selected row in the grid. With no selection, it uses the active row (or the last row). The most common of the last four distinct intervals wins, with recent intervals breaking ties. No pattern yet? One bar. Multi-row pastes keep their original offsets. Adding between occupied times uses the midpoint.</p>
        <p>Drag the dotted handle onto a row to align the start of your selection to that row's time. Other rows stay put; simultaneous messages are allowed. Use the move arrows or time fields for unoccupied times.</p>
        <h3>Files &amp; clipboard</h3><p>Import .mid/.midi or a .control.json project. MIDI exports contain only CC, PC, global tempo, time signature, and end-of-track data. Program numbers are <strong>0–127</strong> (some devices display these as 1–128). Multi-channel imports and changing tempo/meter require conversion; review the import preview before applying.</p><p>The Paste button uses rows copied in this editor. Keyboard paste also accepts tab-separated spreadsheet rows: <code>Time, Type, CC, Value</code> (CC is “-” for PC). Copy/paste inside a cell edits text normally. Auto-save is local to this browser; use Save project for a portable backup. Undo retains the last 50 edits for this session.</p>
      </> : pendingImport ? <>
        <div className="eyebrow">IMPORT PREVIEW</div><h2>{pendingImport.project.name}</h2><p>{pendingImport.project.rows.length} CC/PC messages · {pendingImport.project.settings.tempo} BPM · {pendingImport.project.settings.numerator}/{pendingImport.project.settings.denominator} · Channel {pendingImport.project.settings.channel}</p>
        {pendingImport.warnings.length > 0 && <div className="import-warnings"><h3>Review these conversions</h3><ul>{pendingImport.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <p>This will replace the current sequence. You can undo this after importing.</p><div className="dialog-actions"><button className="button secondary" onClick={() => setPendingImport(undefined)}>Cancel</button><button className="button primary" onClick={acceptImport}>Import sequence</button></div>
      </> : newOpen ? <>
        <div className="eyebrow">A FRESH START</div><h2>Create a new sequence?</h2><p>Your current sequence will be replaced with an empty 120 BPM, 4/4 project on channel 1. Save a project backup first if you want to keep it. Undo will also be available.</p><div className="dialog-actions"><button className="button secondary" onClick={() => setNewOpen(false)}>Cancel</button><button className="button primary" onClick={() => { attempt(() => { commit({ name: 'Untitled sequence', settings: { ...DEFAULT_SETTINGS }, rows: [] }); setSaveEnabled(true); clearEditing(); setNewOpen(false); notify('New sequence ready. Add your first message.'); }); }}>New sequence</button></div>
      </> : null}
    </dialog>
  </div>;
}
