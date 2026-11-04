import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { git } from '../src/git.ts';
import { rulesPrompt, parseRule } from '../src/rules.ts';
import { checkouts, freezeFolder, keptAt, loadPrototype, prototypeId, prototypesRoot, withAutoload, type Prototype } from '../src/prototypes.ts';
import type { Daemon } from '../src/daemon.ts';
import { Daemon as DaemonClass } from '../src/daemon.ts';
import { makeRepo, makeTeam, withTimeout } from './helpers.ts';

const role = () => '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n';
const until = async (cond: () => boolean, what: string, ms = 8000) => withTimeout((async () => { while (!cond()) await new Promise(r => setTimeout(r, 10)); })(), ms, what);

/** Builders do what the test says with each ask; by default they write a file named after themselves. */
function team(build?: (ctx: FakeCtx, text: string) => Promise<void>) {
  const asks: { agent: string; text: string; cwd: string }[] = [];
  const builder = async (ctx: FakeCtx, text: string) => {
    asks.push({ agent: ctx.spec.agent, text, cwd: ctx.spec.cwd });
    if (build) return build(ctx, text);
    writeFileSync(join(ctx.spec.cwd, `${ctx.spec.agent}-${asks.length}.txt`), text);
    await ctx.tool('done', { note: `changed ${ctx.spec.agent}` });
  };
  const lead = async (ctx: FakeCtx) => ctx.say('Hello.');
  const turns = { prototyper: builder, 'room-lead': lead };
  const fake = new FakeAdapter(Object.fromEntries(Object.entries(turns).map(([k, f]) => [k, (ctx: FakeCtx) => f(ctx, ctx.spec.brief)])), {}, turns);
  const d = makeTeam({ roles: { prototyper: role(), 'room-lead': role() }, adapters: { fake } });
  return { d, fake, asks };
}

/** A small game in the team's repository, committed. */
function game(d: Daemon): string {
  const dir = d.defaultProject!.dir;
  writeFileSync(join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Game"\n');
  writeFileSync(join(dir, 'player.gd'), 'extends Node\nvar speed = 1\nvar jump = 1\nvar shake = 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'A game');
  return dir;
}

const proto = (d: Daemon, id: string): Prototype => loadPrototype(join(prototypesRoot(d.home, d.defaultProject!.id), id))!;
const repoOf = (d: Daemon, id: string) => join(prototypesRoot(d.home, d.defaultProject!.id), id, 'repo');
const room = (d: Daemon) => d.startRoom({ topic: 'Polish', lenses: [{ role: 'prototyper' }] });
const atVersion = (d: Daemon, id: string, n: number) => until(() => (proto(d, id)?.versions.at(-1)?.n ?? -1) >= n, `${id} at v${n}`);

test('ideas become prototypes of their own, from one frozen copy, without touching the project', async () => {
  const { d, asks } = team();
  try {
    const dir = game(d);
    // Work in progress, in the checkout: a change, a new file, and something git ignores.
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(dir, 'player.gd'), 'extends Node\nvar speed = 2\nvar jump = 1\nvar shake = 1\n');
    writeFileSync(join(dir, 'new.gd'), 'extends Node\n');
    writeFileSync(join(dir, 'secret.txt'), 'no');
    const status = git(dir, 'status', '--porcelain');
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Camera shake', ask: 'more shake' }, { title: 'Hit stop', ask: 'stop on hit' }], from: 'game', by: 'human' });
    await atVersion(d, 'camera-shake', 1);
    await atVersion(d, 'hit-stop', 1);
    await d.prototypesIdle();

    const [a, b] = [proto(d, 'camera-shake'), proto(d, 'hit-stop')];
    assert.equal(a.versions[0].sha, b.versions[0].sha, 'they start from the same commit, so they merge cleanly');
    assert.equal(a.frozen?.commit, head);
    assert.equal(a.frozen?.uncommitted, true);
    assert.equal(a.godot, '');
    const repo = repoOf(d, 'camera-shake');
    assert.match(readFileSync(join(repo, 'player.gd'), 'utf8'), /speed = 2/, 'uncommitted changes are in the copy');
    assert.ok(existsSync(join(repo, 'new.gd')), 'new files too');
    assert.ok(!existsSync(join(repo, 'secret.txt')), "what git ignores isn't");
    assert.match(readFileSync(join(repo, 'project.godot'), 'utf8'), /MhTune="\*res:\/\/\.prototype\/mh_tune\.gd"/, 'the tuning panel loads');
    assert.ok(existsSync(join(repo, '.prototype', 'mh_tune.gd')));
    assert.ok(existsSync(join(repo, '.prototype', 'NOTES.md')));
    assert.equal(git(repo, 'remote'), '', 'no way back to the project');

    assert.equal(git(dir, 'status', '--porcelain'), status, 'the project is as it was');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.ok(!git(dir, 'branch', '--list').includes('prototype'));
    assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'it added no worktree');

    assert.notEqual(asks.find(x => x.agent === 'camera-shake')!.cwd, asks.find(x => x.agent === 'hit-stop')!.cwd, 'each builder works in its own folder');
    assert.ok(existsSync(join(repo, 'camera-shake-1.txt')) || existsSync(join(repo, 'camera-shake-2.txt')));
    assert.ok(!readdirSync(repo).some(f => f.startsWith('hit-stop')), "one's changes aren't in the other");
    assert.deepEqual(d.goals.get(r)!.room!.canvas.cards.filter(c => c.kind === 'prototype').map(c => c.pending), [undefined, undefined], 'their cards are filled once they answer');
    assert.equal(d.goals.get(r)!.agents.get('lead')!.parent, 'human');
  } finally {
    await d.close();
  }
});

