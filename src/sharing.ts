import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { docPath, parseFrontMatter } from './config.ts';
import { checkName, configView, saveMcp, type ConfigView, type Scope, type ScopeDir } from './configedit.ts';
import type { McpServerDef } from './mcpservers.ts';
import { skillFiles } from './skills.ts';

/**
 * Sharing setup (design §23). An export writes some roles, workflows, rules, skills or MCP servers,
 * and what they need, to one file to send to someone. Importing is a reviewed copy: nothing is
 * written until it's confirmed, and what's copied is ordinary files, the importer's from then on.
 * Nothing remembers where they came from.
 */

export type ItemKind = 'role' | 'workflow' | 'rule' | 'skill' | 'mcp';
export const ITEM_KINDS: ItemKind[] = ['workflow', 'role', 'rule', 'skill', 'mcp'];

export interface Ref {
  kind: ItemKind;
  name: string;
}

const keyOf = (r: Ref) => `${r.kind}/${r.name}`;
const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

function checkKind(kind: unknown): ItemKind {
  if (!ITEM_KINDS.includes(kind as ItemKind)) throw new Error(`An export holds ${ITEM_KINDS.join(', ')} (got "${String(kind)}").`);
  return kind as ItemKind;
}

/** A skill's name may hold a colon (its folder can't); every other name is a file name. */
function checkItemName(kind: ItemKind, name: unknown): string {
  if (kind !== 'skill') return checkName(name, kind);
  const n = typeof name === 'string' ? name.trim() : '';
  if (!/^[\w.:-]{1,128}$/.test(n) || n.includes('..')) throw new Error(`"${String(name)}" isn't a skill name.`);
  return n;
}

function checkRefs(v: unknown): Ref[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error('Items are a list of { kind, name }.');
  const out = new Map<string, Ref>();
  for (const x of v as Ref[]) {
    const kind = checkKind(x?.kind);
    const r = { kind, name: checkItemName(kind, x.name) };
    out.set(keyOf(r), r);
  }
  return [...out.values()];
}

/* ---------------- what's here ---------------- */

interface Entry extends Ref {
  scope: string;
  file?: string;
  /** A skill's folder. */
  dir?: string;
  /** An MCP server's definition. */
  def?: McpServerDef;
  /** The folder a role or workflow is organized under. */
  folder?: string;
}

/** Every item this setup has, the most specific folder's where a name is in several. */
function catalog(view: ConfigView): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const add = (e: Entry) => out.set(keyOf(e), e);
  for (const r of view.roles) add({ kind: 'role', name: r.name, scope: r.scope, file: r.file, ...(r.folder ? { folder: r.folder } : {}) });
  for (const w of view.workflows) add({ kind: 'workflow', name: w.name, scope: w.scope, file: w.file, ...(w.folder ? { folder: w.folder } : {}) });
  for (const r of view.rules) add({ kind: 'rule', name: r.name, scope: r.scope, file: r.file });
  for (const s of view.skills) add({ kind: 'skill', name: s.name, scope: s.source, dir: s.dir });
  for (const m of view.mcp) add({ kind: 'mcp', name: m.name, scope: m.scope, def: m.def });
  return out;
}

const textOf = (e: Entry): string => (e.file && existsSync(e.file) ? readFileSync(e.file, 'utf8') : '');

/** Workflows a workflow hands on to: names of other workflows in `backticks`. */
const chains = (body: string, isWorkflow: (n: string) => boolean) => [...new Set([...body.matchAll(/`([\w.-]+)`/g)].map(m => m[1]).filter(isWorkflow))];

/** What an item can't work without, read from its own text. A role named "game-dev/" is a whole folder. */
function refsOf(kind: ItemKind, text: string, isWorkflow: (n: string) => boolean): Ref[] {
  const { meta, body } = parseFrontMatter(text);
  if (kind === 'workflow') return [...list(meta.roles).map(name => ({ kind: 'role' as const, name })), ...chains(body, isWorkflow).map(name => ({ kind: 'workflow' as const, name }))];
  if (kind === 'role') {
    return [
      ...(meta.workflow ? [{ kind: 'workflow' as const, name: meta.workflow }] : []),
      ...list(meta.skills).map(name => ({ kind: 'skill' as const, name })),
      ...list(meta.mcp).map(name => ({ kind: 'mcp' as const, name })),
    ];
  }
  return kind === 'rule' && meta.skill ? [{ kind: 'skill', name: meta.skill }] : [];
}

