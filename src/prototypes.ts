import { execFile } from 'node:child_process';
import { appendFileSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { mergedTree, type GoalGit } from './git.ts';

/**
 * Prototypes (design §21): a playable idea from a room, kept in MetaHarness's home and never in
 * the project, so it outlasts the room and any goal built from it. Each is a folder with its own
 * git repository: the game as frozen from a checkout or a worktree, or a small project of its
 * own. This file does the disk and git work; the daemon decides when.
 */

export const TOOLS_DIR = '.prototype';
export const NOTES_FILE = `${TOOLS_DIR}/NOTES.md`;
/** One line, res://<scene>: where the Run button opens it. */
export const SCENE_FILE = `${TOOLS_DIR}/scene.txt`;
const TUNE_FILE = `${TOOLS_DIR}/mh_tune.gd`;
const TUNING_FILE = `${TOOLS_DIR}/tuning.json`;
const KEPT_FILE = `${TOOLS_DIR}/kept.json`;
const AUTOLOAD = `MhTune="*res://${TUNE_FILE}"`;
const BRANCH = 'prototype';

export interface PrototypeVersion {
  n: number;
  sha: string;
  at: string;
  note: string;
}

export type PrototypeStart =
  | { kind: 'small' }
  /** The folder as it stood, uncommitted work included. `commit` is the commit it stood on in the project. */
  | { kind: 'game'; source: string; commit?: string; branch?: string; uncommitted: boolean }
  | { kind: 'fork'; from: string; version: number }
  | { kind: 'merge'; from: { id: string; version: number }[] };

export interface PrototypeVerdict {
  kind: 'keep' | 'park' | 'drop';
  why?: string;
  version: number;
  at: string;
}

export interface Prototype {
  id: string;
  title: string;
  /** What it set out to try. */
  idea: string;
  /** The project it belongs to. */
  project: string;
  createdAt: string;
  start: PrototypeStart;
  /** Version 0 and on, oldest first. */
  versions: PrototypeVersion[];
  /** What production is measured from: the commit after the tools, carried through forks and merges. */
  base: string;
  /** Where its game copy came from, carried through forks and merges. */
  frozen?: { source: string; commit?: string; branch?: string; uncommitted: boolean; at: string };
  /** Where the project.godot is, relative to the repository; undefined when there's none. */
  godot?: string;
  /** Values kept with the game's Keep button, latest last. */
  kept: { version: number; values: Record<string, number>; at: string }[];
  verdict?: PrototypeVerdict;
  /** The room working on it (the last one to carry it). */
  room?: string;
  /** Its card on that room's board. */
  card?: string;
  /** Open again by itself after each change, when it's running. */
  rerun: boolean;
  /** Merges still to do once the builder has settled this one's conflicts. */
  merging?: { id: string; version: number }[];
  /** Files still in conflict. */
  conflicts?: string[];
  /** Prototypes that share no history with this one, for its builder to port by hand. */
  port?: { id: string; version: number }[];
}

/** The key a prototype's game runs under, beside a room's Godot demos. */
export const prototypeFile = (id: string) => `prototype:${id}`;

/** Prototype references as an agent or a client sends them: ids, or {id, version}. */
export function prototypeRefs(raw: unknown): { id: string; version?: number }[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(r => (r && typeof r === 'object' ? { id: String((r as { id?: unknown }).id ?? ''), ...(typeof (r as { version?: unknown }).version === 'number' ? { version: (r as { version: number }).version } : {}) } : { id: String(r) })).filter(r => r.id);
}

export const prototypesRoot = (home: string, projectId: string) => join(home, 'prototypes', projectId);
export const prototypeRepo = (dir: string) => join(dir, 'repo');
export const processFile = (dir: string) => join(dir, 'process.md');
const metaFile = (dir: string) => join(dir, 'prototype.json');

/** A name safe for a folder, a git path and an agent. */
export function prototypeId(title: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(n => n.toLowerCase()));
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'prototype';
  const clean = ['main', 'room', 'lead', 'human', 'all'].includes(base) ? `${base}-prototype` : base;
  let id = clean;
  for (let n = 2; used.has(id); n++) id = `${clean}-${n}`;
  return id;
}

export function loadPrototype(dir: string): Prototype | undefined {
  try {
    return JSON.parse(readFileSync(metaFile(dir), 'utf8')) as Prototype;
  } catch {
    return undefined;
  }
}

export function savePrototype(dir: string, p: Prototype): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${metaFile(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  renameSync(tmp, metaFile(dir));
}

/** Every prototype of a project, newest first. */
export function listPrototypes(root: string): { dir: string; p: Prototype }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map(id => ({ dir: join(root, id), p: loadPrototype(join(root, id)) }))
    .filter((x): x is { dir: string; p: Prototype } => !!x.p)
    .sort((a, b) => b.p.createdAt.localeCompare(a.p.createdAt));
}