test('asking a builder makes a version; going back and forking keep the history', async () => {
  const { d } = team();
  try {
    game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Jump', ask: 'higher' }], from: 'small', by: 'human' });
    await atVersion(d, 'jump', 1);
    await until(() => !d.agent(r, 'jump')?.session?.busy(), 'the builder at rest');
    d.roomAsk(r, { maker: 'jump', text: 'higher still' });
    await atVersion(d, 'jump', 2);
    const repo = repoOf(d, 'jump');
    const one = readdirSync(repo).filter(f => f.startsWith('jump-'));
    assert.equal(one.length, 2);
    assert.match(readFileSync(join(prototypesRoot(d.home, d.defaultProject!.id), 'jump', 'process.md'), 'utf8'), /higher still/, 'the process is kept with the prototype');

    await until(() => !d.agent(r, 'jump')?.session?.busy(), 'the builder at rest');
    d.roomPrototypeRestore(r, 'jump', 1);
    await atVersion(d, 'jump', 3);
    await d.prototypesIdle();
    assert.equal(readdirSync(repo).filter(f => f.startsWith('jump-')).length, 1, 'back to how v1 was');
    assert.equal(proto(d, 'jump').versions[3].note, 'Back to v1');

    d.roomPrototypeFork(r, { id: 'jump', version: 2, title: 'Jump, floaty', by: 'human' });
    await until(() => !!proto(d, 'jump-floaty'), 'the fork');
    await d.prototypesIdle();
    assert.equal(readdirSync(repoOf(d, 'jump-floaty')).filter(f => f.startsWith('jump-')).length, 2, 'a fork starts from the version asked for');
    assert.equal(proto(d, 'jump-floaty').base, proto(d, 'jump').base, 'and is measured from the same base');
    const card = d.goals.get(r)!.room!.canvas.cards.find(c => c.prototype === 'jump-floaty')!;
    assert.deepEqual(card.from?.[0].take, 'v2');
    assert.equal(card.pending, undefined, 'with no ask yet, it just waits');
    assert.equal(d.goals.get(r)!.agents.has('jump-floaty'), false);
  } finally {
    await d.close();
  }
});

