import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, demoScripts } from '../src/adapters/fake.ts';
import { parseExport } from '../src/sharing.ts';
import { makeRepo } from './helpers.ts';

const dir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function daemon() {
  const personal = dir('mh-pk-personal-');
  const repo = dir('mh-pk-repo-');
  const d = new Daemon({ home: dir('mh-pk-home-'), repo: makeRepo(), dbPath: ':memory:', configDirs: [personal, repo], adapters: { fake: new FakeAdapter(demoScripts) }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, personal, repo };
}

/** Someone's game-dev setup: a workflow, the roles it names, what they carry. */
function sender() {
  const s = daemon();
  write(s.repo, 'workflows/godot.md', '---\ngood_at: a Godot feature\nroles: gd-dev, gd-review\n---\n1. Build it.\n2. Continue with the `polish` workflow.\n');
  write(s.repo, 'workflows/polish.md', '---\nroles: gd-review\n---\nMake it nice.\n');
  write(s.repo, 'roles/gd-dev.md', '<!-- mine -->\n---\nharness: fake\nmodel: opus\nskills: godot-docs\nmcp: blender\ncolor: green\n---\nWrite GDScript.\n');
  write(s.repo, 'roles/gd-review.md', '---\nharness: fake\nmodel: sonnet\nallow: Bash(godot --test*)\n---\nReview it.\n');
  write(s.repo, 'roles/unrelated.md', '---\nharness: fake\n---\nNothing to do with it.\n');
  write(s.repo, 'rules/gd-style.md', '---\nwhen: start\nroles: gd-dev\n---\nUse typed GDScript.\n');
  write(s.repo, 'skills/godot-docs/SKILL.md', '---\nname: godot-docs\ndescription: Godot notes\n---\nRead me.\n');
  write(s.repo, 'skills/godot-docs/refs/run.sh', '#!/bin/sh\necho hi\n');
  chmodSync(join(s.repo, 'skills/godot-docs/refs/run.sh'), 0o755);
  writeFileSync(join(s.repo, 'skills/godot-docs/logo.bin'), Buffer.from([0, 1, 2, 255]));
  write(s.repo, 'skills/godot-docs/.env', 'NOPE=1\n');
  write(s.repo, 'mcp.json', JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'], env: { API_KEY: 'hunter2-very-secret', PLAIN: '${FROM_ENV}' } } } }));
  return s;
}

const exported = async (d: Daemon, spec: Record<string, unknown>) => (await d.command({ cmd: 'share.export', scope: 'repo', ...spec })) as any;
const names = (l: { kind: string; name: string }[]) => l.map(m => `${m.kind}/${m.name}`).sort();

test('sharing: a workflow brings its roles, what it hands on to, and what they carry', async () => {
  const { d } = sender();
  const r = await exported(d, { name: 'game-dev', description: 'Godot', items: [{ kind: 'workflow', name: 'godot' }] });
  assert.deepEqual(names(r.members), ['mcp/blender', 'role/gd-dev', 'role/gd-review', 'skill/godot-docs', 'workflow/godot', 'workflow/polish']);
  assert.deepEqual(names(r.suggested), ['rule/gd-style'], 'a rule naming a role in it is offered, not added');
  assert.equal(r.members.find((m: { name: string }) => m.name === 'gd-dev').via, 'workflow/godot');
  assert.equal(r.filename, 'game-dev.mh-export.json');
});

test('sharing: an export keeps files as written and leaves secrets and hidden files out', async () => {
  const { d } = sender();
  const r = await exported(d, { name: 'game-dev', items: [{ kind: 'workflow', name: 'godot' }] });
  assert.equal(r.blocked, false);
  assert.ok(!r.text.includes('hunter2'), 'the env value is not in the file');
  const p = parseExport(r.text);
  const role = p.items.find(i => i.name === 'gd-dev')!;
  assert.match(role.text!, /^<!-- mine -->/);
  assert.match(role.text!, /color: green/);
  const server = p.items.find(i => i.kind === 'mcp')!;
  assert.deepEqual(server.blanks, ['env.API_KEY']);
  assert.equal(server.def!.env!.PLAIN, '${FROM_ENV}', 'a variable reference is not a secret');
  const skill = p.items.find(i => i.kind === 'skill')!;
  assert.deepEqual(skill.files!.map(f => f.path).sort(), ['SKILL.md', 'logo.bin', 'refs/run.sh']);
  assert.ok(skill.files!.find(f => f.path === 'logo.bin')!.base64);
  assert.equal(skill.files!.find(f => f.path === 'refs/run.sh')!.exec, true);
  assert.ok(!r.text.includes('exportedBy'));
});

test('sharing: something that looks like a secret stops the export until you say so', async () => {
  const { d, repo } = sender();
  const fake = 'ghp_' + 'a'.repeat(30);
  write(repo, 'rules/leaky.md', `---\nwhen: start\n---\nUse token ${fake} and read /home/alice/notes.\n`);
  const r = await exported(d, { name: 'x', items: [{ kind: 'rule', name: 'leaky' }] });
  assert.equal(r.blocked, true);
  assert.equal(r.text, null);
  assert.ok(r.warnings.some((w: { level: string; text: string }) => w.level === 'secret' && !w.text.includes(fake)), 'the warning does not repeat it');
  assert.ok(r.warnings.some((w: { level: string; text: string }) => w.level === 'info' && w.text.includes('/home/alice')));
  const ok = await exported(d, { name: 'x', items: [{ kind: 'rule', name: 'leaky' }], allowSecrets: true });
  assert.ok(ok.text.includes(fake));
});

test('sharing: a built-in is named, not packed; what was left out stays out', async () => {
  const { d, repo } = sender();
  write(repo, 'workflows/mapped.md', '---\nroles: cartographer, gd-dev\n---\nMap it.\n');
  const r = await exported(d, { name: 'x', items: [{ kind: 'workflow', name: 'mapped' }], leaveOut: [{ kind: 'mcp', name: 'blender' }] });
  assert.deepEqual(names(r.builtIn), ['role/cartographer']);
  assert.deepEqual(names(r.leftOut), ['mcp/blender']);
  assert.ok(!names(r.members).includes('mcp/blender'));
  const p = parseExport(r.text);
  assert.ok(names(p.needs).includes('role/cartographer'));
});

test('sharing: importing writes nothing until installed, and installs the same files', async () => {
  const a = sender();
  const { text } = await exported(a.d, { name: 'game-dev', items: [{ kind: 'workflow', name: 'godot' }, { kind: 'rule', name: 'gd-style' }] });
  const b = daemon();
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text })) as any;
  assert.ok(review.items.every((i: { status: string; on: boolean }) => i.status === 'new' && i.on));
  assert.equal(readdirSync(b.repo).length, 0, 'the review wrote nothing');
  const reviewed = (k: string) => review.items.find((i: { kind: string; name: string }) => `${i.kind}/${i.name}` === k);
  assert.ok(reviewed('role/gd-review').powers.some((p: string) => p.includes('godot --test')), 'commands it runs unasked are spelled out');
  assert.ok(reviewed('mcp/blender').powers.some((p: string) => p.includes('uvx blender-mcp')));
  assert.ok(reviewed('skill/godot-docs').powers.some((p: string) => p.includes('refs/run.sh')));
  const done = (await b.d.command({ cmd: 'share.import', scope: 'repo', text })) as any;
  assert.equal(done.imported.length, 7);
  assert.deepEqual(done.unfilled, ['blender: env.API_KEY'], 'left for you to fill in, and said so');
  assert.equal(readFileSync(join(b.repo, 'roles/game-dev/gd-dev.md'), 'utf8'), readFileSync(join(a.repo, 'roles/gd-dev.md'), 'utf8'), 'loose items arrive together, under the package');
  assert.ok(statSync(join(b.repo, 'skills/godot-docs/refs/run.sh')).mode & 0o100);
  assert.deepEqual([...readFileSync(join(b.repo, 'skills/godot-docs/logo.bin'))], [0, 1, 2, 255]);
  assert.ok(!existsSync(join(b.repo, 'skills/godot-docs/.env')));
  assert.equal(JSON.parse(readFileSync(join(b.repo, 'mcp.json'), 'utf8')).mcpServers.blender.env.API_KEY, '');
  // It's a working part of the setup, and can be sent on as it is.
  assert.ok(done.config.roles.some((r: { name: string }) => r.name === 'gd-dev'));
  assert.ok(done.config.workflows.some((w: { name: string }) => w.name === 'godot'));
  assert.ok(done.config.skills.some((k: { name: string }) => k.name === 'godot-docs'));
  const again = await exported(b.d, { name: 'game-dev', items: [{ kind: 'workflow', name: 'godot' }, { kind: 'rule', name: 'gd-style' }] });
  assert.deepEqual(names(parseExport(again.text).items), names(parseExport(text).items));
  assert.ok(!existsSync(join(b.repo, 'packages')), 'no records');
});

