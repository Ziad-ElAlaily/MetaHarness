import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join, relative, sep } from 'node:path';
import { parseFrontMatter } from './config.ts';
import { BUILTIN_DIR, forHarness, type Rule } from './rules.ts';

/**
 * Skills (design §18): guides with a folder of resources, in the SKILL.md format the harnesses
 * share. The agent decides when to read one, through the skill tool, on every harness alike.
 * Like MCP servers, they're a library roles carry: a role's `skills:` names the ones it has.
 * MetaHarness only points at them: a line in the prompt, or a rule (`skill:`) at the moment one
 * fits. Reading one gives a summary first (its sections and files), and a section or file on
 * request, so nothing long arrives unasked.
 */

/** Where a skill's folder is: MetaHarness's own, ~/.metaharness, or one of the repository's skill folders. */
export type SkillSource = 'built-in' | 'personal' | 'repo' | '.claude' | '.agents';

export interface Skill {
  name: string;
  description: string;
  /** Harness ids it works with, and !id to leave one out; empty: every harness. */
  harness: string[];
  body: string;
  dir: string;
  file: string;
  source: SkillSource;
  off: boolean;
  /** A tool agents made (design §24): it lives in a tools/ folder, not skills/, and every agent may read it. */
  tool: boolean;
  /** Where a tool came from, as its front matter says: who made it, who asked and why, in which goal. */
  madeBy?: string;
  askedBy?: string;
  why?: string;
  goal?: string;
  /** Programs it runs (sox, ffmpeg, python3), for mh doctor and an import's review. */
  needs: string[];
  /** Other tools or skills it calls, which an export brings along. */
  uses: string[];
}

export interface SkillLayer {
  source: SkillSource;
  /** A folder holding one folder per skill. */
  dir: string;
  /** A tools/ folder: what's in it was made by agents. */
  tool?: boolean;
}

const truthy = (v?: string) => /^(true|yes|1|on)$/i.test(v ?? '');
const list = (v?: string) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);
const NAME = /^[\w.:-]+$/;

/**
 * Skill folders from least to most specific: the built-in ones, the personal ones (skills, then
 * the tools agents made and the human kept), then the repository's: those other harnesses keep
 * (.claude/skills, .agents/skills), MetaHarness's own .metaharness/skills, and the project's
 * tools last, so a project's copy of a tool wins over the personal one while it's being changed.
 */
export function skillLayers(configDirs: string[], repo?: string | null, builtIn = true): SkillLayer[] {
  const layers: SkillLayer[] = builtIn ? [{ source: 'built-in', dir: join(BUILTIN_DIR, 'skills') }] : [];
  // null: no project, so every folder is personal.
  const personal = repo === null ? configDirs : repo ? configDirs.filter(d => d !== join(repo, '.metaharness')) : configDirs.slice(0, -1);
  const own = configDirs.filter(d => !personal.includes(d));
  for (const d of personal) layers.push({ source: 'personal', dir: join(d, 'skills') }, { source: 'personal', dir: join(d, 'tools'), tool: true });
  if (repo) layers.push({ source: '.claude', dir: join(repo, '.claude', 'skills') }, { source: '.agents', dir: join(repo, '.agents', 'skills') });
  for (const d of own) layers.push({ source: 'repo', dir: join(d, 'skills') }, { source: 'repo', dir: join(d, 'tools'), tool: true });
  return layers;
}

export function parseSkill(folder: string, text: string, dir: string, source: SkillSource, tool = false): Skill {
  const { meta, body } = parseFrontMatter(text);
  const opt = (k: string) => (meta[k] ? { [k === 'made_by' ? 'madeBy' : k === 'asked_by' ? 'askedBy' : k]: meta[k] } : {});
  return {
    name: meta.name && NAME.test(meta.name) ? meta.name : folder,
    description: meta.description || body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) || '',
    harness: list(meta.harness ?? meta.harnesses),
    body,
    dir,
    file: join(dir, 'SKILL.md'),
    source,
    off: truthy(meta.off),
    tool,
    ...opt('made_by'), ...opt('asked_by'), ...opt('why'), ...opt('goal'),
    needs: list(meta.needs),
    uses: list(meta.uses),
  };
}