export const latest = (p: Prototype): PrototypeVersion => p.versions[p.versions.length - 1];
export const versionOf = (p: Prototype, n?: number): PrototypeVersion | undefined => (n === undefined ? latest(p) : p.versions.find(v => v.n === n));

/** The kept values a version carries: what was kept on it or before it, each knob's latest. */
export function keptAt(p: Prototype, version?: number): Record<string, number> {
  const upTo = version ?? latest(p).n;
  return Object.assign({}, ...p.kept.filter(k => k.version <= upTo).map(k => k.values)) as Record<string, number>;
}

/** The prototype's own record of how it went: it outlasts the room's log. */
export function logProcess(dir: string, heading: string, text = ''): void {
  try {
    appendFileSync(processFile(dir), `### ${heading} (${new Date().toISOString()})\n\n${text.trim() ? `${text.trim()}\n\n` : ''}`);
  } catch {
    // The room's log has it, while the room lasts.
  }
}

/* ---------------- git ---------------- */

/** Prototype commits never run the hooks or signing of whoever's machine this is. */
const COMMIT = ['-c', 'user.name=MetaHarness', '-c', 'user.email=metaharness@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

function run(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) reject(Object.assign(new Error(`git ${args.slice(0, 2).join(' ')}: ${stderr.trim() || err.message}`), { code: err.code }));
      else resolve(out.trim());
    });
  });
}

const attempt = (cwd: string, ...args: string[]) => run(cwd, ...args).catch(() => undefined);

/** Set on every repository of a prototype: its own, with no way back to where it came from. */
async function ownRepo(repo: string): Promise<void> {
  await attempt(repo, 'remote', 'remove', 'origin');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), ['.godot/', `**/${TUNING_FILE}`, `**/${KEPT_FILE}`, ''].join('\n'));
  // Both sides' notes survive a merge, without a conflict to settle.
  writeFileSync(join(repo, '.git', 'info', 'attributes'), [`**/${NOTES_FILE} merge=union`, `**/${SCENE_FILE} merge=union`, ''].join('\n'));
}

/**
 * A copy of a folder as it stands, uncommitted work included: what git ignores stays out, and so
 * does the folder's history past what `git clone` brings. Nothing in the folder changes.
 */
export async function freezeFolder(source: string, repo: string): Promise<{ top: string; commit?: string; branch?: string; uncommitted: boolean }> {
  mkdirSync(dirname(repo), { recursive: true });
  const top = await attempt(source, 'rev-parse', '--show-toplevel');
  const commit = top ? await attempt(top, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}') : undefined;
  if (!top || !commit) {
    await cp(source, repo, { recursive: true, filter: f => !['.git', '.godot'].includes(basename(f)) });
    await run(repo, 'init', '-q', '-b', BRANCH);
    await ownRepo(repo);
    await run(repo, 'add', '-A');
    await run(repo, ...COMMIT, 'commit', '-q', '--allow-empty', '-m', `Frozen from ${source}`);
    return { top: source, uncommitted: true };
  }
  await run(dirname(repo), 'clone', '-q', '--no-tags', '--local', top, repo);
  await run(repo, 'checkout', '-q', '-B', BRANCH);
  await ownRepo(repo);
  const list = (out: string | undefined) => (out ?? '').split('\0').filter(Boolean);
  // Not trimmed by run's caller: names can't hold a NUL, and a trim only touches the ends.
  const changed = [...new Set([...list(await attempt(top, 'diff', '--name-only', '--no-renames', '-z', 'HEAD')), ...list(await attempt(top, 'ls-files', '--others', '--exclude-standard', '-z'))])];
  for (const rel of changed) {
    const from = join(top, rel);
    const to = join(repo, rel);
    if (existsSync(from) && !statSync(from).isDirectory()) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    } else if (!existsSync(from)) await rm(to, { force: true });
  }
  await run(repo, 'add', '-A');
  const uncommitted = await stagedChanges(repo);
  if (uncommitted) await run(repo, ...COMMIT, 'commit', '-q', '-m', `Frozen from ${source}, with what wasn't committed there`);
  const branch = await attempt(top, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  return { top, commit, ...(branch ? { branch } : {}), uncommitted };
}

/** Godot's import cache, when the folder has one: importing a whole game again can take a long time. */
export async function copyGodotCache(source: string, repo: string, godot: string): Promise<void> {
  const from = join(source, godot, '.godot');
  if (!existsSync(from)) return;
  await cp(from, join(repo, godot, '.godot'), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    filter: f => !['editor', 'shader_cache'].includes(basename(f)) && basename(f) !== 'mh-imported',
  }).catch(() => {});
}