export interface Member extends Ref {
  /** Why it's in the export when it wasn't picked: the item that needs it. */
  via?: string;
}

export interface Resolved {
  members: Member[];
  /** Named by what's in it, and shipped with MetaHarness: they aren't packed. */
  builtIn: Ref[];
  /** Named, and not found in this setup. */
  missing: Member[];
  /** Needed, and left out on purpose. */
  leftOut: Member[];
  /** Rules that name a role in it, worth adding. */
  suggested: Ref[];
}

/** A set of picks, and everything they bring: a workflow its roles and what it hands on to, a role its skills and servers. */
function resolve(cat: Map<string, Entry>, picks: Ref[], leaveOut: Ref[]): Resolved {
  const r: Resolved = { members: [], builtIn: [], missing: [], leftOut: [], suggested: [] };
  const out = new Set(leaveOut.map(keyOf));
  const picked = new Set(picks.map(keyOf));
  const seen = new Set<string>();
  const isWorkflow = (n: string) => cat.has(`workflow/${n}`);
  const queue: Member[] = picks.map(p => ({ ...p }));
  while (queue.length) {
    const m = queue.shift()!;
    const key = keyOf(m);
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.has(key) && !picked.has(key)) {
      r.leftOut.push(m);
      continue;
    }
    const e = cat.get(key);
    if (!e) {
      r.missing.push(m);
      continue;
    }
    if (e.scope === 'built-in') {
      r.builtIn.push({ kind: m.kind, name: m.name });
      continue;
    }
    r.members.push(m);
    if (!e.file) continue;
    for (const need of refsOf(m.kind, textOf(e), isWorkflow)) {
      // A whole folder: what's in it now.
      if (need.kind === 'role' && need.name.endsWith('/')) {
        const inside = [...cat.values()].filter(x => x.kind === 'role' && x.folder === need.name.slice(0, -1));
        if (!inside.length) r.missing.push({ ...need, via: key });
        for (const x of inside) if (!seen.has(keyOf(x))) queue.push({ kind: 'role', name: x.name, via: key });
      } else if (!seen.has(keyOf(need))) queue.push({ ...need, via: key });
    }
  }
  const roles = new Set(r.members.filter(m => m.kind === 'role').map(m => m.name));
  for (const e of cat.values()) {
    if (e.kind !== 'rule' || e.scope === 'built-in' || seen.has(keyOf(e))) continue;
    if (list(parseFrontMatter(textOf(e)).meta.roles).some(n => roles.has(n))) r.suggested.push({ kind: 'rule', name: e.name });
  }
  return r;
}

/* ---------------- the file you send ---------------- */

export const EXPORT_FORMAT = 'metaharness-export';
export const EXPORT_VERSION = 1;
/** Bigger than any sensible set of guides: it's a file people send each other, and the daemon holds it in memory. */
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;

export interface PackedFile {
  path: string;
  /** UTF-8 text, or base64 for anything else. */
  text?: string;
  base64?: string;
  exec?: boolean;
}