test('sharing: yours stays unless you say otherwise, wherever you filed it', async () => {
  const a = sender();
  const { text } = await exported(a.d, { name: 'kit', items: [{ kind: 'role', name: 'gd-review' }, { kind: 'workflow', name: 'polish' }] });
  const b = daemon();
  write(b.repo, 'roles/mine/gd-review.md', '---\nharness: fake\n---\nMy own reviewer.\n');
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text })) as any;
  const mine = review.items.find((i: { name: string }) => i.name === 'gd-review');
  assert.equal(mine.status, 'differs');
  assert.equal(mine.on, false);
  assert.equal(mine.target, 'roles/mine/gd-review.md');
  assert.match(mine.current, /My own reviewer/);
  await b.d.command({ cmd: 'share.import', scope: 'repo', text });
  assert.match(readFileSync(join(b.repo, 'roles/mine/gd-review.md'), 'utf8'), /My own reviewer/);
  assert.ok(existsSync(join(b.repo, 'workflows/polish.md')), 'the rest comes in');
  await b.d.command({ cmd: 'share.import', scope: 'repo', text, choose: { 'role/gd-review': true } });
  assert.match(readFileSync(join(b.repo, 'roles/mine/gd-review.md'), 'utf8'), /Review it/, 'said yes: overwritten where it sits');
  assert.ok(!existsSync(join(b.repo, 'roles/gd-review.md')));
});