/** An empty repository with a project that opens, for an idea tried on its own. */
export async function smallProject(repo: string, title: string): Promise<void> {
  mkdirSync(repo, { recursive: true });
  await run(repo, 'init', '-q', '-b', BRANCH);
  await ownRepo(repo);
  writeFileSync(join(repo, 'project.godot'), `config_version=5\n\n[application]\n\nconfig/name=${JSON.stringify(title)}\n`);
}

/** A copy of another prototype's repository at one of its versions, sharing its history. */
export async function cloneVersion(fromRepo: string, sha: string, repo: string): Promise<void> {
  mkdirSync(dirname(repo), { recursive: true });
  await run(dirname(repo), 'clone', '-q', '--no-tags', '--local', '--no-checkout', fromRepo, repo);
  await run(repo, 'checkout', '-q', '-B', BRANCH, sha);
  await ownRepo(repo);
}

/** The shallowest project.godot, relative to the repository ('' at its top); undefined when there's none. */
export function findGodot(repo: string, depth = 3): string | undefined {
  let level = [''];
  for (let d = 0; d <= depth && level.length; d++) {
    const next: string[] = [];
    for (const rel of level.sort()) {
      if (existsSync(join(repo, rel, 'project.godot'))) return rel;
      for (const e of readdirSync(join(repo, rel), { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'addons' && e.name !== 'node_modules') next.push(join(rel, e.name));
      }
    }
    level = next;
  }
  return undefined;
}

/** A project.godot that loads the tuning panel. */
export function withAutoload(text: string): string {
  if (text.includes(AUTOLOAD)) return text;
  if (/^\[autoload\][ \t]*\r?$/m.test(text)) return text.replace(/^\[autoload\][ \t]*\r?$/m, `[autoload]\n\n${AUTOLOAD}`);
  return `${text.trimEnd()}\n\n[autoload]\n\n${AUTOLOAD}\n`;
}

/**
 * What every new prototype carries: its notes and the tuning panel, as a commit of their own, so
 * what production is told changed starts after them. Returns where the project.godot is.
 */
export async function installTools(repo: string, tuneScript: string): Promise<string | undefined> {
  const godot = findGodot(repo);
  const place = join(repo, godot ?? '');
  mkdirSync(join(place, TOOLS_DIR), { recursive: true });
  writeFileSync(join(place, NOTES_FILE), '# Notes\n\n## Tried\n\n## Rejected, and why\n\n## Shortcuts taken\n');
  if (godot !== undefined) {
    writeFileSync(join(place, TUNE_FILE), tuneScript);
    const file = join(place, 'project.godot');
    writeFileSync(file, withAutoload(readFileSync(file, 'utf8')));
  }
  await run(repo, 'add', '-A');
  await run(repo, ...COMMIT, 'commit', '-q', '-m', 'Prototype tools');
  return godot;
}

const stagedChanges = (repo: string) => run(repo, 'diff', '--cached', '--quiet').then(() => false, () => true);
export const headOf = (repo: string) => run(repo, 'rev-parse', 'HEAD');
export const tagVersion = (repo: string, n: number, sha: string) => run(repo, 'tag', '-f', `v${n}`, sha);

/** Files in conflict that still have conflict markers in them. */
async function unsettled(repo: string): Promise<string[]> {
  const files = [...new Set((await run(repo, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean))];
  return files.filter(f => {
    try {
      return /^<{7} /m.test(readFileSync(join(repo, f), 'utf8'));
    } catch {
      return false;
    }
  });
}

/**
 * Commits what's in the folder, if anything: a new version's worth. A merge whose conflicts
 * aren't settled yet isn't committed: those files come back instead.
 */
export async function commitAll(repo: string, message: string): Promise<{ sha: string } | { conflicts: string[] }> {
  const conflicts = await unsettled(repo);
  if (conflicts.length) return { conflicts };
  await run(repo, 'add', '-A');
  const merging = existsSync(join(repo, '.git', 'MERGE_HEAD'));
  if (merging || (await stagedChanges(repo))) await run(repo, ...COMMIT, 'commit', '-q', '-m', message);
  return { sha: await headOf(repo) };
}

/** Back to how a version was, as a new commit on top: nothing in between is lost. */
export async function restoreVersion(repo: string, sha: string, message: string): Promise<string> {
  await run(repo, 'read-tree', '-u', '--reset', sha);
  if (await stagedChanges(repo)) await run(repo, ...COMMIT, 'commit', '-q', '-m', message);
  return headOf(repo);
}

async function fetchVersion(repo: string, other: string, n: number): Promise<string> {
  await run(repo, 'fetch', '-q', '--no-tags', other, `refs/tags/v${n}`);
  return run(repo, 'rev-parse', 'FETCH_HEAD');
}

/**
 * What merging these would do, touching no files: the conflicts, and which of them share no
 * history with the first (a small project against a copy of the game), so git can't merge them.
 */
export async function mergePreview(from: { repo: string; sha: string; label: string; n: number }[]): Promise<{ conflicts: string[]; unrelated: string[] }> {
  const [first, ...rest] = from;
  const unrelated: string[] = [];
  const shas: string[] = [];
  for (const o of rest) {
    const sha = await fetchVersion(first.repo, o.repo, o.n);
    if (await attempt(first.repo, 'merge-base', first.sha, sha)) shas.push(sha);
    else unrelated.push(o.label);
  }
  const { conflicts } = mergedTree({ repo: first.repo } as GoalGit, first.sha, shas);
  return { conflicts, unrelated };
}

/** Merges another prototype's version into this one. */
export async function mergeVersion(repo: string, other: string, n: number, message: string): Promise<{ merged: true } | { conflicts: string[] } | { unrelated: true }> {
  const sha = await fetchVersion(repo, other, n);
  if (!(await attempt(repo, 'merge-base', 'HEAD', sha))) return { unrelated: true };
  try {
    await run(repo, ...COMMIT, 'merge', '-q', '--no-ff', '-m', message, sha);
    return { merged: true };
  } catch {
    const conflicts = (await run(repo, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    if (!conflicts.length) throw new Error(`git couldn't merge it, with no conflicts to show (is a file in the way in ${repo}?)`);
    return { conflicts };
  }
}

/** The running values a copy starts from: what was being tuned, then what was kept. */
export function writeTuning(repo: string, godot: string, values: Record<string, number>): void {
  if (!Object.keys(values).length) return;
  mkdirSync(join(repo, godot, TOOLS_DIR), { recursive: true });
  writeFileSync(join(repo, godot, TUNING_FILE), JSON.stringify({ values }, null, 1) + '\n');
}

/** Takes what the game's Keep button left, if it did. A half-written file is left for next time. */
export function takeKept(repo: string, godot: string): Record<string, number> | undefined {
  const file = join(repo, godot, KEPT_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { values?: Record<string, unknown> };
    rmSync(file, { force: true });
    const values = Object.entries(raw.values ?? {}).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)) as [string, number][];
    return values.length ? Object.fromEntries(values) : undefined;
  } catch {
    return undefined;
  }
}

/** Where the Run button opens it, when the builder has said. */
export function sceneOf(repo: string, godot: string): string | undefined {
  try {
    const line = readFileSync(join(repo, godot, SCENE_FILE), 'utf8').split('\n')[0].trim();
    return /^res:\/\/[^\s]+\.(tscn|scn)$/.test(line) ? line : undefined;
  } catch {
    return undefined;
  }
}

/** A prototype's notes as they were at a version. */
export const notesAt = (repo: string, sha: string, godot: string) => attempt(repo, 'show', `${sha}:${join(godot, NOTES_FILE)}`);

/** What a version changed against version 0, its tools left out, written to a file. */
export function writeChanges(repo: string, base: string, sha: string, file: string): Promise<string> {
  return run(repo, 'diff', `--output=${file}`, base, sha, '--', '.', `:(exclude,glob)**/${TOOLS_DIR}/**`);
}

/** How far the project has moved from the commit a prototype was frozen on. */
export async function movedOn(project: string, commit: string): Promise<{ commits: number; files: string[] } | undefined> {
  const count = await attempt(project, 'rev-list', '--count', `${commit}..HEAD`);
  if (count === undefined) return undefined;
  const files = (await attempt(project, 'diff', '--name-only', commit, 'HEAD')) ?? '';
  return { commits: Number(count), files: files.split('\n').filter(Boolean) };
}

/** The checkouts of a project: the main one and its git worktrees, MetaHarness's own included. */
export async function checkouts(project: string): Promise<{ path: string; branch?: string; dirty: boolean }[]> {
  const out = await attempt(project, 'worktree', 'list', '--porcelain');
  if (!out) return [{ path: project, dirty: false }];
  const list: { path: string; branch?: string }[] = [];
  for (const block of out.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path || !existsSync(path) || /^bare$/m.test(block)) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    list.push({ path, ...(branch ? { branch } : {}) });
  }
  return Promise.all(list.map(async c => ({ ...c, dirty: !!(await attempt(c.path, 'status', '--porcelain')) })));
}