export interface PackedItem extends Ref {
  /** A role, workflow or rule: its file as written. */
  text?: string;
  /** A skill: its folder's name. A role or workflow: the folder it's organized under, if any. */
  folder?: string;
  files?: PackedFile[];
  /** An MCP server, with secret values taken out. */
  def?: McpServerDef;
  /** Its values people must fill in: env.NAME, headers.NAME. */
  blanks?: string[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  formatVersion: number;
  name: string;
  exportedAt: string;
  items: PackedItem[];
  /** What it relies on and doesn't hold: built into MetaHarness, or left out. */
  needs: Ref[];
}

export interface ExportWarning {
  item: string;
  level: 'secret' | 'info';
  text: string;
}

const SECRETS: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}|\bgithub_pat_\w{20,}/, 'a GitHub token'],
  [/\bglpat-[\w-]{16,}/, 'a GitLab token'],
  [/\bxox[abprs]-[\w-]{10,}/, 'a Slack token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
  [/\bAIza[\w-]{30,}/, 'a Google API key'],
  [/\bnpm_[A-Za-z0-9]{30,}/, 'an npm token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bBearer\s+[\w.~+/-]{20,}/, 'a bearer token'],
  [/\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|secret|password|passwd)\b["']?\s*[:=]\s*["']?(?!\$\{?)[\w./+~-]{12,}/i, 'what looks like a password or key'],
];

const HOME_PATH = /(?:\/home\/|\/Users\/|[A-Za-z]:\\Users\\)[^\s/\\"'`)]+/;

const masked = (s: string) => (s.length <= 8 ? '…' : `${s.slice(0, 4)}…`);

function scan(item: string, text: string, out: ExportWarning[]): void {
  for (const [re, what] of SECRETS) {
    const m = re.exec(text);
    if (m) out.push({ item, level: 'secret', text: `Holds ${what} (${masked(m[0])}).` });
  }
  const home = HOME_PATH.exec(text);
  if (home) out.push({ item, level: 'info', text: `Names a folder on your machine (${home[0]}), which shows your user name and won't exist elsewhere.` });
}

/** An MCP server without its secrets: env and header values go, unless they only name a variable. */
function scrubMcp(def: McpServerDef): { def: McpServerDef; blanks: string[] } {
  const blanks: string[] = [];
  const clean = (group: 'env' | 'headers') => {
    const src = def[group];
    if (!src) return undefined;
    return Object.fromEntries(Object.entries(src).map(([k, v]) => {
      if (/\$\{?\w+\}?/.test(String(v))) return [k, v];
      blanks.push(`${group}.${k}`);
      return [k, ''];
    }));
  };
  const env = clean('env');
  const headers = clean('headers');
  return { def: { ...def, ...(env ? { env } : {}), ...(headers ? { headers } : {}) }, blanks };
}

function packFile(root: string, path: string): PackedFile {
  const p = join(root, path);
  const buf = readFileSync(p);
  const utf8 = buf.toString('utf8');
  const isText = !buf.includes(0) && Buffer.from(utf8, 'utf8').equals(buf);
  return { path, ...(isText ? { text: utf8 } : { base64: buf.toString('base64') }), ...(statSync(p).mode & 0o111 ? { exec: true } : {}) };
}

function packItem(e: Entry, warnings: ExportWarning[]): PackedItem {
  const key = keyOf(e);
  if (e.kind === 'mcp') {
    const { def, blanks } = scrubMcp(e.def!);
    if (blanks.length) warnings.push({ item: key, level: 'info', text: `Its ${blanks.join(', ')} ${blanks.length === 1 ? 'value is' : 'values are'} taken out; whoever imports it fills ${blanks.length === 1 ? 'it' : 'them'} in.` });
    scan(key, JSON.stringify(def), warnings);
    return { kind: e.kind, name: e.name, def, ...(blanks.length ? { blanks } : {}) };
  }
  if (e.kind === 'skill') {
    const { files, more } = skillFiles(e.dir!, MAX_FILES);
    if (more) throw new Error(`The skill ${e.name} has more than ${MAX_FILES} files: too many to export.`);
    const packed = ['SKILL.md', ...files.map(f => f.path)].map(p => packFile(e.dir!, p));
    for (const f of packed) if (f.text !== undefined) scan(`${key}: ${f.path}`, f.text, warnings);
    return { kind: e.kind, name: e.name, folder: checkName(basename(e.dir!), 'skill folder'), files: packed };
  }
  const text = textOf(e);
  scan(key, text, warnings);
  return { kind: e.kind, name: e.name, text, ...(e.folder ? { folder: e.folder } : {}) };
}

export interface ExportResult extends Resolved {
  file: ExportFile;
  warnings: ExportWarning[];
}

/** Builds the file to send. Reads files; writes nothing. */
export function buildExport(scopes: ScopeDir[], b: Record<string, unknown>): ExportResult {
  const name = checkName(b.name, 'export');
  const picks = checkRefs(b.items);
  if (!picks.length) throw new Error('Pick something to export first.');
  const cat = catalog(configView(scopes));
  const res = resolve(cat, picks, checkRefs(b.leaveOut));
  if (!res.members.length) throw new Error(res.builtIn.length ? `Nothing to export: ${res.builtIn.map(r => r.name).join(', ')} come${res.builtIn.length === 1 ? 's' : ''} with MetaHarness.` : `Nothing to export: this setup has no ${res.missing.map(keyOf).join(', ')}.`);
  const warnings: ExportWarning[] = [];
  const items = res.members.map(m => packItem(cat.get(keyOf(m))!, warnings));
  for (const m of res.missing) warnings.push({ item: keyOf(m), level: 'info', text: `${m.via ? `${m.via} names it, but this` : 'This'} setup has none, so it's not in the file.` });
  for (const i of items) {
    if (i.kind === 'workflow' && !list(parseFrontMatter(i.text ?? '').meta.roles).length) warnings.push({ item: keyOf(i), level: 'info', text: 'It names no roles, so none come along with it, and its lead can use any role where it\'s imported. List them under "Roles it uses" to send them too.' });
  }
  const file: ExportFile = {
    format: EXPORT_FORMAT, formatVersion: EXPORT_VERSION, name, exportedAt: new Date().toISOString(), items,
    needs: [...res.builtIn, ...res.leftOut, ...res.missing].filter(r => !r.name.endsWith('/')).map(({ kind, name: n }) => ({ kind, name: n })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(file));
  if (bytes > MAX_BYTES) throw new Error(`This would be ${Math.round(bytes / 1048576)} MB; the limit is ${MAX_BYTES / 1048576} MB. A skill with large files is the usual reason.`);
  return { ...res, file, warnings };
}

/** A path inside a skill's folder: plain folders and names, nothing hidden, no way out. */
function checkPath(path: unknown, item: string): string {
  const p = typeof path === 'string' ? path : '';
  const parts = p.split('/');
  if (!p || p.length > 512 || /[\\\0]/.test(p) || parts.some(s => !s || s.startsWith('.'))) throw new Error(`${item} has a file with a path that isn't allowed: "${String(path)}".`);
  return p;
}

/**
 * Reads a file someone sent. It's checked for what it could do to this machine's files (names and
 * paths that would land outside their folders) before anything looks at it further.
 */
export function parseExport(text: unknown): ExportFile {
  if (typeof text !== 'string' || !text.trim()) throw new Error('That\'s empty: give an export file\'s text.');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`That file is over the ${MAX_BYTES / 1048576} MB limit.`);
  let raw: Partial<ExportFile> & { format?: unknown };
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`That isn't a MetaHarness export: it isn't valid JSON (${(e as Error).message}).`);
  }
  if (raw?.format !== EXPORT_FORMAT) throw new Error(`That isn't a MetaHarness export (its "format" isn't ${EXPORT_FORMAT}).`);
  if (typeof raw.formatVersion !== 'number' || raw.formatVersion > EXPORT_VERSION) throw new Error(`That was made by a newer MetaHarness (format ${String(raw.formatVersion)}; this one reads up to ${EXPORT_VERSION}). Update MetaHarness first.`);
  if (!Array.isArray(raw.items) || !raw.items.length) throw new Error('That file holds nothing.');
  if (raw.items.length > MAX_FILES) throw new Error('That file holds too many items.');
  const seen = new Set<string>();
  const folders = new Set<string>();
  const items: PackedItem[] = raw.items.map(i => {
    const kind = checkKind(i?.kind);
    const name = checkItemName(kind, i.name);
    const key = `${kind}/${name}`;
    if (seen.has(key)) throw new Error(`That file holds ${key} twice.`);
    seen.add(key);
    if (kind === 'skill') {
      const folder = checkName(i.folder, 'skill folder');
      if (folders.has(folder)) throw new Error(`That file holds two skills in the folder ${folder}.`);
      folders.add(folder);
      if (!Array.isArray(i.files) || !i.files.length) throw new Error(`The skill ${name} in that file has no files.`);
      const paths = new Set<string>();
      const files = i.files.map(f => {
        const path = checkPath(f?.path, key);
        if (paths.has(path)) throw new Error(`The skill ${name} holds ${path} twice.`);
        paths.add(path);
        if (typeof f.text === 'string') return { path, text: f.text, ...(f.exec === true ? { exec: true } : {}) };
        if (typeof f.base64 === 'string' && /^[A-Za-z0-9+/=\s]*$/.test(f.base64)) return { path, base64: f.base64, ...(f.exec === true ? { exec: true } : {}) };
        throw new Error(`${path} in the skill ${name} has no contents.`);
      });
      if (!paths.has('SKILL.md')) throw new Error(`The skill ${name} in that file has no SKILL.md.`);
      return { kind, name, folder, files };
    }
    if (kind === 'mcp') {
      const d = i.def as McpServerDef | undefined;
      if (!d || typeof d !== 'object' || (typeof d.command !== 'string' && typeof d.url !== 'string')) throw new Error(`The server ${name} in that file has neither a command nor a URL.`);
      return { kind, name, def: d, ...(Array.isArray(i.blanks) ? { blanks: i.blanks.map(String).filter(x => /^(env|headers)\.[\w.-]+$/.test(x)) } : {}) };
    }
    if (typeof i.text !== 'string') throw new Error(`${key} in that file has no text.`);
    const organized = (kind === 'role' || kind === 'workflow') && i.folder !== undefined ? { folder: checkName(i.folder, 'folder') } : {};
    return { kind, name, text: i.text, ...organized };
  });
  return {
    format: EXPORT_FORMAT, formatVersion: raw.formatVersion, name: checkName(raw.name, 'export'), exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', items,
    needs: Array.isArray(raw.needs) ? checkRefs(raw.needs.filter(n => ITEM_KINDS.includes(n?.kind))) : [],
  };
}

/* ---------------- what's there already ---------------- */

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 32);