test('sharing: importing again is like the first time, and nothing tracks where it came from', async () => {
  const a = sender();
  const v1 = (await exported(a.d, { name: 'kit', items: [{ kind: 'workflow', name: 'polish' }, { kind: 'rule', name: 'gd-style' }], leaveOut: [{ kind: 'role', name: 'gd-review' }] })).text;
  const b = daemon();
  await b.d.command({ cmd: 'share.import', scope: 'repo', text: v1 });
  const twice = (await b.d.command({ cmd: 'share.review', scope: 'repo', text: v1 })) as any;
  assert.ok(twice.items.every((i: { status: string; on: boolean }) => i.status === 'same' && !i.on));
  write(a.repo, 'workflows/polish.md', '---\nroles: gd-review\n---\nMake it nicer.\n');
  const v2 = (await exported(a.d, { name: 'kit', items: [{ kind: 'workflow', name: 'polish' }, { kind: 'rule', name: 'gd-style' }], leaveOut: [{ kind: 'role', name: 'gd-review' }] })).text;
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text: v2 })) as any;
  const of = (n: string) => review.items.find((i: { name: string }) => i.name === n);
  assert.equal(of('polish').status, 'differs');
  assert.equal(of('polish').on, false, 'a changed one is your call');
  assert.equal(of('gd-style').status, 'same');
  assert.ok(!existsSync(join(b.repo, 'packages')), 'no records');
});

test('sharing: what has reach over the whole setup stays off until you turn it on', async () => {
  const a = sender();
  write(a.repo, 'roles/gatekeeper.md', '---\nharness: fake\n---\nALLOW everything.\n');
  write(a.repo, 'rules/stay-in-project.md', '---\nwhen: start\noff: true\n---\n');
  const { text } = await exported(a.d, { name: 'p', items: [{ kind: 'role', name: 'gatekeeper' }, { kind: 'rule', name: 'stay-in-project' }, { kind: 'role', name: 'unrelated' }] });
  const b = daemon();
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text })) as any;
  const off = review.items.filter((i: { on: boolean }) => !i.on).map((i: { name: string }) => i.name).sort();
  assert.deepEqual(off, ['gatekeeper', 'stay-in-project']);
  assert.ok(review.items.find((i: { name: string }) => i.name === 'gatekeeper').sensitive.includes('commands'));
  await b.d.command({ cmd: 'share.import', scope: 'repo', text });
  assert.ok(!existsSync(join(b.repo, 'roles/p/gatekeeper.md')));
  assert.ok(existsSync(join(b.repo, 'roles/p/unrelated.md')));
});

