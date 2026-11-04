import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { ago, bytes, oneLine } from '../format.ts';
import type { Agent, CanvasCard, Goal, PrototypeInfo } from '../types.ts';
import type { GodotRun, RoomView as Room } from '../roomData.ts';
import { Dialog, Field, Markdown, useConfirm } from './common.tsx';
import type { ContinueFrom } from './Dialogs.tsx';

type Cmd = (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;

const busy = (a?: Agent) => !!a && ['starting', 'working'].includes(a.state);

/** Where a prototype came from, in a few words. */
export function startLine(p: PrototypeInfo): string {
  const s = p.start;
  if (s.kind === 'small') return 'A small project of its own';
  if (s.kind === 'fork') return `Forked from ${s.from} v${s.version}`;
  if (s.kind === 'merge') return `Merged from ${s.from.map(f => `${f.id} v${f.version}`).join(' + ')}`;
  return `A copy of the game, frozen from ${s.source}${s.branch ? ` (${s.branch})` : ''}${s.commit ? ` at ${s.commit.slice(0, 7)}` : ''}${s.uncommitted ? ', with what wasn’t committed there' : ''}`;
}

export const verdictLabel: Record<string, string> = { keep: 'Keep', park: 'Parked', drop: 'Dropped' };

/** The values kept up to a version, each knob's latest. */
const keptNow = (p: PrototypeInfo) => Object.assign({}, ...p.kept.map(k => k.values)) as Record<string, number>;

/**
 * Prototypes from ideas: one each, with a builder of its own. From a copy of the game (frozen
 * once, so they merge cleanly) or a small project of their own.
 */
export function PrototypeDialog({ goal, ideas: initial, onClose, onCommand, onStarted }: { goal: Goal; ideas: { title: string; ask: string; card?: string }[]; onClose: () => void; onCommand: Cmd; onStarted?: () => void }) {
  const [ideas, setIdeas] = useState(initial.length ? initial : [{ title: '', ask: '' }]);
  const [from, setFrom] = useState<'game' | 'small'>('game');
  const [source, setSource] = useState('');
  const [checkouts, setCheckouts] = useState<{ path: string; branch?: string; dirty: boolean }[]>();
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let alive = true;
    api.command<{ checkouts: { path: string; branch?: string; dirty: boolean }[] }>({ cmd: 'room.checkouts', goal: goal.id }).then(
      r => {
        if (alive) setCheckouts(r.checkouts);
      },
      () => alive && setCheckouts([]),
    );
    return () => {
      alive = false;
    };
  }, [goal.id]);
  const picked = checkouts?.find(c => c.path === source) ?? checkouts?.[0];
  const ready = ideas.some(i => i.title.trim());
  const submit = async () => {
    setSending(true);
    const r = await onCommand({ cmd: 'room.prototype', goal: goal.id, from, ...(from === 'game' && source ? { source } : {}), ideas: ideas.filter(i => i.title.trim()).map(i => ({ title: i.title.trim(), ask: i.ask.trim() || undefined, card: i.card })) });
    setSending(false);
    if (r) {
      onStarted?.();
      onClose();
    }
  };
  return (
    <Dialog title={ideas.length > 1 ? `${ideas.length} prototypes` : 'A prototype'} onClose={onClose} wide>
      <div className="dialog-body muted small">Each gets its own copy and its own builder, and they all start now. You try and change each one without touching the others, or your project.</div>
      <Field label="Ideas">
        <div className="mix-list">
          {ideas.map((idea, i) => (
            <div key={i} className="proto-idea">
              <input type="text" value={idea.title} autoFocus={i === 0} onChange={e => setIdeas(l => l.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="A few words, e.g. Camera shake" aria-label="What to call it" />
              <textarea rows={2} value={idea.ask} onChange={e => setIdeas(l => l.map((x, j) => (j === i ? { ...x, ask: e.target.value } : x)))} placeholder="What to try" aria-label="What to try" />
              {ideas.length > 1 && (
                <button className="btn ghost small" onClick={() => setIdeas(l => l.filter((_, j) => j !== i))} aria-label="Leave this one out">
                  ×
                </button>
              )}
            </div>
          ))}
          <button className="btn ghost small" onClick={() => setIdeas(l => [...l, { title: '', ask: '' }])}>
            + Another idea
          </button>
        </div>
      </Field>
      <Field label="Start from">
        <div className="proto-from">
          <label className="check small">
            <input type="radio" name="proto-from" checked={from === 'game'} onChange={() => setFrom('game')} />
            <span>A copy of the game, as it stands: best for polishing something that’s already in it</span>
          </label>
          <label className="check small">
            <input type="radio" name="proto-from" checked={from === 'small'} onChange={() => setFrom('small')} />
            <span>A small project of its own: quick, for trying a mechanic away from the game</span>
          </label>
          {from === 'game' && checkouts && checkouts.length > 1 && (
            <select value={source} onChange={e => setSource(e.target.value)} aria-label="Which checkout to copy">
              {checkouts.map((c, i) => (
                <option key={c.path} value={i ? c.path : ''}>
                  {c.path}
                  {c.branch ? ` (${c.branch})` : ''}
                  {c.dirty ? ', with uncommitted changes' : ''}
                </option>
              ))}
            </select>
          )}
          {from === 'game' && picked?.dirty && <div className="muted small">It has uncommitted changes: the copy takes them as they are, and stays that way as the game moves on.</div>}
        </div>
      </Field>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={sending || !ready} onClick={() => void submit()}>
          {sending ? 'Starting…' : 'Start'}
        </button>
      </div>
    </Dialog>
  );
}

/** One prototype from several. Shows what git says first, changing nothing. */
export function MergeDialog({ goal, prototypes, onClose, onCommand }: { goal: Goal; prototypes: PrototypeInfo[]; onClose: () => void; onCommand: Cmd }) {
  const [title, setTitle] = useState(prototypes.map(p => p.title).join(' + ').slice(0, 60));
  const [ask, setAsk] = useState('');
  const [preview, setPreview] = useState<{ conflicts: string[]; unrelated: string[]; failed?: string }>();
  const [sending, setSending] = useState(false);
  const from = prototypes.map(p => ({ id: p.id }));
  useEffect(() => {
    let alive = true;
    api.command<{ conflicts: string[]; unrelated: string[] }>({ cmd: 'room.prototypeMergePreview', goal: goal.id, from }).then(
      r => {
        if (alive) setPreview(r);
      },
      e => alive && setPreview({ conflicts: [], unrelated: [], failed: String((e as Error).message) }),
    );
    return () => {
      alive = false;
    };
    // Asked once, for the prototypes the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goal.id]);
  const submit = async () => {
    setSending(true);
    const r = await onCommand({ cmd: 'room.prototypeMerge', goal: goal.id, from, title: title.trim(), ask: ask.trim() || undefined });
    setSending(false);
    if (r) onClose();
  };
  return (
    <Dialog title="Merge prototypes" onClose={onClose} wide>
      <div className="dialog-body muted small">A new prototype with all of these in it, at their latest versions, so you can play them together. The originals stay as they are.</div>
      <div className="dialog-body proto-preview">
        {!preview ? (
          <span className="muted small">Asking git…</span>
        ) : preview.failed ? (
          <span className="warn-text small">{preview.failed}</span>
        ) : (
          <>
            {!preview.conflicts.length && !preview.unrelated.length && <span className="small">These merge cleanly.</span>}
            {preview.conflicts.length > 0 && <span className="small">Conflicts for the builder to settle: <span className="mono">{preview.conflicts.join(', ')}</span></span>}
            {preview.unrelated.length > 0 && <span className="small">{preview.unrelated.join(', ')} started elsewhere, so git can’t merge {preview.unrelated.length > 1 ? 'them' : 'it'}: the builder ports what {preview.unrelated.length > 1 ? 'they prove' : 'it proves'} by hand.</span>}
          </>
        )}
      </div>
      <Field label="Call it">
        <input type="text" value={title} autoFocus onChange={e => setTitle(e.target.value)} />
      </Field>
      <Field label="What to check">
        <textarea rows={2} value={ask} onChange={e => setAsk(e.target.value)} placeholder="e.g. does the shake still read during the hit-stop?" />
      </Field>
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={sending || !title.trim()} onClick={() => void submit()}>
          {sending ? 'Starting…' : 'Merge'}
        </button>
      </div>
    </Dialog>
  );
}

/** The Run button: a window on the machine running MetaHarness, and what it says back. */
function RunRow({ goal, p, run, live, onCommand }: { goal: Goal; p: PrototypeInfo; run?: GodotRun; live: boolean; onCommand: Cmd }) {
  const on = run && run.state !== 'stopped';
  const send = (stop?: boolean) => void onCommand({ cmd: 'room.prototypeRun', goal: goal.id, id: p.id, ...(stop ? { stop: true } : {}) });
  if (p.godot === undefined) return <div className="muted small">This one has no Godot project to open.</div>;
  return (
    <div className="demo-player">
      <div className="row start">
        <button className="btn small primary" disabled={!live} onClick={() => send()} title="Opens a window on the machine running MetaHarness. F10 in the game shows the sliders.">
          {on ? '↻ Restart' : '▶ Run'}
        </button>
        {on && (
          <button className="btn ghost small" onClick={() => send(true)}>
            ■ Stop
          </button>
        )}
        {on && <span className="muted small">{run.state === 'importing' ? 'Importing…' : run.host ? `Running on ${run.host}` : 'Running'}</span>}
        <span className="grow" />
        <label className="check small" title="Reopens it after each change, when it’s running">
          <input type="checkbox" checked={p.rerun} disabled={!live} onChange={e => void onCommand({ cmd: 'room.prototypeRerun', goal: goal.id, id: p.id, rerun: e.target.checked })} />
          Reopen on change
        </label>
      </div>
      {p.scene && <div className="muted small">Opens at <span className="mono">{p.scene}</span></div>}
      {run?.problem && <pre className="godot-log">{run.problem}</pre>}
      {!!run?.errors.length && <pre className="godot-log">{run.errors.join('\n')}</pre>}
    </div>
  );
}

/** A prototype in full, in its card's panel: run it, ask its builder, its versions, its verdict. */
export function PrototypeBody({ goal, card, room, live: roomLive, onCommand, onContinue, onRoom, onStartOver }: { goal: Goal; card: CanvasCard; room: Room; live: boolean; onCommand: Cmd; onContinue?: (f: ContinueFrom) => void; onRoom: (id: string) => void; onStartOver: (p: PrototypeInfo) => void }) {
  const p = room.prototypes.find(x => x.id === card.prototype);
  const builder = goal.agents.find(a => a.name === card.prototype);
  const [ask, setAsk] = useState('');
  const [why, setWhy] = useState<string>();
  const [forking, setForking] = useState<{ version: number; title: string; ask: string }>();
  const [notes, setNotes] = useState<{ notes: string; process: string }>();
  useEffect(() => {
    if (p?.verdict?.why) setWhy(w => w ?? p.verdict!.why);
  }, [p?.verdict?.why]);
  if (!p) return <div className="muted small">{card.pending ? 'Making the copy…' : 'This prototype isn’t there any more.'}</div>;
  const moved = !!p.room && p.room !== goal.id;
  const live = roomLive && !moved;
  const send = async () => {
    if (!ask.trim()) return;
    if (await onCommand({ cmd: 'room.ask', goal: goal.id, maker: p.id, text: ask.trim() })) setAsk('');
  };
  const verdict = (kind?: string) => void onCommand({ cmd: 'room.prototypeVerdict', goal: goal.id, id: p.id, ...(kind ? { kind } : {}), ...(why?.trim() ? { why: why.trim() } : {}) });
  const fork = async () => {
    if (!forking?.title.trim()) return;
    if (await onCommand({ cmd: 'room.prototypeFork', goal: goal.id, id: p.id, version: forking.version, title: forking.title.trim(), ask: forking.ask.trim() || undefined })) setForking(undefined);
  };
  const kept = keptNow(p);
  const toGoal = p.verdict?.version ?? p.versions[p.versions.length - 1].n;
  return (
    <div className="proto-body">
      {moved && (
        <div className="warn-text small">
          It moved to another room.{' '}
          <button className="btn ghost small" onClick={() => onRoom(p.room!)}>
            Open that room
          </button>
        </div>
      )}
      <div className="muted small">{startLine(p)}</div>
      <RunRow goal={goal} p={p} run={room.godot[`prototype:${p.id}`]} live={live} onCommand={onCommand} />
      {p.conflicts?.length ? <div className="warn-text small">Conflicts left in <span className="mono">{p.conflicts.join(', ')}</span>. Ask the builder to finish them.</div> : null}
      {live && (
        <div className="proto-ask">
          <textarea rows={2} value={ask} onChange={e => setAsk(e.target.value)} onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }} placeholder={builder ? 'Tell its builder what to change' : 'Tell its builder what to try first'} aria-label="What to change" />
          <div className="row start">
            <button className="btn small primary" disabled={!ask.trim()} onClick={() => void send()}>
              Send
            </button>
            {busy(builder) && (
              <>
                <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.stop', goal: goal.id, agent: p.id })} title="Stop it: what it has so far is a version, and it listens again">
                  ■ Stop the builder
                </button>
                <span className="spinner" />
                <span className="muted small ellipsis">{builder?.status ? oneLine(builder.status, 70) : 'Working…'}</span>
              </>
            )}
          </div>
        </div>
      )}
      {Object.keys(kept).length > 0 && (
        <div className="panel-section">
          <div className="kicker">Values you kept</div>
          <table className="values-table">
            <tbody>
              {Object.entries(kept).map(([n, v]) => (
                <tr key={n}>
                  <td className="mono">{n}</td>
                  <td className="mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-section">
        <div className="kicker">Versions</div>
        <ol className="proto-versions" reversed>
          {[...p.versions].reverse().map((v, i) => (
            <li key={v.n} className={p.verdict?.version === v.n ? 'kept' : ''}>
              <span className="mono proto-v">v{v.n}</span>
              <span className="proto-note" title={v.note}>{oneLine(v.note, 90)}</span>
              <span className="t meta">{ago(v.at)}</span>
              {live && (
                <span className="proto-v-actions">
                  {i > 0 && (
                    <button className="btn ghost small" onClick={() => void onCommand({ cmd: 'room.prototypeRestore', goal: goal.id, id: p.id, version: v.n })} title="Back to how this version was, as a new version: nothing is lost">
                      Back to this
                    </button>
                  )}
                  <button className="btn ghost small" onClick={() => setForking({ version: v.n, title: '', ask: '' })} title="A variation from here, with a builder of its own; this one stays as it is">
                    ⑂ Fork
                  </button>
                </span>
              )}
            </li>
          ))}
        </ol>
        {forking && (
          <div className="proto-ask">
            <input type="text" autoFocus value={forking.title} onChange={e => setForking({ ...forking, title: e.target.value })} placeholder={`A variation of v${forking.version}, in a few words`} aria-label="What to call the fork" />
            <textarea rows={2} value={forking.ask} onChange={e => setForking({ ...forking, ask: e.target.value })} placeholder="What to try differently (or leave it, and ask later)" aria-label="What to try" />
            <div className="row start">
              <button className="btn small primary" disabled={!forking.title.trim()} onClick={() => void fork()}>
                Fork v{forking.version}
              </button>
              <button className="btn ghost small" onClick={() => setForking(undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="panel-section">
        <div className="kicker">Verdict{p.verdict ? `: ${verdictLabel[p.verdict.kind]}, at v${p.verdict.version}` : ''}</div>
        <input type="text" value={why ?? ''} disabled={!live} onChange={e => setWhy(e.target.value)} placeholder="What it taught you" aria-label="What it taught you" />
        <div className="row start">
          {(['keep', 'park', 'drop'] as const).map(k => (
            <button key={k} className={`btn small${p.verdict?.kind === k ? ' on' : ''}`} disabled={!live} onClick={() => verdict(k)}>
              {k === 'keep' ? '✓ Keep' : k === 'park' ? 'Park' : '✗ Drop'}
            </button>
          ))}
          {p.verdict && live && (
            <button className="btn ghost small" onClick={() => verdict()}>
              Undo
            </button>
          )}
          <span className="grow" />
          {onContinue && (
            <button className={`btn small${p.verdict?.kind === 'keep' ? ' primary' : ''}`} onClick={() => onContinue({ id: p.id, label: p.title, kind: 'prototype', version: toGoal })} title="A goal of its own that builds this properly: it can read and play the prototype, with its notes, process and kept values">
              → Goal
            </button>
          )}
        </div>
      </div>
      <details
        className="proto-notes"
        onToggle={e => {
          if ((e.target as HTMLDetailsElement).open) void api.command<{ notes: string; process: string }>({ cmd: 'prototype.notes', project: goal.project, id: p.id }).then(setNotes, () => setNotes({ notes: '', process: '' }));
        }}
      >
        <summary className="kicker">Notes and process</summary>
        {!notes ? <div className="muted small">Reading…</div> : <Markdown text={[notes.notes, notes.process].filter(Boolean).join('\n\n---\n\n') || '(nothing yet)'} />}
      </details>
      {live && (
        <button className="btn ghost small" onClick={() => onStartOver(p)} title="Try it again from another starting point. This one is dropped.">
          ↺ Start over…
        </button>
      )}
    </div>
  );
}

/** Every prototype of a project: they outlast their rooms, until you delete them. */
export function PrototypesList({ project, onCommand, onContinue, onOpenRoom }: { project?: string; onCommand: Cmd; onContinue?: (f: ContinueFrom) => void; onOpenRoom: (id: string) => void }) {
  const [list, setList] = useState<(PrototypeInfo & { bytes: number; roomOpen: boolean })[]>();
  const confirm = useConfirm();
  const load = () => {
    if (!project) return;
    void api.command<{ prototypes: (PrototypeInfo & { bytes: number; roomOpen: boolean })[] }>({ cmd: 'prototype.list', project }).then(r => setList(r.prototypes), () => setList([]));
  };
  useEffect(load, [project]);
  if (!list?.length) return null;
  const remove = async (p: PrototypeInfo & { bytes: number }) => {
    const ok = await confirm({ title: `Delete ${p.title}?`, body: `Its folder (${bytes(p.bytes)}) and every version go for good. Goals built from it keep what was copied to them.`, confirm: 'Delete', danger: true });
    if (!ok) return;
    await onCommand({ cmd: 'prototype.delete', project, id: p.id });
    load();
  };
  return (
    <section className="proto-list">
      <h2>Prototypes</h2>
      <div className="muted small">They stay until you delete them, even after their room closes. Together they keep {bytes(list.reduce((n, p) => n + p.bytes, 0))} on disk.</div>
      {list.map(p => (
        <div key={p.id} className="proto-row">
          <span className="proto-title">
            <b>{p.title}</b> <span className="muted small">v{p.versions[p.versions.length - 1].n}{p.verdict ? ` · ${verdictLabel[p.verdict.kind]}` : ''}</span>
            <div className="muted small ellipsis">{startLine(p)}</div>
          </span>
          <span className="muted small">{ago(p.createdAt)}</span>
          <span className="muted small num">{bytes(p.bytes)}</span>
          <span className="row">
            {p.roomOpen && p.room && (
              <button className="btn ghost small" onClick={() => onOpenRoom(p.room!)}>
                Open its room
              </button>
            )}
            {onContinue && (
              <button className="btn small" onClick={() => onContinue({ id: p.id, label: p.title, kind: 'prototype', version: p.verdict?.version ?? p.versions[p.versions.length - 1].n })}>
                → Goal
              </button>
            )}
            <button className="btn ghost small danger" disabled={p.roomOpen} title={p.roomOpen ? 'Close its room first' : undefined} onClick={() => void remove(p)}>
              Delete
            </button>
          </span>
        </div>
      ))}
    </section>
  );
}