const SUB: Record<'role' | 'workflow' | 'rule', string> = { role: 'roles', workflow: 'workflows', rule: 'rules' };

/** Where an item by this name is in a config folder, relative to it; undefined when there's none. */
function existing(dir: string, i: PackedItem): string | undefined {
  if (i.kind === 'skill') return existsSync(join(dir, 'skills', i.folder!)) ? `skills/${i.folder}` : undefined;
  if (i.kind === 'rule') return existsSync(join(dir, 'rules', `${i.name}.md`)) ? `rules/${i.name}.md` : undefined;
  if (i.kind === 'mcp') return undefined;
  return docPath(join(dir, SUB[i.kind]), i.name)?.slice(dir.length + 1);
}

/**
 * Where a new item goes. A role or workflow goes in the folder it had, so a workflow naming that
 * folder still works; else, when several of its kind came together, a folder named after the
 * export, so they stay together.
 */
function landing(file: ExportFile, i: PackedItem): string {
  if (i.kind === 'skill') return `skills/${i.folder}`;
  if (i.kind === 'rule') return `rules/${i.name}.md`;
  if (i.kind === 'mcp') return 'mcp.json';
  const folder = i.folder ?? (file.items.filter(x => x.kind === i.kind).length > 1 ? file.name : '');
  return `${SUB[i.kind]}/${folder ? `${folder}/` : ''}${i.name}.md`;
}

