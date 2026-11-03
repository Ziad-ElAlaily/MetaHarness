import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, relative, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * The shared folder's history (design §6). Agents write ordinary files; a scan every few seconds
 * finds what changed, keeps every version in .history/<path>/, and leaves it to the daemon to
 * say who wrote it and tell the rest of the team.
 */

export const HISTORY = '.history';

/** Editor and system droppings that aren't anyone's document. */
const NOISE = /(^\.#|~$|\.sw[a-p]$|^\.DS_Store$|^#.*#$)/;

/** Larger files are still reported, but not copied into the history. */
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

/** The largest file a chat attachment can be: agents read these, and every one stays on disk with the goal. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** A file name that's safe on disk and in the line an agent reads: no folders, no leading dot, no spaces or brackets. */
export function uploadName(raw: string): string {
  const base = raw.normalize('NFC').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[.-]+/, '').replace(/-+$/, '');
  if (!clean) return 'file';
  // Long names lose their middle, not their extension.
  const ext = extname(clean).slice(0, 20);
  return clean.length > 120 ? `${clean.slice(0, 120 - ext.length)}${ext}` : clean;
}

/**
 * Keeps a file the human attached in `folder` under the shared folder, and never over another:
 * shot.png, then shot-2.png. It appears there whole, so a scan never records half of it.
 */
export async function saveUpload(sharedDir: string, folder: string, name: string, body: Readable): Promise<{ path: string; abs: string; size: number }> {
  const dir = join(sharedDir, folder);
  mkdirSync(dir, { recursive: true });
  // Beside the shared folder, not in it, on the same disk.
  const tmp = join(dirname(sharedDir), `.upload-${randomUUID()}`);
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      done(size > MAX_UPLOAD_BYTES ? new Error(uploadTooBig(size)) : null, chunk);
    },
  });
  try {
    await pipeline(body, count, createWriteStream(tmp));
    const safe = uploadName(name);
    const ext = extname(safe);
    const stem = safe.slice(0, safe.length - ext.length);
    for (let n = 1; ; n++) {
      const file = n === 1 ? safe : `${stem}-${n}${ext}`;
      try {
        linkSync(tmp, join(dir, file));
        return { path: `${folder}/${file}`, abs: join(dir, file), size };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

export const uploadTooBig = (size: number) => `That file is too big to attach (${Math.ceil(size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB). Put it in the project or the shared folder yourself, and say where.`;

export interface SharedFile {
  size: number;
  mtimeMs: number;
  hash: string;
  version: number;
  /** The first agent known to write it. By convention only the owner edits it. */
  owner?: string;
  /** Where its latest version is kept, if it was copied. */
  history?: string;
}

export interface SharedChange {
  /** Relative to the shared folder, with forward slashes. */
  path: string;
  deleted: boolean;
  /** What was known before this change; unset for a new file. */
  before?: SharedFile;
}

export class SharedFolder {
  readonly dir: string;
  readonly files = new Map<string, SharedFile>();
  /** Deleted files, so one written again carries on from its last version and owner. */
  private gone = new Map<string, SharedFile>();

  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * Takes what's on disk as known, without reporting it: after a restart. `known` carries each
   * file's version and owner from the event log.
   */
  seed(known: Map<string, { version: number; owner?: string }> = new Map()): void {
    for (const [path, st] of this.walk()) {
      const k = known.get(path);
      this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash: this.hash(path, st.size), version: k?.version ?? 1, owner: k?.owner });
    }
    for (const [path, k] of known) if (!this.files.has(path)) this.gone.set(path, { size: -1, mtimeMs: 0, hash: '', ...k });
  }

  /** Files written or deleted since the last scan. Call record() for each to keep its version. */
  scan(): SharedChange[] {
    const seen = new Set<string>();
    const out: SharedChange[] = [];
    for (const [path, st] of this.walk()) {
      seen.add(path);
      const known = this.files.get(path);
      const before = known ?? this.gone.get(path);
      this.gone.delete(path);
      if (known && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
      const hash = this.hash(path, st.size);
      if (known && known.hash === hash) {
        // Touched, not changed.
        known.mtimeMs = st.mtimeMs;
        continue;
      }
      out.push({ path, deleted: false, before: before && { ...before } });
      this.files.set(path, { size: st.size, mtimeMs: st.mtimeMs, hash, version: (before?.version ?? 0) + 1, owner: before?.owner });
    }
    for (const [path, known] of this.files) {
      if (seen.has(path)) continue;
      this.files.delete(path);
      this.gone.set(path, known);
      out.push({ path, deleted: true, before: known });
    }
    return out;
  }

  /**
   * Copies a file's new version into the history, as .history/<path>/<version>-<writer><ext>.
   * Sets the owner if it has none. Returns the copy's path, relative to the shared folder.
   */
  record(path: string, by: string | undefined): string | undefined {
    const f = this.files.get(path);
    if (!f) return undefined;
    if (by && !f.owner) f.owner = by;
    if (f.size > MAX_HISTORY_BYTES) return undefined;
    const name = `${String(f.version).padStart(3, '0')}-${by ?? 'unknown'}${extname(path)}`;
    const rel = `${HISTORY}/${path}/${name}`;
    try {
      mkdirSync(join(this.dir, HISTORY, path), { recursive: true });
      copyFileSync(join(this.dir, path), join(this.dir, rel));
      f.history = rel;
      return rel;
    } catch {
      // Deleted or replaced while we looked; the next scan sees what's there.
      return undefined;
    }
  }

  private hash(path: string, size: number): string {
    try {
      // Big files are compared by size alone; reading them every few seconds isn't worth it.
      if (size > MAX_HISTORY_BYTES) return `size:${size}`;
      return createHash('sha1').update(readFileSync(join(this.dir, path))).digest('hex');
    } catch {
      return '';
    }
  }

  private *walk(): Generator<[string, { size: number; mtimeMs: number }]> {
    if (!existsSync(this.dir)) return;
    const stack = [this.dir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (NOISE.test(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (!(dir === this.dir && e.name === HISTORY)) stack.push(full);
        } else if (e.isFile()) {
          try {
            const st = statSync(full);
            yield [relative(this.dir, full).split(sep).join('/'), { size: st.size, mtimeMs: st.mtimeMs }];
          } catch {
            // Gone already.
          }
        }
      }
    }
  }
}