/** The skills in one layer: each folder with a SKILL.md. */
export function loadSkillFolder(layer: SkillLayer): Skill[] {
  if (!existsSync(layer.dir)) return [];
  const out: Skill[] = [];
  for (const e of readdirSync(layer.dir, { withFileTypes: true })) {
    const dir = join(layer.dir, e.name);
    const file = join(dir, 'SKILL.md');
    if (e.name.startsWith('.') || !(e.isDirectory() || e.isSymbolicLink()) || !existsSync(file)) continue;
    out.push(parseSkill(e.name, readFileSync(file, 'utf8'), dir, layer.source, !!layer.tool));
  }
  return out;
}

/** Skills from each layer in order, a later one replacing an earlier one of the same name, then the settings' switches. */
export function loadSkills(layers: SkillLayer[], switches: Record<string, boolean> = {}): Map<string, Skill> {
  const out = new Map<string, Skill>();
  for (const layer of layers) for (const s of loadSkillFolder(layer)) out.set(s.name, s);
  for (const [name, on] of Object.entries(switches)) {
    const s = out.get(name);
    if (s) s.off = !on;
  }
  return out;
}

/**
 * The skills in a harness's own folder of a repository (.claude/skills, .agents/skills): what it
 * would load natively, by name and by folder where they differ, to hide them there.
 */
export function nativeSkillNames(dir: string): string[] {
  return [...new Set(loadSkillFolder({ source: 'repo', dir }).flatMap(s => [s.name, s.dir.slice(dir.length + 1)]))];
}

/* ---------------- who carries a skill ---------------- */

export interface SkillAgent {
  harness: string;
  /** Its role's `skills:`. */
  skills: string[];
}

/** The skills some role names: only those roles carry them. */
export function claimedSkills(roles: Iterable<{ skills?: string[] }>): Set<string> {
  return new Set([...roles].flatMap(r => r.skills ?? []));
}

/**
 * Whether an agent carries a skill: it's on, works with the agent's harness, and either its role
 * names it or no role does (then every role carries it). Every agent may read a tool: naming one
 * on a role, or at spawn, only puts it in that agent's kit (toolKit).
 */
export function skillFor(s: Skill, a: SkillAgent, claimed: Set<string>): boolean {
  return !s.off && forHarness(s.harness, a.harness) && (s.tool || a.skills.includes(s.name) || !claimed.has(s.name));
}