const bytesOf = (f: PackedFile) => (f.base64 !== undefined ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text ?? '', 'utf8'));

/** Whether a skill's folder holds exactly what the export does. */
function sameSkill(path: string, i: PackedItem): boolean {
  const here = ['SKILL.md', ...skillFiles(path, MAX_FILES).files.map(f => f.path)].filter(p => existsSync(join(path, p))).sort();
  const theirs = [...(i.files ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1));
  return here.length === theirs.length && theirs.every((f, n) => here[n] === f.path && sha(readFileSync(join(path, f.path))) === sha(bytesOf(f)));
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  return v;
}

/** Two server definitions, ignoring the values the export leaves for people to fill in. */
function sameServer(a: McpServerDef, b: McpServerDef, blanks: string[] = []): boolean {
  const norm = (def: McpServerDef) => {
    const copy = JSON.parse(JSON.stringify(def)) as McpServerDef;
    for (const x of blanks) {
      const [group, ...rest] = x.split('.') as ['env' | 'headers', ...string[]];
      if (copy[group]) delete copy[group]![rest.join('.')];
    }
    return JSON.stringify(sorted(copy));
  };
  return norm(a) === norm(b);
}

function readMcpFile(dir: string): Record<string, McpServerDef> {
  try {
    return (JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { mcpServers?: Record<string, McpServerDef> }).mcpServers ?? {};
  } catch {
    return {};
  }
}