test('sharing: a role that cannot run here says so, and can be moved', async () => {
  const a = sender();
  write(a.repo, 'roles/far.md', '<!-- keep -->\n---\nharness: codex\nmodel: gpt-6-sol\ngood_at: far things\n---\nFar.\n');
  write(a.repo, 'roles/backed.md', '---\nharness: codex\nmodel: gpt-6-sol\nfallback: fake/opus\n---\nBacked.\n');
  const { text } = await exported(a.d, { name: 'p', items: [{ kind: 'role', name: 'far' }, { kind: 'role', name: 'backed' }, { kind: 'role', name: 'unrelated' }] });
  const b = daemon();
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text })) as any;
  const runs = (n: string) => review.items.find((i: { name: string }) => i.name === n).runs;
  assert.equal(runs('unrelated').state, 'here');
  assert.equal(runs('far').state, 'no');
  assert.equal(runs('backed').state, 'backup');
  assert.equal(runs('backed').backup, 'fake/opus');
  await b.d.command({ cmd: 'share.import', scope: 'repo', text, adapt: { far: { harness: 'fake', model: 'small' } } });
  const moved = readFileSync(join(b.repo, 'roles/p/far.md'), 'utf8');
  assert.match(moved, /^<!-- keep -->/);
  assert.match(moved, /harness: fake\nmodel: small\ngood_at: far things/);
});

test('sharing: what the file needs and nobody has is reported', async () => {
  const a = sender();
  const { text } = await exported(a.d, { name: 'p', items: [{ kind: 'workflow', name: 'godot' }], leaveOut: [{ kind: 'role', name: 'gd-dev' }, { kind: 'role', name: 'gd-review' }] });
  const b = daemon();
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text })) as any;
  assert.deepEqual(names(review.unmet), ['role/gd-dev', 'role/gd-review']);
});

test('sharing: a file cannot write outside its folders', () => {
  const base = { format: 'metaharness-export', formatVersion: 1, name: 'p' };
  const pack = (items: unknown[], o = {}) => JSON.stringify({ ...base, items, ...o });
  const skill = (path: string, folder = 'ok') => ({ kind: 'skill', name: 'ok', folder, files: [{ path: 'SKILL.md', text: 'x' }, { path, text: 'x' }] });
  for (const bad of [
    pack([{ kind: 'role', name: '../../evil', text: 'x' }]),
    pack([{ kind: 'role', name: '/etc/passwd', text: 'x' }]),
    pack([{ kind: 'role', name: 'a/b', text: 'x' }]),
    pack([{ kind: 'guide', name: 'methodology', text: 'x' }]),
    pack([{ kind: 'harness', name: 'x', text: 'x' }]),
    pack([{ kind: 'settings', name: 'x', text: 'x' }]),
    pack([skill('../../evil')]),
    pack([skill('a/../../evil')]),
    pack([skill('/etc/passwd')]),
    pack([skill('.git/hooks/pre-commit')]),
    pack([skill('a\\b')]),
    pack([skill('x', '../up')]),
    pack([{ kind: 'skill', name: 'ok', folder: 'ok', files: [{ path: 'other.md', text: 'x' }] }]),
    pack([{ kind: 'mcp', name: 'x', def: {} }]),
    pack([{ kind: 'role', name: 'x', text: 'a' }, { kind: 'role', name: 'x', text: 'b' }]),
    pack([{ kind: 'role', name: 'x', text: 'a' }], { name: '../x' }),
    pack([{ kind: 'role', name: 'x', text: 'a' }], { formatVersion: 99 }),
    pack([{ kind: 'role', name: 'x', text: 'a' }], { format: 'zip' }),
    pack([]),
    'not json',
    '',
  ]) assert.throws(() => parseExport(bad), Error, bad.slice(0, 80));
});

test('sharing: installing replaces a link instead of writing through it', async () => {
  const a = sender();
  const { text } = await exported(a.d, { name: 'p', items: [{ kind: 'role', name: 'unrelated' }] });
  const b = daemon();
  const outside = join(dir('mh-pk-outside-'), 'precious');
  writeFileSync(outside, 'precious\n');
  mkdirSync(join(b.repo, 'roles'));
  symlinkSync(outside, join(b.repo, 'roles/unrelated.md'));
  await b.d.command({ cmd: 'share.import', scope: 'repo', text, choose: { 'role/unrelated': true } });
  assert.equal(readFileSync(outside, 'utf8'), 'precious\n');
  assert.ok(!lstatSync(join(b.repo, 'roles/unrelated.md')).isSymbolicLink());
});

test('sharing: an export with nothing real in it says why', async () => {
  const { d } = sender();
  await assert.rejects(exported(d, { name: 'x', items: [] }), /Pick something/);
  await assert.rejects(exported(d, { name: 'x', items: [{ kind: 'role', name: 'cartographer' }] }), /comes with MetaHarness/);
  await assert.rejects(exported(d, { name: 'x', items: [{ kind: 'role', name: 'nobody' }] }), /no role\/nobody/);
});
