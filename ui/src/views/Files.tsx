import { useEffect, useMemo, useState } from 'react';
import { api, isImage, mediaUrl } from '../api.ts';
import { ago, who } from '../format.ts';
import type { Goal, MhEvent, SharedFileView } from '../types.ts';
import { CopyText, Markdown } from '../components/common.tsx';
import { Splitter } from '../components/Splitter.tsx';
import { useBackCloses } from '../phone.ts';

export interface FileInfo {
  path: string;
  version: number;
  owner?: string;
  lastBy?: string;
  ts: string;
  deleted: boolean;
  clashes: number;
  /** Who wrote it, and how many times, in the order they first did. */
  writers: Record<string, number>;
}

/** The shared folder as the event log knows it: every file, its latest version, who owns and last wrote it. */
export function filesOf(events: MhEvent[]): FileInfo[] {
  const files = new Map<string, FileInfo>();
  for (const e of events) {
    if (!e.type.startsWith('shared.')) continue;
    const path = String(e.data.path);
    const f = files.get(path) ?? { path, version: 0, ts: e.ts, deleted: false, clashes: 0, writers: {} };
    if (e.type === 'shared.write') {
      f.version = Number(e.data.version) || f.version + 1;
      f.lastBy = e.agent;
      f.owner ??= e.agent;
      if (e.agent) f.writers[e.agent] = (f.writers[e.agent] ?? 0) + 1;
      f.ts = e.ts;
      f.deleted = false;
    } else if (e.type === 'shared.delete') {
      f.deleted = true;
      f.ts = e.ts;
    } else if (e.type === 'shared.clash') f.clashes++;
    files.set(path, f);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function Files({ goal, events, selected, onSelect, onSelectAgent, onGoalFrom }: { goal: Goal; events: MhEvent[]; selected?: string; onSelect: (path?: string) => void; onSelectAgent: (n: string) => void; onGoalFrom?: (path: string) => void }) {
  const files = useMemo(() => filesOf(events), [events]);
  const current = files.find(f => f.path === selected) ?? files.find(f => !f.deleted && /report|design/i.test(f.path)) ?? files[0];
  useBackCloses(!!selected, () => onSelect(undefined));
  return (
    <div className={`files${selected ? ' file-open' : ''}`}>
      <div className="file-list">
        <div className="file-list-head">
          <span className="muted">shared/</span>
          <span className="muted">{files.length} files</span>
        </div>
        {files.map(f => (
          <button key={f.path} className={`file-row${current?.path === f.path ? ' on' : ''}${f.deleted ? ' deleted' : ''}`} onClick={() => onSelect(f.path)}>
            <span className="path">{f.path}</span>
            <span className="sub">
              v{f.version} · {who(f.lastBy) || 'someone'} · {ago(f.ts)}
              {f.clashes > 0 && <span className="warn-text"> · {f.clashes} clash{f.clashes > 1 ? 'es' : ''}</span>}
            </span>
          </button>
        ))}
        {!files.length && <div className="empty">Nobody has written to the shared folder yet. Designs, reviews and reports land here.</div>}
      </div>
      <Splitter pane="files" grow="right" min={160} max={700} label="File list" />
      <div className="file-view">
        <button className="btn ghost small file-back" onClick={() => onSelect(undefined)}>
          ← Files
        </button>
        {current ? <Viewer key={current.path} goal={goal} file={current} onSelectAgent={onSelectAgent} onGoalFrom={onGoalFrom} /> : <div className="empty">Pick a file.</div>}
      </div>
    </div>
  );
}

export function Viewer({ goal, file, onSelectAgent, onGoalFrom }: { goal: Goal; file: FileInfo; onSelectAgent: (n: string) => void; onGoalFrom?: (path: string) => void }) {
  const [version, setVersion] = useState<number>();
  const [view, setView] = useState<SharedFileView>();
  const [error, setError] = useState<string>();
  const [raw, setRaw] = useState(false);
  const md = /\.(md|markdown|txt)$/i.test(file.path);
  // An SVG is both: a picture, with text behind it.
  const hasSource = md || /\.svg$/i.test(file.path);
  useEffect(() => {
    let alive = true;
    api.file(goal.id, file.path, version).then(
      v => alive && (setView(v), setError(undefined)),
      e => alive && setError((e as Error).message),
    );
    return () => {
      alive = false;
    };
    // A new version reloads the latest.
  }, [goal.id, file.path, version, version === undefined ? file.version : 0]);
  const showImage = isImage(file.path) && !!view?.exists && !raw;
  // &v= so a new version of the file shows as soon as it's written.
  const src = `${mediaUrl(goal.id, file.path)}${version !== undefined ? `&version=${version}` : ''}&v=${file.version}`;

  return (
    <>
      <div className="file-head">
        <div className="file-title">
          <b className="mono">{file.path}</b>
          <span className="muted">
            {/* The first to write it owns it, so it leads the list. */}
            {Object.keys(file.writers).length > 0 && (
              <>
                written by{' '}
                {Object.entries(file.writers).map(([by, n], i) => (
                  <span key={by}>
                    {i > 0 && ', '}
                    <button className="name-link" title={by === file.owner ? 'Owns it: wrote it first' : undefined} onClick={() => by !== 'human' && onSelectAgent(by)}>
                      {who(by)}
                    </button>
                    {n > 1 && ` ×${n}`}
                  </span>
                ))}
              </>
            )}
            {file.deleted && ' · deleted'}
          </span>
        </div>
        <div className="row">
          {view && view.versions.length > 1 && (
            <select value={version ?? ''} onChange={e => setVersion(e.target.value ? Number(e.target.value) : undefined)} aria-label="Version">
              <option value="">Latest (v{file.version})</option>
              {[...view.versions].reverse().map(v => (
                <option key={v.version} value={v.version}>
                  v{v.version} by {who(v.by)}
                </option>
              ))}
            </select>
          )}
          {hasSource && (
            <button className={`btn small${raw ? ' on' : ''}`} onClick={() => setRaw(r => !r)}>
              {raw ? 'Rendered' : 'Source'}
            </button>
          )}
          {onGoalFrom && !file.deleted && (
            <button className="btn small" onClick={() => onGoalFrom(file.path)} title="A new goal with this file copied into its shared folder">
              New goal from this
            </button>
          )}
        </div>
      </div>
      <div className="scroll file-body">
        {error && <div className="error-text">{error}</div>}
        {view && !view.exists && <div className="empty">This file isn't there any more{view.versions.length ? '; pick a kept version above.' : '.'}</div>}
        {showImage && <SharedImage key={src} src={src} name={file.path} size={view.size} />}
        {view?.binary && !showImage && <div className="empty">This isn't a text file ({Math.round(view.size / 1024)} KB).</div>}
        {view?.text != null && !showImage && (md && !raw ? <Markdown text={view.text} className="doc" /> : <pre className="code">{view.text}</pre>)}
        {view && <CopyText text={`${goal.sharedDir}/${file.path}`} />}
      </div>
    </>
  );
}

/** A picture in the viewer, or what's known about it if the browser can't draw it. */
function SharedImage({ src, name, size }: { src: string; name: string; size: number }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="empty">This image can't be shown ({Math.round(size / 1024)} KB).</div>;
  return (
    <a className="file-image" href={src} target="_blank" rel="noreferrer" title="Open it full size">
      <img src={src} alt={name} onError={() => setBroken(true)} />
    </a>
  );
}

/** A shared file read in a side panel, by its path. */
export function FileSide({ goal, events, path, onSelectAgent }: { goal: Goal; events: MhEvent[]; path: string; onSelectAgent: (n: string) => void }) {
  const info = useMemo(() => filesOf(events).find(f => f.path === path), [events, path]);
  return <div className="file-view side-file">{info ? <Viewer goal={goal} file={info} onSelectAgent={onSelectAgent} /> : <div className="empty">Nobody has written {path}.</div>}</div>;
}