/* ---------------- reviewing and importing ---------------- */

/** new: nothing here by this name. same: already exactly this. differs: something of yours is here. */
export type ItemStatus = 'new' | 'same' | 'differs';

export interface ReviewItem extends Ref {
  status: ItemStatus;
  /** What the review proposes: import it. New items are on; replacing yours, or anything with reach over the whole setup, you turn on yourself. */
  on: boolean;
  target: string;
  /** Why it stays off until you say so. */
  sensitive?: string;
  /** How it sits with the rest of the setup. */
  note?: string;
  /** What it may do beyond giving agents text to read. */
  powers: string[];
  /** A role: whether anything can run it here. */
  runs?: { harness: string; model: string; state: 'here' | 'backup' | 'no'; backup?: string };
  /** A server's values to fill in afterwards. */
  blanks?: string[];
  text?: string;
  /** What's there now, when it would be replaced. */
  current?: string;
  files?: { path: string; bytes: number; binary: boolean; exec: boolean }[];
}

export interface Review {
  name: string;
  scope: Scope;
  dir: string;
  items: ReviewItem[];
  /** What it relies on that isn't in it or here. */
  unmet: (Ref & { by: string })[];
  /** Built into MetaHarness: nothing to do. */
  needs: Ref[];
}

export interface ReviewContext {
  /** Whether MetaHarness can run a harness here. */
  canRun: (harness: string) => boolean;
  /** The roles settings gives a job: approving commands, answering in the app, leading rooms. */
  jobs: Record<string, string>;
}

const SCRIPT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd|exe)$/i;

function powersOf(i: PackedItem): string[] {
  const out: string[] = [];
  if (i.kind === 'role') {
    const { meta } = parseFrontMatter(i.text ?? '');
    if (meta.allow) out.push(`Runs these without asking: ${meta.allow}`);
    if (meta.approvals) out.push(`Its own approval mode: ${meta.approvals}`);
    if (meta.permission_mode) out.push(`Permission mode: ${meta.permission_mode}`);
    if (/^(true|yes|1)$/i.test(meta.native_skills ?? '')) out.push('Keeps its harness\'s own skills');
  } else if (i.kind === 'mcp') {
    if (i.def?.url) out.push(`Connects to ${i.def.url}`);
    if (i.def?.command) out.push(`Runs on this machine: ${[i.def.command, ...(i.def.args ?? [])].join(' ')}`);
  } else if (i.kind === 'skill') {
    const scripts = (i.files ?? []).filter(f => f.exec || SCRIPT.test(f.path) || f.base64 !== undefined).map(f => f.path);
    if (scripts.length) out.push(`Comes with programs agents could run: ${scripts.slice(0, 8).join(', ')}${scripts.length > 8 ? ` and ${scripts.length - 8} more` : ''}`);
  } else if (i.kind === 'rule') {
    const { meta, body } = parseFrontMatter(i.text ?? '');
    if (/^(true|yes|1|on)$/i.test(meta.off ?? '') && !body) out.push(`Turns off the rule ${i.name}`);
  }
  return out;
}

/** A role's file, moved to another harness and model; the rest of it stays as written. */
function withRoute(text: string, harness: string, model: string): string {
  const lead = /^﻿?(?:\s*<!--[\s\S]*?-->\s*)*/.exec(text)?.[0] ?? '';
  const t = text.slice(lead.length);
  const route = [`harness: ${harness}`, ...(model ? [`model: ${model}`] : [])];
  const end = t.startsWith('---') ? t.indexOf('\n---', 3) : -1;
  if (end < 0) return `${lead}---\n${route.join('\n')}\n---\n${t}`;
  const rest = t.slice(3, end).split('\n').filter(l => l.trim() && !/^\s*(harness|model)\s*:/i.test(l));
  return `${lead}---\n${[...route, ...rest].join('\n')}\n---${t.slice(end + 4)}`;
}

