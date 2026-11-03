import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { api, isImage, mediaUrl } from '../api.ts';
import { bytes } from '../format.ts';

/**
 * Files in a message (design §14). A message stays text: the file goes in the shared folder when
 * you send, and the message says where, in a line of its own. That line is all an agent needs, on
 * any harness; the app shows it as a picture or a chip. Nothing is uploaded until you send, so a
 * file you change your mind about leaves nothing behind.
 */

/** As the daemon's limit: said on attaching, not after a long upload. */
const MAX_BYTES = 100 * 1024 * 1024;
/** Past either of these, an image an agent looks at can make all its later calls fail (the large-images rule). */
const SMALL_BYTES = 1024 * 1024;
const SMALL_SIDE = 1600;

interface Draft {
  id: number;
  file: File;
  /** For a picture: its thumbnail, while it's a draft. */
  preview?: string;
  /** What to tell the agent, once uploaded. A send that failed after this doesn't upload it again. */
  line?: string;
}

/** A smaller copy of a big photo or screenshot, or nothing if it's small enough or the browser can't read it. */
async function smallerCopy(file: File): Promise<Blob | undefined> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return undefined;
  const img = await createImageBitmap(file).catch(() => undefined);
  if (!img) return undefined;
  const longest = Math.max(img.width, img.height);
  if (file.size <= SMALL_BYTES && longest <= SMALL_SIDE) {
    img.close();
    return undefined;
  }
  const scale = Math.min(1, SMALL_SIDE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d')!;
  // JPEG has no transparency: what's see-through goes white, not black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return new Promise(resolve => canvas.toBlob(b => resolve(b ?? undefined), 'image/jpeg', 0.85));
}

/** Uploads a file, and returns the line that tells an agent about it. */
async function uploadOne(goal: string, file: File): Promise<string> {
  const name = file.name || 'pasted';
  const saved = await api.upload(goal, name, file);
  if (!file.type.startsWith('image/')) return `[Attached: ${saved.abs} (${bytes(saved.size)})]`;
  const small = await smallerCopy(file);
  if (small) {
    const copy = await api.upload(goal, `${name.replace(/\.[^.]*$/, '')}-small.jpg`, small);
    return `[Attached image: ${copy.abs} (a smaller copy, ${bytes(copy.size)}. The original is ${saved.abs}, ${bytes(saved.size)}: looking at it could make your later calls fail)]`;
  }
  return `[Attached image: ${saved.abs} (${bytes(saved.size)}${saved.size > SMALL_BYTES ? ': too big to look at directly, so make a smaller copy first' : ''})]`;
}

/**
 * A new goal or room has no shared folder until it starts, so its files wait in a draft. Not
 * crypto.randomUUID: that needs https, and a phone may well reach the app over plain http.
 */
export const newDraft = () => `draft-${[...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('')}`;

/** What goal.start and room.start take for the files uploaded to a draft. */
export const startFiles = (draft: string, lines: string[]) => (lines.length ? { attach: { draft, lines } } : {});

