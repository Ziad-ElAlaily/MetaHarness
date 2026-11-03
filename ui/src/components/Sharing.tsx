import { useEffect, useState } from 'react';
import type { ConfigView, ItemKind, PackExport, PackRef, PackReview, Scope } from '../types.ts';
import { Dialog, Field, useConfirm } from './common.tsx';
import { ScopePicker, type SetupProps } from '../pages/setup.tsx';

/**
 * Sharing setup (design §23): the dialogs that write an export to a file and read one back, and
 * the buttons that open them. Importing is a reviewed copy: nothing remembers where it came from.
 */

const keyOf = (r: PackRef) => `${r.kind}/${r.name}`;

export const KIND_LABEL: Record<ItemKind, string> = { workflow: 'workflow', role: 'role', rule: 'rule', skill: 'skill', mcp: 'MCP server' };

/** Exporting one item, with what it needs. What ships with MetaHarness, everyone has already. */
export function ExportButton({ kind, name, scope, config, onCommand }: { kind: ItemKind; name: string; scope: string; config?: ConfigView; onCommand: SetupProps['onCommand'] }) {
  const [open, setOpen] = useState(false);
  if (scope === 'built-in') return null;
  return (
    <>
      <button className="btn small" onClick={() => setOpen(true)}>
        Export…
      </button>
      {open && <ExportDialog initial={{ name: name.replace(/:/g, '-'), items: [{ kind, name }] }} config={config} onCommand={onCommand} onClose={() => setOpen(false)} />}
    </>
  );
}

/* ---------------- writing a file ---------------- */