function runsOf(text: string, canRun: ReviewContext['canRun']): ReviewItem['runs'] {
  const { meta } = parseFrontMatter(text);
  const harness = meta.harness ?? 'claude-code';
  const model = meta.model ?? '';
  if (canRun(harness)) return { harness, model, state: 'here' };
  const backup = list(meta.fallback ?? meta.fallbacks).find(f => canRun(f.split('/')[0]));
  return { harness, model, state: backup ? 'backup' : 'no', ...(backup ? { backup } : {}) };
}

function dirOf(scopes: ScopeDir[], scope: unknown): string {
  const s = scopes.find(x => x.scope === scope);
  if (!s) throw new Error(`There's no ${String(scope)} config folder here. Folders: ${scopes.map(x => `${x.scope} (${x.dir})`).join(', ')}.`);
  return s.dir;
}

/** What importing a file into a folder would do. Writes nothing. */
export function reviewImport(file: ExportFile, scopes: ScopeDir[], scope: unknown, ctx: ReviewContext): Review {
  const dir = dirOf(scopes, scope);
  const cat = catalog(configView(scopes));
  const servers = readMcpFile(dir);
  const items: ReviewItem[] = file.items.map(i => {
    const at = existing(dir, i);
    const here = i.kind === 'mcp' ? servers[i.name] : undefined;
    const exists = i.kind === 'mcp' ? !!here : !!at;
    const same = !exists ? false : i.kind === 'mcp' ? sameServer(here!, i.def!, i.blanks) : i.kind === 'skill' ? sameSkill(join(dir, at!), i) : readFileSync(join(dir, at!), 'utf8') === i.text;
    const status: ItemStatus = !exists ? 'new' : same ? 'same' : 'differs';
    const e = cat.get(keyOf(i));
    let sensitive: string | undefined;
    if (i.kind === 'role' && ctx.jobs[i.name]) sensitive = `Settings gives this role a job: ${ctx.jobs[i.name]}.`;
    else if (e?.scope === 'built-in') sensitive = `It replaces a built-in ${i.kind} of this name.`;
    let note: string | undefined;
    if (!exists && e && e.scope !== 'built-in') {
      if (scope === 'repo' && e.scope !== 'repo') note = `In this project it's used instead of ${e.scope === 'personal' ? 'your personal one' : `the one in ${e.scope}`}.`;
      if (scope === 'personal' && e.scope !== 'personal') note = 'This project has its own by this name, which stays in use here. Other projects get this one.';
    }
    const reviewed: ReviewItem = {
      kind: i.kind, name: i.name, status, target: i.kind === 'mcp' ? `mcp.json (${i.name})` : at ?? landing(file, i), on: status === 'new' && !sensitive,
      ...(sensitive ? { sensitive } : {}), ...(note ? { note } : {}), powers: powersOf(i),
      ...(i.blanks?.length ? { blanks: i.blanks } : {}),
    };
    if (i.kind === 'role') reviewed.runs = runsOf(i.text ?? '', ctx.canRun);
    if (i.kind === 'skill') {
      reviewed.files = (i.files ?? []).map(f => ({ path: f.path, bytes: bytesOf(f).length, binary: f.base64 !== undefined, exec: !!f.exec }));
      reviewed.text = i.files?.find(f => f.path === 'SKILL.md')?.text;
      if (status === 'differs' && existsSync(join(dir, at!, 'SKILL.md'))) reviewed.current = readFileSync(join(dir, at!, 'SKILL.md'), 'utf8');
    } else if (i.kind === 'mcp') {
      reviewed.text = JSON.stringify(i.def, null, 2);
      if (status === 'differs') reviewed.current = JSON.stringify(here, null, 2);
    } else {
      reviewed.text = i.text;
      if (status === 'differs') reviewed.current = readFileSync(join(dir, at!), 'utf8');
    }
    return reviewed;
  });
  const inFile = new Set(file.items.map(keyOf));
  const isWorkflow = (n: string) => inFile.has(`workflow/${n}`) || cat.has(`workflow/${n}`);
  const inFolder = (f: string) => file.items.some(x => x.kind === 'role' && x.folder === f) || [...cat.values()].some(x => x.kind === 'role' && x.folder === f);
  const unmet = new Map<string, Ref & { by: string }>();
  for (const i of file.items) {
    if (!i.text) continue;
    for (const r of refsOf(i.kind, i.text, isWorkflow)) {
      if (r.kind === 'role' && r.name.endsWith('/') ? inFolder(r.name.slice(0, -1)) : inFile.has(keyOf(r)) || cat.has(keyOf(r))) continue;
      unmet.set(keyOf(r), { ...r, by: keyOf(i) });
    }
  }
  return { name: file.name, scope: scope as Scope, dir, items, unmet: [...unmet.values()], needs: file.needs.filter(r => cat.get(keyOf(r))?.scope === 'built-in') };
}

