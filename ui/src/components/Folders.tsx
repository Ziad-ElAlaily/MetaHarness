import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import type { ConfigView, Scope } from '../types.ts';
import { Dialog, Field, useConfirm } from './common.tsx';
import { ExportDialog } from './Sharing.tsx';
import type { SetupProps } from '../pages/setup.tsx';

/**
 * Folders under the Roles and Workflows tabs: roles/<folder>/<name>.md. One level, one place for
 * each item, and each tab has its own. They only organize: an item's name doesn't change with its
 * folder, so whatever names it keeps working.
 */

type Kind = 'role' | 'workflow';

const COLLAPSED = (kind: Kind) => `mh.folders.closed.${kind}`;

function readClosed(kind: Kind): string[] {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED(kind)) ?? '[]') as string[];
  } catch {
    return [];
  }
}

const DRAG = 'application/x-mh-item';

/** Lets an item be dragged onto a folder, on a computer; a built-in one has no file to move. */
export function draggable(kind: Kind, name: string, scope: Scope | 'built-in') {
  if (scope === 'built-in') return {};
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData(DRAG, JSON.stringify({ kind, name }));
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

/** The folder an item is in: pick one, or type a new name. Saved with the item. */
export function FolderField({ kind, config, value, onChange }: { kind: Kind; config?: ConfigView; value: string; onChange: (v: string) => void }) {
  const id = `folders-${kind}`;
  return (
    <Field label="Folder" hint="Only for keeping things organized. Type a new name to make one.">
      <input type="text" list={id} value={value} onChange={e => onChange(e.target.value.replace(/\s+/g, '-'))} placeholder="None" />
      <datalist id={id}>
        {(config?.folders[kind] ?? []).map(f => (
          <option key={f} value={f} />
        ))}
      </datalist>
    </Field>
  );
}

interface Item {
  name: string;
  scope: Scope | 'built-in';
  folder: string;
}

/** The folders of a tab, opening and closing, each with what's in it. Items in no folder are the page's to list. */
export function FolderTree<T extends Item>({ kind, config, items, render, open, onSave, onCommand, guard }: { kind: Kind; config?: ConfigView; items: T[]; render: (item: T) => ReactNode; open?: string; onSave: SetupProps['onSave']; onCommand: SetupProps['onCommand']; guard: () => Promise<boolean> }) {
  const [closed, setClosed] = useState(() => readClosed(kind));
  const [naming, setNaming] = useState<{ previous?: string }>();
  const [exporting, setExporting] = useState<string>();
  const [menu, setMenu] = useState<string>();
  const [over, setOver] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const confirm = useConfirm();
  // The way out of a folder only shows while something's being dragged.
  useEffect(() => {
    const on = () => setDragging(true);
    const off = () => {
      setDragging(false);
      setOver(undefined);
    };
    window.addEventListener('dragstart', on);
    window.addEventListener('dragend', off);
    window.addEventListener('drop', off);
    return () => {
      window.removeEventListener('dragstart', on);
      window.removeEventListener('dragend', off);
      window.removeEventListener('drop', off);
    };
  }, []);
  // Opening an item opens its folder; after that, closing it is up to you.
  useEffect(() => {
    if (open) setClosed(c => (c.includes(open) ? c.filter(x => x !== open) : c));
  }, [open]);
  const folders = config?.folders[kind] ?? [];
  const word = kind === 'role' ? 'roles' : 'workflows';

  const toggle = (f: string) => {
    const next = closed.includes(f) ? closed.filter(x => x !== f) : [...closed, f];
    setClosed(next);
    try {
      localStorage.setItem(COLLAPSED(kind), JSON.stringify(next));
    } catch {
      // Remembered for this page only.
    }
  };

  const move = async (name: string, folder: string) => {
    const it = items.find(x => x.name === name);
    if (!it || it.folder === folder || it.scope === 'built-in' || !(await guard())) return;
    if (kind === 'role') await onSave({ cmd: 'role.update', name, changes: { folder } });
    else await onSave({ ...(it as unknown as Record<string, unknown>), cmd: 'workflow.save', folder, previous: { name, scope: it.scope } });
  };
  const dropOn = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG)) return;
      e.preventDefault();
      setOver(folder);
    },
    onDragLeave: () => setOver(o => (o === folder ? undefined : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(undefined);
      const d = JSON.parse(e.dataTransfer.getData(DRAG) || '{}') as { kind?: string; name?: string };
      if (d.kind === kind && d.name) void move(d.name, folder);
    },
  });

  const remove = async (f: string, count: number) => {
    setMenu(undefined);
    const ok = await confirm({
      title: `Remove the ${f} folder?`,
      body: count ? `The ${count} ${count === 1 ? kind : word} in it stay, out of any folder.${kind === 'role' ? ' Workflows that name the folder will name them one by one.' : ''}` : 'It’s empty.',
      confirm: 'Remove',
      danger: true,
    });
    if (ok) await onSave({ cmd: 'folder.delete', kind, name: f });
  };
  const removeAll = async (f: string, inside: T[]) => {
    setMenu(undefined);
    const ok = await confirm({
      title: `Delete ${f} and everything in it?`,
      body: <>These files go, and no copy is kept: {inside.map(x => x.name).join(', ')}.{kind === 'role' ? ' Workflows that name them will show a warning, and can’t start them.' : ''}</>,
      confirm: 'Delete all',
      danger: true,
    });
    if (ok) await onSave({ cmd: 'folder.delete', kind, name: f, contents: true });
  };

  return (
    <>
      <div className="folder-bar">
        <button className="btn ghost small" onClick={() => setNaming({})}>
          + Folder
        </button>
      </div>
      {folders.map(f => {
        const inside = items.filter(x => x.folder === f);
        const shut = closed.includes(f);
        return (
          <div key={f} className={`folder${over === f ? ' over' : ''}`} {...dropOn(f)}>
            <div className="folder-head">
              <button className="folder-toggle" aria-expanded={!shut} onClick={() => toggle(f)}>
                <span className="folder-caret" aria-hidden>
                  {shut ? '▸' : '▾'}
                </span>
                <b>{f}</b>
                <span className="muted small">{inside.length}</span>
              </button>
              <button className="btn ghost small folder-more" aria-label={`Actions for ${f}`} aria-expanded={menu === f} onClick={() => setMenu(m => (m === f ? undefined : f))}>
                ⋯
              </button>
            </div>
            {menu === f && (
              <div className="folder-menu">
                <button className="btn small" disabled={!inside.length} onClick={() => { setMenu(undefined); setExporting(f); }}>
                  Export…
                </button>
                <button className="btn small" onClick={() => { setMenu(undefined); setNaming({ previous: f }); }}>
                  Rename…
                </button>
                <button className="btn small" onClick={() => void remove(f, inside.length)}>
                  Remove folder
                </button>
                {inside.length > 0 && (
                  <button className="btn small danger" onClick={() => void removeAll(f, inside)}>
                    Delete with contents
                  </button>
                )}
              </div>
            )}
            {!shut && (
              <div className="folder-items">
                {inside.map(render)}
                {!inside.length && <div className="muted small folder-empty">Empty. Pick this folder on a {kind}, or drag one here.</div>}
              </div>
            )}
          </div>
        );
      })}
      {dragging && folders.length > 0 && (
        <div className={`folder-out${over === '' ? ' over' : ''}`} {...dropOn('')}>
          Drop here to take out of a folder
        </div>
      )}
      {naming && <FolderName kind={kind} previous={naming.previous} config={config} onSave={onSave} onClose={() => setNaming(undefined)} />}
      {exporting && <ExportDialog initial={{ name: exporting, items: items.filter(x => x.folder === exporting).map(x => ({ kind, name: x.name })) }} config={config} onCommand={onCommand} onClose={() => setExporting(undefined)} />}
    </>
  );
}

function FolderName({ kind, previous, config, onSave, onClose }: { kind: Kind; previous?: string; config?: ConfigView; onSave: SetupProps['onSave']; onClose: () => void }) {
  const [name, setName] = useState(previous ?? '');
  const scopes = config?.scopes ?? [];
  // Where an empty folder is made; it shows the same either way.
  const scope = scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal';
  const submit = async () => {
    if (await onSave({ cmd: 'folder.save', kind, name: name.trim(), ...(previous ? { previous } : { scope }) })) onClose();
  };
  return (
    <Dialog title={previous ? `Rename ${previous}` : `New ${kind} folder`} onClose={onClose}>
      <Field label="Name" hint={previous && kind === 'role' ? 'Workflows that name this folder follow the new name.' : undefined}>
        <input
          type="text"
          autoFocus
          value={name}
          placeholder="e.g. game-dev"
          onChange={e => setName(e.target.value.replace(/\s+/g, '-'))}
          onKeyDown={e => e.key === 'Enter' && name.trim() && void submit()}
        />
      </Field>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!name.trim() || name.trim() === previous} onClick={() => void submit()}>
          {previous ? 'Rename' : 'Make it'}
        </button>
      </div>
    </Dialog>
  );
}