export function skillsFor(skills: Iterable<Skill>, a: SkillAgent, claimed: Set<string>): Skill[] {
  return [...skills].filter(s => skillFor(s, a, claimed)).sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Rules as an agent gets them: a rule that points at a skill (`skill:`) only when the agent
 * carries that skill, with a line naming it and what it's for after the rule's own text.
 */
export function withSkills(rules: Iterable<Rule>, mine: Skill[]): Rule[] {
  const out: Rule[] = [];
  for (const r of rules) {
    if (!r.skill) {
      out.push(r);
      continue;
    }
    const s = mine.find(x => x.name === r.skill);
    if (!s) continue;
    const pointer = `The skill ${s.name} may help here: ${s.description}\nRead it with skill("${s.name}") if it fits what you're doing.`;
    out.push({ ...r, body: r.body ? `${r.body}\n\n${pointer}` : pointer, description: r.description || `points to the skill ${s.name}` });
  }
  return out;
}

const HOW = 'skill("<name>") gives a summary with its sections and files, and skill("<name>", part) one section or file.';

/** How many other tools the prompt names, past the agent's kit. */
const LIBRARY_NAMES = 30;

/**
 * An agent's kit: the tools it was given at spawn and those its role names, in that order. The
 * rest of the library it can still read; the kit is what its prompt spells out.
 */
export function toolKit(mine: Skill[], given: string[], role: string[]): Skill[] {
  const tools = mine.filter(s => s.tool);
  const names = [...new Set([...given, ...role])];
  return names.map(n => tools.find(t => t.name === n)).filter((t): t is Skill => !!t);
}

/**
 * The Skills part of an agent's prompt; empty when it carries none. Tools come apart: the kit
 * with what each is for, then the rest of the library by name only, so a large one stays short.
 */
export function skillsPrompt(mine: Skill[], kit: Skill[] = []): string {
  const skills = mine.filter(s => !s.tool);
  const others = mine.filter(s => s.tool && !kit.includes(s));
  const parts: string[] = [];
  if (skills.length) {
    parts.push(
      '## Skills',
      `Guides for particular kinds of work, with files to go with them. Read one with the \`skill\` tool when it fits what you're doing: ${HOW}`,
      skills.map(s => `- ${s.name}: ${s.description}`).join('\n'),
    );
  }
  if (kit.length || others.length) {
    parts.push('## Tools', "Programs agents made for this project's work, each with a SKILL.md on how to use it. Read one with the `skill` tool before running it.");
    if (kit.length) parts.push(`Yours for this task:\n${kit.map(s => `- ${s.name}: ${s.description}`).join('\n')}`);
    if (others.length) {
      const shown = others.slice(0, LIBRARY_NAMES).map(s => s.name).join(', ');
      const more = others.length > LIBRARY_NAMES ? ` and ${others.length - LIBRARY_NAMES} more (skill() lists them all)` : '';
      parts.push(`${kit.length ? 'Also in the library' : 'In the library'}: ${shown}${more}.`);
    }
  }
  return parts.join('\n\n');
}

/* ---------------- reading one ---------------- */

/** All the skills an agent carries, for skill() without a name: guides, then tools, its kit first. */
export function skillList(mine: Skill[], kit: Skill[] = []): string {
  if (!mine.length) return 'There are no skills for your role.';
  const skills = mine.filter(s => !s.tool);
  const tools = [...kit, ...mine.filter(s => s.tool && !kit.includes(s))];
  const line = (s: Skill) => `- ${s.name}: ${s.description}${kit.includes(s) ? ' (in your kit)' : ''}`;
  const parts = [skills.length ? `Skills:\n${skills.map(line).join('\n')}` : '', tools.length ? `Tools:\n${tools.map(line).join('\n')}` : ''];
  return `${parts.filter(Boolean).join('\n\n')}\n\nRead one with ${HOW}`;
}

/** The programs a tool needs that aren't on this machine's PATH. */
export function missingPrograms(needs: string[], path = process.env.PATH ?? ''): string[] {
  const dirs = path.split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return needs.filter(n => !dirs.some(d => exts.some(x => {
    try {
      accessSync(join(d, n + x), constants.X_OK);
      return statSync(join(d, n + x)).isFile();
    } catch {
      return false;
    }
  })));
}

/** A tool's lines on where it came from and what it needs, for its summary. */
function toolLines(s: Skill): string {
  if (!s.tool) return '';
  const from = [s.madeBy && `made by ${s.madeBy}`, s.askedBy && `for ${s.askedBy}`, s.why && `because ${s.why}`].filter(Boolean).join(' ');
  const missing = missingPrograms(s.needs);
  const needs = s.needs.length ? `Needs: ${s.needs.join(', ')}${missing.length ? ` (not installed here: ${missing.join(', ')})` : ''}.` : '';
  const uses = s.uses.length ? `Uses: ${s.uses.join(', ')}.` : '';
  return [`A tool${from ? `, ${from}` : ''}.`, needs, uses].filter(Boolean).join(' ');
}

interface Heading {
  level: number;
  title: string;
  line: number;
}

function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  for (const [i, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: h[1].length, title: h[2], line: i });
  }
  return out;
}

const WHOLE_MAX = 2500;
const INTRO_MAX = 1200;
const PART_MAX = 15_000;
const FILES_MAX = 60;