test('independent prototypes merge with git; conflicts go to the builder, and kept values come along', async () => {
  const edits: Record<string, (cwd: string) => void> = {
    speed: cwd => writeFileSync(join(cwd, 'player.gd'), readFileSync(join(cwd, 'player.gd'), 'utf8').replace('speed = 1', 'speed = 9')),
    shake: cwd => writeFileSync(join(cwd, 'player.gd'), readFileSync(join(cwd, 'player.gd'), 'utf8').replace('shake = 1', 'shake = 9')),
    rival: cwd => writeFileSync(join(cwd, 'player.gd'), readFileSync(join(cwd, 'player.gd'), 'utf8').replace('speed = 1', 'speed = 5')),
  };
  const { d, asks } = team(async (ctx, text) => {
    const cwd = ctx.spec.cwd;
    if (edits[ctx.spec.agent]) edits[ctx.spec.agent](cwd);
    if (/left conflicts/.test(text)) {
      // Settled by hand, as a builder would.
      const f = join(cwd, 'player.gd');
      writeFileSync(f, readFileSync(f, 'utf8').replace(/<<<<<<<[^\n]*\n/, '').replace(/=======\n[\s\S]*?>>>>>>>[^\n]*\n/, ''));
    }
    await ctx.tool('done', { note: `done ${ctx.spec.agent}` });
  });
  try {
    game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Speed', ask: 'x' }, { title: 'Shake', ask: 'x' }, { title: 'Rival', ask: 'x' }], from: 'game', by: 'human' });
    for (const id of ['speed', 'shake', 'rival']) await atVersion(d, id, 1);
    await d.prototypesIdle();
    // The Keep button, in the game.
    writeFileSync(join(repoOf(d, 'speed'), '.prototype', 'kept.json'), JSON.stringify({ values: { speed: 9 } }));
    d.refreshPrototypes();
    assert.deepEqual(keptAt(proto(d, 'speed')), { speed: 9 });
    assert.ok(!existsSync(join(repoOf(d, 'speed'), '.prototype', 'kept.json')));
    const decision = d.goals.get(r)!.room!.canvas.cards.find(c => c.kind === 'decision')!;
    assert.deepEqual(decision.values, { speed: 9 }, 'kept values are a decision on the board');

    const clean = await d.prototypeMergePreview(r, [{ id: 'speed' }, { id: 'shake' }]);
    assert.deepEqual(clean, { conflicts: [], unrelated: [] });
    const clash = await d.prototypeMergePreview(r, [{ id: 'speed' }, { id: 'rival' }]);
    assert.deepEqual(clash.conflicts, ['player.gd'], 'a dry run names the conflicts');
    assert.equal(git(repoOf(d, 'speed'), 'status', '--porcelain'), '', 'and changes no files');

    d.roomPrototypeMerge(r, { from: [{ id: 'speed' }, { id: 'shake' }], title: 'Both', ask: 'do they fight?', by: 'human' });
    await until(() => asks.some(a => a.agent === 'both'), 'the merged builder');
    await d.prototypesIdle();
    const both = readFileSync(join(repoOf(d, 'both'), 'player.gd'), 'utf8');
    assert.match(both, /speed = 9/);
    assert.match(both, /shake = 9/, 'both changes are in');
    assert.match(asks.find(a => a.agent === 'both')!.text, /do they fight\?/);
    assert.deepEqual(JSON.parse(readFileSync(join(repoOf(d, 'both'), '.prototype', 'tuning.json'), 'utf8')).values, { speed: 9 }, 'kept values carry over');

    d.roomPrototypeMerge(r, { from: [{ id: 'speed' }, { id: 'rival' }], title: 'Clash', by: 'human' });
    await until(() => asks.some(a => a.agent === 'clash' && /left conflicts/.test(a.text)), 'conflicts sent to the builder');
    await until(() => (proto(d, 'clash')?.versions.length ?? 0) >= 2 && !proto(d, 'clash').conflicts, 'settled');
    await d.prototypesIdle();
    const settled = readFileSync(join(repoOf(d, 'clash'), 'player.gd'), 'utf8');
    assert.doesNotMatch(settled, /<{7}/);
    assert.equal(git(repoOf(d, 'clash'), 'status', '--porcelain'), '', 'MetaHarness finished the merge');
    assert.equal(git(repoOf(d, 'clash'), 'rev-list', '--parents', '-1', 'HEAD').split(' ').length, 3, 'as a merge commit');
  } finally {
    await d.close();
  }
});

