import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { git } from './git.ts';
import { skillFiles } from './skills.ts';

/**
 * Tools agents make (design §24): skills in a tools/ folder, written by a toolsmith when a teammate
 * asks for one, committed with the project, and moved to the personal library when the human says
 * so. The skill loader reads them (src/skills.ts); this is what's particular to them: which tools a
 * commit changed, whether two copies are the same, and moving one to the personal library.
 */

/** The project's tools folder, relative to its repository, with forward slashes. */
export function toolsPrefix(repo: string, configDir: string): string {
  return `${relative(repo, join(configDir, 'tools')).split(sep).join('/')}/`;
}

/** The tool folders a commit's paths touch, by folder name. */
export function toolsTouched(paths: string[], prefix: string): string[] {
  const out = new Set<string>();
  for (const p of paths) if (p.startsWith(prefix)) {
    const folder = p.slice(prefix.length).split('/')[0];
    if (folder && !folder.startsWith('.')) out.add(folder);
  }
  return [...out];
}

const digest = (dir: string) => {
  const h = createHash('sha256');
  for (const p of ['SKILL.md', ...skillFiles(dir, 2000).files.map(f => f.path)].sort()) {
    if (!existsSync(join(dir, p))) continue;
    h.update(p).update('\0').update(readFileSync(join(dir, p))).update('\0');
  }
  return h.digest('hex');
};

/** Whether two tool folders hold the same files. */
export function sameTool(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && digest(a) === digest(b);
}

/**
 * Moves a project's tool to the personal library: its folder replaces any personal one of that
 * name, and leaves the project. When the project's repository tracks it, the removal is committed
 * on its own, so the repository doesn't keep a copy that would go stale.
 */
export function elevateTool(o: { from: string; personalTools: string; repo?: string }): { to: string; committed?: string } {
  if (!existsSync(join(o.from, 'SKILL.md'))) throw new Error(`There's no tool in ${o.from}.`);
  const folder = o.from.split(sep).pop()!;
  const to = join(o.personalTools, folder);
  rmSync(to, { recursive: true, force: true });
  cpSync(o.from, to, { recursive: true, dereference: false, filter: src => !src.split(sep).some(part => part === 'node_modules' || part === '__pycache__') });
  let tracked = false;
  const rel = o.repo ? relative(o.repo, o.from).split(sep).join('/') : '';
  if (o.repo && rel && !rel.startsWith('..')) {
    try {
      tracked = git(o.repo, 'ls-files', '--', rel).trim() !== '';
    } catch {
      tracked = false;
    }
  }
  rmSync(o.from, { recursive: true, force: true });
  if (!tracked || !o.repo) return { to };
  // Only this folder: whatever else is staged or changed in the checkout stays as it is.
  git(o.repo, 'commit', '-q', '-m', `Move the tool ${folder} to the personal library`, '--', rel);
  return { to, committed: git(o.repo, 'rev-parse', '--short', 'HEAD').trim() };
}