/** A message's text with what's attached to it, for sending. */
export function withAttachments(text: string, lines: string[]): string {
  return [text.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
}

const LINE = /^\[Attached( image)?: (\/.+?) \((.*)\)\]$/gm;
const lastName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export interface AttachedFile {
  abs: string;
  name: string;
  /** Its place in the shared folder. */
  path?: string;
  note: string;
  image: boolean;
}

/** Splits a message into what was said and the files it names. */
export function attachmentsIn(text: string): { said: string; files: AttachedFile[] } {
  const files = [...text.matchAll(LINE)].map(m => ({
    abs: m[2],
    name: lastName(m[2]),
    path: /\/shared\/((?:room\/)?uploads\/[^/]+)$/.exec(m[2])?.[1],
    note: m[3],
    image: !!m[1] && isImage(m[2]),
  }));
  return { said: files.length ? text.replace(LINE, '').trim() : text, files };
}

/** A message on one line's worth of room: each file as its name, without the path. */
export function shortAttachments(text: string): string {
  return text.replace(LINE, (_all, _image, abs: string) => `📎 ${lastName(abs)}`);
}

/** What was said, through `children`, and below it what came with it. `onOpen` shows a shared file. */
export function Attached({ goal, text, onOpen, children }: { goal: string; text: string; onOpen?: (path: string) => void; children: (said: string) => ReactNode }) {
  const { said, files } = attachmentsIn(text);
  return (
    <>
      {said && children(said)}
      {files.length > 0 && (
        <div className="attached">
          {files.map(f => (
            <AttachedOne key={f.abs} goal={goal} file={f} onOpen={onOpen} />
          ))}
        </div>
      )}
    </>
  );
}

/** A picture, or a chip for anything else: including a picture the browser can't show, or that's since been deleted. */
function AttachedOne({ goal, file: f, onOpen }: { goal: string; file: AttachedFile; onOpen?: (path: string) => void }) {
  const [broken, setBroken] = useState(false);
  if (f.image && f.path && !broken) {
    return (
      <a href={mediaUrl(goal, f.path)} target="_blank" rel="noreferrer" title={`${f.name} (${f.note}). Open it full size`}>
        <img className="attached-image" src={mediaUrl(goal, f.path)} alt={f.name} loading="lazy" onError={() => setBroken(true)} />
      </a>
    );
  }
  if (f.path && onOpen && !broken) {
    return (
      <button className="file-chip" onClick={() => onOpen(f.path!)} title={f.note}>
        📎 {f.name}
      </button>
    );
  }
  return (
    <span className="file-chip plain" title={broken ? `${f.name} can't be shown here` : f.note}>
      📎 {f.name}
    </span>
  );
}

export interface Attachments {
  drafts: Draft[];
  busy: boolean;
  error?: string;
  add: (files: Iterable<File>) => void;
  remove: (id: number) => void;
  /** Every draft uploaded, as the lines to send; undefined if that failed or one is already going, and the drafts stay. */
  upload: () => Promise<string[] | undefined>;
  clear: () => void;
  /** Put on the composer: the pane it sits in takes dropped files. */
  zone: (el: HTMLElement | null) => void | (() => void);
  onPaste: (e: ClipboardEvent) => void;
}

/** What a composer has attached so far. `goal` is whose shared folder they'll go in. */
export function useAttachments(goal: string): Attachments {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const next = useRef(1);
  const going = useRef(false);
  const live = useRef(drafts);
  live.current = drafts;

  const add = useCallback((files: Iterable<File>) => {
    const fresh: Draft[] = [];
    let problem: string | undefined;
    for (const file of files) {
      if (file.size > MAX_BYTES) problem = `${file.name} is too big to attach (${bytes(file.size)}; the limit is ${bytes(MAX_BYTES)}).`;
      else fresh.push({ id: next.current++, file, preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined });
    }
    setError(problem);
    if (fresh.length) setDrafts(d => [...d, ...fresh]);
  }, []);

  const drop = (d: Draft) => d.preview && URL.revokeObjectURL(d.preview);
  const remove = (id: number) => {
    live.current.filter(d => d.id === id).forEach(drop);
    setDrafts(d => d.filter(x => x.id !== id));
    setError(undefined);
  };
  const clear = useCallback(() => {
    live.current.forEach(drop);
    setDrafts([]);
    setError(undefined);
  }, []);
  useEffect(() => () => live.current.forEach(drop), []);

  const upload = async () => {
    if (going.current) return undefined;
    going.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const lines: string[] = [];
      for (const d of live.current) {
        d.line ??= await uploadOne(goal, d.file);
        lines.push(d.line);
      }
      return lines;
    } catch (e) {
      setError(`Couldn't attach that: ${(e as Error).message}`);
      return undefined;
    } finally {
      going.current = false;
      setBusy(false);
    }
  };

  const zone = useCallback(
    (el: HTMLElement | null) => {
      const pane = el?.parentElement;
      if (!pane) return;
      const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
      const over = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        pane.classList.add('drop-here');
      };
      const leave = (e: DragEvent) => {
        if (!pane.contains(e.relatedTarget as Node | null)) pane.classList.remove('drop-here');
      };
      const dropped = (e: DragEvent) => {
        pane.classList.remove('drop-here');
        if (!hasFiles(e)) return;
        e.preventDefault();
        // A folder comes through as a file that can't be read.
        const folders = new Set([...e.dataTransfer!.items].filter(i => i.webkitGetAsEntry?.()?.isDirectory).map(i => i.getAsFile()?.name));
        const files = [...e.dataTransfer!.files].filter(f => !folders.has(f.name));
        add(files);
        if (folders.size) setError("A folder can't be attached: drop the files in it.");
      };
      pane.addEventListener('dragover', over);
      pane.addEventListener('dragleave', leave);
      pane.addEventListener('drop', dropped);
      return () => {
        pane.classList.remove('drop-here');
        pane.removeEventListener('dragover', over);
        pane.removeEventListener('dragleave', leave);
        pane.removeEventListener('drop', dropped);
      };
    },
    [add],
  );

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    // Copied from a spreadsheet or a web page, there's often a picture of the text as well: the text wins.
    if (e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    add(files);
  };

  return { drafts, busy, error, add, remove, upload, clear, zone, onPaste };
}

export function AttachButton({ a }: { a: Attachments }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost small attach-btn" onClick={() => input.current?.click()} disabled={a.busy} aria-label="Attach files or images" title="Attach files or images. You can also drop them here, or paste a screenshot">
        📎
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={e => {
          a.add(e.target.files ?? []);
          // So the same file can be picked again.
          e.target.value = '';
        }}
      />
    </>
  );
}

/** What's attached so far, each with a way to take it off, and anything wrong with them. */
export function Drafts({ a }: { a: Attachments }) {
  if (!a.drafts.length && !a.error) return null;
  return (
    <div className="drafts">
      {a.drafts.map(d => (
        <div key={d.id} className="draft" title={`${d.file.name} (${bytes(d.file.size)})`}>
          {d.preview ? <img src={d.preview} alt="" /> : <span aria-hidden>📎</span>}
          <span className="draft-name">{d.file.name || 'pasted'}</span>
          <span className="muted">{bytes(d.file.size)}</span>
          <button type="button" className="btn ghost small" onClick={() => a.remove(d.id)} disabled={a.busy} aria-label={`Take off ${d.file.name}`}>
            ×
          </button>
        </div>
      ))}
      {a.error && <div className="warn-text small draft-error">{a.error}</div>}
    </div>
  );
}