test('a prototype with no history in common is its builder to port', async () => {
  const { d, asks } = team();
  try {
    game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Copy', ask: 'x' }], from: 'game', by: 'human' });
    await atVersion(d, 'copy', 1);
    d.roomPrototypes(r, { ideas: [{ title: 'Alone', ask: 'x' }], from: 'small', by: 'human' });
    await atVersion(d, 'alone', 1);
    await d.prototypesIdle();
    assert.deepEqual((await d.prototypeMergePreview(r, [{ id: 'copy' }, { id: 'alone' }])).unrelated, ['alone']);
    d.roomPrototypeMerge(r, { from: [{ id: 'copy' }, { id: 'alone' }], title: 'Together', by: 'human' });
    await until(() => asks.some(a => a.agent === 'together'), 'the builder');
    assert.match(asks.find(a => a.agent === 'together')!.text, /share no history[\s\S]*alone v1/);
    assert.deepEqual(proto(d, 'together').port, [{ id: 'alone', version: 1 }]);
  } finally {
    await d.close();
  }
});

test('builders may change their prototype and read the project, and nothing else', async () => {
  const { d, fake } = team();
  try {
    const dir = game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Jump', ask: 'x' }], from: 'game', by: 'human' });
    await atVersion(d, 'jump', 1);
    const rec = d.agent(r, 'jump')!;
    const repo = repoOf(d, 'jump');
    const edit = (path: string) => d.toolPolicy(rec, { kind: 'edit', tool: 'Write', detail: path, path });
    assert.deepEqual(edit(join(repo, 'player.gd')), { allow: true });
    assert.equal((edit(join(dir, 'player.gd')) as { allow: boolean }).allow, false, "the project's files stay as they are");
    assert.equal(d.inProject(rec, join(dir, 'player.gd')), true, 'it can read the project');
    assert.equal(d.inProject(rec, join(prototypesRoot(d.home, d.defaultProject!.id), 'other', 'x')), true, 'and other prototypes');
    const spec = fake.started.find(s => s.spec.agent === 'jump')!.spec;
    assert.equal(spec.cwd, repo);
    assert.deepEqual(spec.gitDirs, [], "it gets no write to the project's git");
    assert.match(rec.systemPrompt, /MhTune\.knob/);
    assert.match(rec.systemPrompt, /Don't commit/);
    assert.equal(d.prototypeTool(rec, { action: 'start' }).startsWith('Only lead'), true, 'only the lead starts prototypes');
    const lead = d.agent(r, 'lead')!;
    assert.match(d.prototypeTool(lead, { action: 'start', ideas: [{ title: 'x' }] }), /Say where it starts from/);
    assert.throws(() => d.roomPrototypes(r, { ideas: [{ title: 'x' }], from: 'game', source: '/tmp', by: 'human' }), /isn't a checkout or a worktree/);
  } finally {
    await d.close();
  }
});

test('freezing a git worktree copies that worktree', async () => {
  const { d } = team();
  try {
    const dir = game(d);
    const wt = mkdtempSync(join(tmpdir(), 'mh-wt-'));
    git(dir, 'worktree', 'add', '-q', '-b', 'side', join(wt, 'side'));
    writeFileSync(join(wt, 'side', 'side.gd'), 'extends Node\n');
    const list = await checkouts(dir);
    assert.equal(list.length, 2);
    assert.equal(list.find(c => c.branch === 'side')?.dirty, true);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Side', ask: 'x' }], from: 'game', source: join(wt, 'side'), by: 'human' });
    await atVersion(d, 'side', 1);
    assert.ok(existsSync(join(repoOf(d, 'side'), 'side.gd')));
    assert.equal(proto(d, 'side').frozen?.branch, 'side');
  } finally {
    await d.close();
  }
});

test('a room comes back after a restart, with its board, builders and prototypes, until it is closed', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-test-'));
  const config = mkdtempSync(join(tmpdir(), 'mh-config-'));
  mkdirSync(join(config, 'roles'));
  for (const r of ['prototyper', 'room-lead']) writeFileSync(join(config, 'roles', `${r}.md`), role());
  const repo = makeRepo();
  const daemon = (fake: FakeAdapter) => new DaemonClass({ home, repo, dbPath: join(home, 'mh.db'), configDirs: [config], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  const builder = async (ctx: FakeCtx) => {
    writeFileSync(join(ctx.spec.cwd, `made-${Date.now()}.txt`), 'x');
    await ctx.tool('done', { note: 'changed' });
  };
  const turns = { prototyper: builder, 'room-lead': async (ctx: FakeCtx) => ctx.say('Hello.') };
  const d = daemon(new FakeAdapter(Object.fromEntries(Object.entries(turns).map(([k, f]) => [k, (ctx: FakeCtx) => f(ctx)])), {}, turns));
  game(d);
  const r = room(d);
  d.roomPrototypes(r, { ideas: [{ title: 'Jump', ask: 'x' }], from: 'game', by: 'human' });
  await atVersion(d, 'jump', 1);
  await d.prototypesIdle();
  d.roomCanvas(r, [{ op: 'add', kind: 'idea', title: 'Stays on the board' }], 'human');
  const cards = d.goals.get(r)!.room!.canvas.cards.length;
  await d.close();

  const d2 = daemon(new FakeAdapter({}, {}, turns));
  try {
    d2.recover();
    const g = d2.goals.get(r)!;
    assert.equal(g.status, 'running');
    assert.equal(g.room?.canvas.cards.length, cards, 'the board is back');
    assert.ok(g.room?.lenses.some(l => l.prototype === 'jump'), 'and the builder');
    assert.equal(d2.agent(r, 'jump')!.prototype, 'jump');
    assert.equal(d2.agent(r, 'jump')!.cwd, repoOf(d2, 'jump'));
    const added = d2.roomCanvas(r, [{ op: 'add', kind: 'idea', title: 'New' }], 'human');
    assert.ok(added.changed);
    assert.equal(new Set(g.room!.canvas.cards.map(c => c.id)).size, g.room!.canvas.cards.length, 'new cards get new ids');
    d2.roomAsk(r, { maker: 'jump', text: 'again' });
    await atVersion(d2, 'jump', 2);
    d2.endGoal(r);
    assert.equal(proto(d2, 'jump').room, r);
    assert.ok(existsSync(join(prototypesRoot(d2.home, d2.defaultProject!.id), 'jump', 'room-board.md')), 'closing keeps the room\'s record with the prototype');
    d2.deleteGoals([r]);
    assert.ok(proto(d2, 'jump'), 'a prototype outlasts its room');
    assert.ok(d2.prototypesList()[0].bytes > 0, 'and shows what it takes on disk');
    assert.equal(d2.prototypeDelete(undefined, 'jump'), 'Deleted the prototype jump.');
    assert.equal(proto(d2, 'jump'), undefined);
  } finally {
    await d2.close();
  }
});

test('a goal built from a prototype reads it and gets its process, independent of the room', async () => {
  const { d, fake } = team();
  try {
    const dir = game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Jump', ask: 'x' }], from: 'game', by: 'human' });
    await atVersion(d, 'jump', 1);
    await d.prototypesIdle();
    writeFileSync(join(repoOf(d, 'jump'), '.prototype', 'kept.json'), JSON.stringify({ values: { jump: 3 } }));
    d.refreshPrototypes();
    d.roomPrototypeVerdict(r, 'jump', { kind: 'keep', why: 'feels right' });
    // The real game moves on after the freeze.
    writeFileSync(join(dir, 'later.gd'), 'extends Node\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'Later');

    const started = await d.command({ cmd: 'goal.start', request: 'Build the jump', lead: 'prototyper', prototype: 'jump' });
    const goal = d.goals.get(String(started.goal))!;
    assert.equal(goal.prototypeFrom?.id, 'jump');
    assert.equal(goal.prototypeFrom?.version, 1, 'the version with the verdict');
    assert.equal(d.goals.get(r)!.status, 'running', "the room carries on: it's independent");
    const here = join(goal.sharedDir, 'imported', 'prototype', 'jump');
    for (const f of ['changes.diff', 'NOTES.md', 'process.md', 'values.json', 'room-board.md', 'room-chat.md']) assert.ok(existsSync(join(here, f)), f);
    const diff = readFileSync(join(here, 'changes.diff'), 'utf8');
    assert.match(diff, /jump-\d\.txt/, 'what it changed');
    assert.doesNotMatch(diff, /mh_tune|NOTES\.md/, 'without its tools');
    const spec = fake.started.at(-1)!.spec;
    assert.match(spec.brief, /moved on 1 commit since, changing 1 file: later\.gd/);
    assert.match(spec.brief, /jump = 3/);
    assert.match(spec.brief, /feels right/);
    assert.ok(spec.readRoots?.some(p => p.endsWith(join('prototypes', d.defaultProject!.id, 'jump'))), 'its agents may read the prototype');
    const rec = d.agent(goal.id, goal.lead)!;
    assert.equal(d.inProject(rec, join(repoOf(d, 'jump'), 'player.gd')), true);
    assert.ok(!readdirSync(dirname(here)).some(f => f.startsWith('.handoff')));
  } finally {
    await d.close();
  }
});

test('a new room carries prototypes over, and the old one no longer asks them', async () => {
  const { d } = team();
  try {
    game(d);
    const r = room(d);
    d.roomPrototypes(r, { ideas: [{ title: 'Jump', ask: 'x' }], from: 'small', by: 'human' });
    await atVersion(d, 'jump', 1);
    await d.prototypesIdle();
    const next = d.startRoom({ topic: 'More', lenses: [{ role: 'prototyper' }], from: r });
    assert.equal(proto(d, 'jump').room, next);
    assert.ok(d.goals.get(next)!.room!.lenses.some(l => l.prototype === 'jump'));
    assert.throws(() => d.roomAsk(r, { maker: 'jump', text: 'x' }), /has moved to room/);
    d.roomAsk(next, { maker: 'jump', text: 'carry on' });
    await atVersion(d, 'jump', 2);
    assert.equal(d.agent(next, 'jump')!.cwd, repoOf(d, 'jump'), 'a fresh builder, in the same folder');
  } finally {
    await d.close();
  }
});

test('names, the tuning panel line and values at a version', async () => {
  assert.equal(prototypeId('Camera shake!', []), 'camera-shake');
  assert.equal(prototypeId('Camera shake', ['camera-shake']), 'camera-shake-2');
  assert.equal(prototypeId('Lead', []), 'lead-prototype');
  assert.equal(prototypeId('???', []), 'prototype');
  assert.equal(withAutoload('a=1\n'), 'a=1\n\n[autoload]\n\nMhTune="*res://.prototype/mh_tune.gd"\n');
  const had = withAutoload('[autoload]\n\nOther="*res://o.gd"\n\n[x]\n');
  assert.match(had, /\[autoload\]\n\nMhTune=.*\n\nOther=/);
  assert.equal(withAutoload(had), had);
  const p = { versions: [{ n: 0 }, { n: 1 }, { n: 2 }], kept: [{ version: 0, values: { a: 1, b: 1 } }, { version: 2, values: { a: 2 } }] } as unknown as Prototype;
  assert.deepEqual(keptAt(p, 1), { a: 1, b: 1 });
  assert.deepEqual(keptAt(p), { a: 2, b: 1 });
});

test('a folder with no git is copied as it stands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-plain-'));
  mkdirSync(join(dir, '.godot'));
  writeFileSync(join(dir, '.godot', 'cache'), 'x');
  writeFileSync(join(dir, 'a.gd'), 'x');
  const repo = join(dir, '..', `${dir.split('/').pop()}-repo`);
  const f = await freezeFolder(dir, repo);
  assert.equal(f.commit, undefined);
  assert.ok(existsSync(join(repo, 'a.gd')));
  assert.ok(!existsSync(join(repo, '.godot')));
});

test('rules for goals built from a prototype reach only those goals', () => {
  const rule = parseRule('prototype-handoff', '---\nwhen: prototype\ndescription: d\n---\nReimplement it.\n', '/x');
  const agent = { name: 'a', role: 'r', isLead: true } as never;
  assert.doesNotMatch(rulesPrompt([rule], agent, '/x'), /Reimplement/);
  assert.match(rulesPrompt([rule], agent, '/x', false, true), /Reimplement/);
});