/** Takes away a link at a path rather than writing through it. */
function clearLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) rmSync(path);
  } catch {
    /* nothing there */
  }
}

function writeFileAt(path: string, content: string | Buffer, exec = false): void {
  mkdirSync(dirname(path), { recursive: true });
  clearLink(path);
  writeFileSync(path, content);
  if (exec) chmodSync(path, 0o755);
}

export interface ImportChoices {
  /** "kind/name": true or false, over what the review proposes. */
  choose?: Record<string, boolean>;
  /** Roles to run on something else here. */
  adapt?: Record<string, { harness: string; model?: string }>;
}

export interface ImportResult {
  imported: string[];
  skipped: string[];
  /** Server values still to fill in. */
  unfilled: string[];
}

/** Copies what the review proposes and what `choose` adds or takes away. */
export function importExport(file: ExportFile, scopes: ScopeDir[], scope: unknown, choices: ImportChoices, ctx: ReviewContext): ImportResult {
  const review = reviewImport(file, scopes, scope, ctx);
  const dir = review.dir;
  const servers = readMcpFile(dir);
  const result: ImportResult = { imported: [], skipped: [], unfilled: [] };
  for (const [name, r] of Object.entries(choices.adapt ?? {})) {
    if (typeof r?.harness !== 'string' || !/^[\w.-]+$/.test(r.harness)) throw new Error(`"${String(r?.harness)}" isn't a harness.`);
    if (/[\n\r]/.test(r.model ?? '')) throw new Error(`The model for ${name} can't span lines.`);
  }
  for (const item of file.items) {
    const r = review.items.find(x => x.kind === item.kind && x.name === item.name)!;
    const key = keyOf(item);
    const moved = item.kind === 'role' ? choices.adapt?.[item.name] : undefined;
    if (r.status === 'same' && !moved) continue;
    if (!(choices.choose?.[key] ?? (r.on || !!moved))) {
      result.skipped.push(key);
      continue;
    }
    if (item.kind === 'mcp') {
      const def = JSON.parse(JSON.stringify(item.def)) as McpServerDef;
      for (const b of item.blanks ?? []) {
        const [group, ...rest] = b.split('.') as ['env' | 'headers', ...string[]];
        const k = rest.join('.');
        // What you have already stays.
        const value = servers[item.name]?.[group]?.[k] ?? '';
        if (!value) result.unfilled.push(`${item.name}: ${b}`);
        (def[group] ??= {})[k] = value;
      }
      saveMcp(scopes, { name: item.name, scope, def });
    } else if (item.kind === 'skill') {
      const target = join(dir, r.target);
      clearLink(target);
      rmSync(target, { recursive: true, force: true });
      for (const f of item.files ?? []) writeFileAt(join(target, f.path), bytesOf(f), f.exec);
    } else {
      writeFileAt(join(dir, r.target), moved ? withRoute(item.text ?? '', moved.harness, (moved.model ?? '').trim()) : item.text ?? '');
    }
    result.imported.push(key);
  }
  return result;
}