export interface ExportSpec {
  name: string;
  items: PackRef[];
  leaveOut?: PackRef[];
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What goes in the file, what to look at first, and the file. */
export function ExportDialog({ initial, config, onCommand, onClose }: { initial: ExportSpec; config?: ConfigView; onCommand: SetupProps['onCommand']; onClose: () => void }) {
  const [spec, setSpec] = useState(initial);
  const [nameText, setNameText] = useState(initial.name);
  const [allowSecrets, setAllowSecrets] = useState(false);
  const [r, setR] = useState<PackExport>();
  const [copied, setCopied] = useState(false);
  const [adding, setAdding] = useState('');
  // Anything else to send along: a workflow, a role, a rule, a skill.
  const addable = [
    ...(config?.workflows ?? []).filter(x => x.scope !== 'built-in').map(x => `workflow/${x.name}`),
    ...(config?.roles ?? []).filter(x => x.scope !== 'built-in').map(x => `role/${x.name}`),
    ...(config?.rules ?? []).filter(x => x.scope !== 'built-in').map(x => `rule/${x.name}`),
    ...(config?.skills ?? []).filter(x => x.source !== 'built-in').map(x => `skill/${x.name}`),
    ...(config?.mcp ?? []).map(x => `mcp/${x.name}`),
  ].filter(k => !r?.members.some(m => keyOf(m) === k));
  const add = () => {
    const [kind, ...rest] = adding.trim().split('/');
    const name = rest.join('/');
    setAdding('');
    if (!name || !addable.includes(`${kind}/${name}`)) return;
    setSpec(s => ({ ...s, items: [...s.items, { kind: kind as ItemKind, name }], leaveOut: (s.leaveOut ?? []).filter(x => keyOf(x) !== `${kind}/${name}`) }));
  };
  const specJson = JSON.stringify(spec);
  useEffect(() => {
    let live = true;
    void onCommand({ cmd: 'share.export', ...JSON.parse(specJson), allowSecrets }).then(x => {
      if (live && x) setR(x as unknown as PackExport);
    });
    return () => void (live = false);
    // onCommand changes with the project, and the dialog closes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specJson, allowSecrets]);
  const file = r?.text ? new File([r.text], r.filename, { type: 'application/json' }) : undefined;
  const canShare = !!file && !!navigator.canShare?.({ files: [file] });
  const secrets = r?.warnings.filter(w => w.level === 'secret') ?? [];
  const notes = r?.warnings.filter(w => w.level === 'info') ?? [];
  return (
    <Dialog title={`Export ${spec.name}`} onClose={onClose} wide>
      <Field label="Name" hint="Names the file. Several loose roles or workflows arrive in a folder of this name.">
        <input type="text" value={nameText} onChange={e => setNameText(e.target.value.replace(/\s+/g, '-'))} onBlur={() => nameText && setSpec(s => ({ ...s, name: nameText }))} />
      </Field>
      {!r && <div className="muted">Reading what goes in…</div>}
      {r && (
        <>
          <div className="pkg-members">
            {r.members.map(m => (
              <div key={keyOf(m)} className="pkg-member">
                <span className="tag">{KIND_LABEL[m.kind]}</span>
                <b>{m.name}</b>
                {m.via && <span className="muted small">for {m.via.split('/').slice(1).join('/')}</span>}
                <button
                  className="btn ghost small"
                  onClick={() =>
                    setSpec(s => (m.via ? { ...s, leaveOut: [...(s.leaveOut ?? []), { kind: m.kind, name: m.name }] } : { ...s, items: s.items.filter(x => keyOf(x) !== keyOf(m)) }))
                  }
                >
                  {m.via ? 'Leave out' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
          <div className="pkg-add">
            <input type="text" list="pkg-addable" aria-label="Add to the export" placeholder="Add something else, e.g. rule/api-style" value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), add())} />
            <datalist id="pkg-addable">
              {addable.map(k => (
                <option key={k} value={k} />
              ))}
            </datalist>
            <button className="btn small" disabled={!addable.includes(adding.trim())} onClick={add}>
              Add
            </button>
          </div>
          {r.suggested.length > 0 && (
            <div className="hint">
              These rules name a role in it:{' '}
              {r.suggested.map(x => (
                <button key={x.name} className="tag" onClick={() => setSpec(s => ({ ...s, items: [...s.items, x] }))}>
                  + {x.name}
                </button>
              ))}
            </div>
          )}
          {r.builtIn.length > 0 && <div className="hint">Comes with MetaHarness, so it isn’t packed: {r.builtIn.map(x => x.name).join(', ')}.</div>}
          {r.leftOut.length > 0 && <div className="hint">Left out; whoever imports it needs their own: {r.leftOut.map(x => x.name).join(', ')}.</div>}
          {notes.map((w, i) => (
            <div key={i} className="hint">
              <b>{w.item}</b>: {w.text}
            </div>
          ))}
          {secrets.length > 0 && (
            <div className="pkg-warn">
              <b>This looks like it holds secrets. Take them out before you share it.</b>
              {secrets.map((w, i) => (
                <div key={i}>
                  <span className="mono">{w.item}</span>: {w.text}
                </div>
              ))}
              {r.blocked && (
                <button className="btn small" onClick={() => setAllowSecrets(true)}>
                  It’s not a secret: export anyway
                </button>
              )}
            </div>
          )}
        </>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        {r?.text && navigator.clipboard && (
          <button
            className="btn"
            onClick={() =>
              void navigator.clipboard.writeText(r.text!).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
        {canShare && (
          <button className="btn" onClick={() => void navigator.share({ files: [file!], title: spec.name }).catch(() => {})}>
            Share…
          </button>
        )}
        <button className="btn primary" disabled={!r?.text} onClick={() => r?.text && download(r.filename, r.text)}>
          Download {r?.filename ?? ''}
        </button>
      </div>
    </Dialog>
  );
}

/* ---------------- reading a file ---------------- */

const STATUS: Record<string, string> = { new: 'new', same: 'already here', differs: 'yours differs' };

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

/**
 * A file someone sent: pick it or paste it, read what it would do, choose. Nothing is written
 * until Install.
 */
export function ImportDialog({ config, onSave, onCommand, onClose }: { config?: ConfigView; onSave: SetupProps['onSave']; onCommand: SetupProps['onCommand']; onClose: () => void }) {
  const [text, setText] = useState('');
  const [pasted, setPasted] = useState('');
  const [scope, setScope] = useState<Scope>(config?.scopes.some(s => s.scope === 'repo') ? 'repo' : 'personal');
  const [review, setReview] = useState<PackReview>();
  const [choose, setChoose] = useState<Record<string, boolean>>({});
  const [adapt, setAdapt] = useState<Record<string, { harness: string; model: string }>>({});
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const runnable = (config?.harnesses ?? []).filter(h => h.runnable);

  useEffect(() => {
    if (!text) return;
    let live = true;
    void onCommand({ cmd: 'share.review', scope, text }).then(r => {
      if (!live) return;
      if (!r) return setText('');
      const rv = r as unknown as PackReview;
      setReview(rv);
      setChoose(Object.fromEntries(rv.items.map(i => [keyOf(i), i.on])));
    });
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, scope]);

  const picked = (review?.items ?? []).filter(i => i.status !== 'same' && choose[keyOf(i)]);
  const install = async () => {
    if (!review) return;
    const replacing = picked.filter(i => i.status === 'differs');
    if (replacing.length && !(await confirm({ title: `Overwrite ${replacing.length === 1 ? 'yours' : `${replacing.length} of yours`}?`, body: <>{replacing.map(i => i.name).join(', ')}. No copy is kept.</>, confirm: 'Overwrite', danger: true }))) return;
    setBusy(true);
    const next = await onSave({ cmd: 'share.import', scope, text, choose, adapt });
    setBusy(false);
    if (next) onClose();
  };

  if (!review) {
    return (
      <Dialog title="Import" onClose={onClose}>
        <div className="dialog-body">A <span className="mono">.mh-export.json</span> file someone sent you, with roles, workflows, rules or anything else. You’ll see everything in it first. Once imported, it’s yours to change.</div>
        <Field label="The file">
          <input
            type="file"
            onChange={async e => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
              e.target.value = '';
            }}
          />
        </Field>
        <Field label="Or paste it">
          <textarea className="instructions pkg-paste" rows={4} value={pasted} onChange={e => setPasted(e.target.value)} placeholder='{ "format": "metaharness-export", …' />
        </Field>
        <div className="row end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!pasted.trim()} onClick={() => setText(pasted)}>
            Review
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={`Import ${review.name}`} onClose={onClose} wide>
      <Field label="Copy into" hint={(config?.scopes.length ?? 0) > 1 ? <span className="mono">{review.dir}</span> : undefined}>
        <ScopePicker config={config} value={scope} onChange={setScope} />
      </Field>
      <div className="hint">Agents follow what these files say, and some can run things on this machine. Read what you don’t recognise.</div>
      <div className="pkg-review">
        {review.items.map(i => {
          const key = keyOf(i);
          const same = i.status === 'same';
          const moved = adapt[i.name];
          return (
            <div key={key} className={`pkg-review-item${choose[key] && !same ? ' on' : ''}`}>
              <label className="pkg-review-head">
                <input type="checkbox" disabled={same} checked={same || !!choose[key]} onChange={e => setChoose(c => ({ ...c, [key]: e.target.checked }))} />
                <b>{i.name}</b>
                <span className="tag">{KIND_LABEL[i.kind]}</span>
                <span className={`tag pkg-status ${i.status}`}>{STATUS[i.status]}</span>
              </label>
              {i.sensitive && <div className="pkg-warn-line">{i.sensitive} It stays off unless you turn it on.</div>}
              {i.note && <div className="hint">{i.note}</div>}
              {i.powers.map(p => (
                <div key={p} className="pkg-power mono">
                  {p}
                </div>
              ))}
              {i.runs && i.runs.state !== 'here' && (
                <div className="pkg-route">
                  <span className={i.runs.state === 'no' && !moved ? 'warn-text' : 'muted'}>
                    It runs on {i.runs.harness}
                    {i.runs.model ? ` / ${i.runs.model}` : ''}, which isn’t here{i.runs.state === 'backup' ? `; its backup ${i.runs.backup} is` : ', and neither is a backup'}.
                  </span>
                  <span className="pkg-route-pick">
                    <select aria-label={`Run ${i.name} on`} value={moved?.harness ?? ''} onChange={e => setAdapt(({ [i.name]: _, ...rest }) => (e.target.value ? { ...rest, [i.name]: { harness: e.target.value, model: '' } } : rest))}>
                      <option value="">{i.runs.state === 'backup' ? 'Use its backup' : 'Leave it for now'}</option>
                      {runnable.map(h => (
                        <option key={h.id} value={h.id}>
                          Run on {h.title}
                        </option>
                      ))}
                    </select>
                    {moved && (
                      <>
                        <input type="text" list={`pkg-models-${moved.harness}`} placeholder="model (empty: its default)" value={moved.model} onChange={e => setAdapt(a => ({ ...a, [i.name]: { ...moved, model: e.target.value } }))} />
                        <datalist id={`pkg-models-${moved.harness}`}>
                          {(config?.harnesses.find(h => h.id === moved.harness)?.models ?? []).map(m => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      </>
                    )}
                  </span>
                </div>
              )}
              {i.blanks && <div className="hint">Left out by whoever sent it, for you to fill in on Tools &amp; skills: {i.blanks.join(', ')}.</div>}
              {i.files && (
                <div className="hint">
                  {i.files.length} {i.files.length === 1 ? 'file' : 'files'}: {i.files.slice(0, 12).map(f => `${f.path} (${size(f.bytes)})`).join(', ')}
                  {i.files.length > 12 ? ` and ${i.files.length - 12} more` : ''}
                </div>
              )}
              {i.text !== undefined && (
                <details className="pkg-read">
                  <summary>Read it</summary>
                  <pre className="pkg-text">{i.text}</pre>
                </details>
              )}
              {i.current !== undefined && (
                <details className="pkg-read">
                  <summary>Yours, as it is now</summary>
                  <pre className="pkg-text">{i.current}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
      {review.unmet.length > 0 && (
        <div className="pkg-warn">
          <b>It relies on things that aren’t in it or here:</b>
          {review.unmet.map(u => (
            <div key={keyOf(u)}>
              {KIND_LABEL[u.kind]} <span className="mono">{u.name}</span> (for {u.by.split('/').slice(1).join('/')})
              {u.kind === 'mcp' ? ': it may be in a harness’s own settings.' : '.'}
            </div>
          ))}
        </div>
      )}
      {review.needs.length > 0 && <div className="hint">Uses what comes with MetaHarness: {review.needs.map(n => n.name).join(', ')}.</div>}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !picked.length} onClick={() => void install()}>
          {busy ? 'Importing…' : picked.length ? `Import ${picked.length} ${picked.length === 1 ? 'item' : 'items'}` : 'Nothing to import'}
        </button>
      </div>
    </Dialog>
  );
}

/** The way in, on each tab. */
export function ImportButton({ config, onSave, onCommand }: { config?: ConfigView; onSave: SetupProps['onSave']; onCommand: SetupProps['onCommand'] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Import…
      </button>
      {open && <ImportDialog config={config} onSave={onSave} onCommand={onCommand} onClose={() => setOpen(false)} />}
    </>
  );
}