const cap = (text: string, max: number, where: string) =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n… (${text.length - max} more characters in ${where})`;

function size(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const SKIP_FILE = /^(\.|node_modules$|__pycache__$|SKILL\.md$)/;

/** The files in a skill's folder besides SKILL.md, relative, with their sizes. */
export function skillFiles(dir: string, max = FILES_MAX): { files: { path: string; bytes: number }[]; more: number } {
  const files: { path: string; bytes: number }[] = [];
  let more = 0;
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_FILE.test(e.name) && !(depth > 0 && e.name === 'SKILL.md')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 4) walk(p, depth + 1);
      } else if (e.isFile()) {
        if (files.length >= max) more++;
        else files.push({ path: relative(dir, p).split(sep).join('/'), bytes: statSync(p).size });
      }
    }
  };
  walk(dir, 0);
  return { files, more };
}

function filesPart(s: Skill): string {
  const { files, more } = skillFiles(s.dir);
  if (!files.length) return '';
  const lines = files.map(f => `- ${f.path} (${size(f.bytes)})`);
  if (more) lines.push(`- and ${more} more`);
  return `Files in ${s.dir} (read one with skill("${s.name}", part: "<path>")):\n${lines.join('\n')}`;
}

/**
 * What skill(name) gives: the description, then SKILL.md whole when it's short, else its opening
 * and its sections by heading; then the folder's files by path.
 */
export function skillSummary(s: Skill): string {
  const parts = [`# ${s.tool ? 'Tool' : 'Skill'}: ${s.name}`, s.description, toolLines(s)];
  if (s.body.length <= WHOLE_MAX) parts.push(s.body);
  else {
    const lines = s.body.split('\n');
    const hs = headingsOf(lines);
    // A title heading on the first line belongs to the opening.
    const firstText = lines.findIndex(l => l.trim());
    const sections = hs.filter(h => h.line !== firstText);
    const intro = lines.slice(0, sections[0]?.line ?? lines.length).join('\n').trim();
    if (intro) parts.push(cap(intro, INTRO_MAX, 'SKILL.md'));
    if (sections.length) {
      const top = Math.min(...sections.map(h => h.level));
      parts.push(`Sections of SKILL.md (read one with skill("${s.name}", part: "<heading>")):\n${sections.map(h => `${'  '.repeat(h.level - top)}- ${h.title}`).join('\n')}`);
    } else parts.push(`SKILL.md has no sections; read it whole with skill("${s.name}", part: "SKILL.md").`);
  }
  const files = filesPart(s);
  if (files) parts.push(files);
  return parts.filter(Boolean).join('\n\n');
}

/** A file inside the skill's folder (no way out of it, by .. or a link), or undefined. */
function fileIn(s: Skill, part: string): string | undefined {
  const p = join(s.dir, part.replace(/^\.?\//, ''));
  try {
    const real = realpathSync(p);
    const root = realpathSync(s.dir);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

const norm = (t: string) => t.toLowerCase().replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();

/** skill(name, part): a section of SKILL.md by its heading, or a file in the skill's folder by its path. */
export function skillPart(s: Skill, part: string): string {
  const file = fileIn(s, part);
  if (file) {
    const buf = readFileSync(file);
    if (buf.includes(0)) return `${part} is a binary file (${size(buf.length)}): ${file}`;
    return `# Skill ${s.name}: ${part}\n\n${cap(buf.toString('utf8'), PART_MAX, file)}`;
  }
  const lines = s.body.split('\n');
  const hs = headingsOf(lines);
  const want = norm(part);
  const h = hs.find(x => norm(x.title) === want) ?? hs.find(x => norm(x.title).includes(want)) ?? hs.find(x => want.includes(norm(x.title)) && norm(x.title).length > 3);
  if (h) {
    const end = hs.find(x => x.line > h.line && x.level <= h.level)?.line ?? lines.length;
    return `# Skill ${s.name}: ${h.title}\n\n${cap(lines.slice(h.line + 1, end).join('\n').trim(), PART_MAX, s.file)}`;
  }
  const sections = hs.map(x => `- ${x.title}`).join('\n');
  const files = filesPart(s);
  return [`The skill ${s.name} has no section or file "${part}".`, sections && `Sections:\n${sections}`, files].filter(Boolean).join('\n\n');
}
