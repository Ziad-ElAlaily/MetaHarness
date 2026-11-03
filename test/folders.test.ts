import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Daemon } from '../src/daemon.ts';
import { FakeAdapter, demoScripts } from '../src/adapters/fake.ts';
import { workflowRoleNames } from '../src/config.ts';
import { makeRepo } from './helpers.ts';

const dir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function write(root: string, rel: string, text: string): void {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function setup() {
  const personal = dir('mh-f-personal-');
  const repo = dir('mh-f-repo-');
  const d = new Daemon({ home: dir('mh-f-home-'), repo: makeRepo(), dbPath: ':memory:', configDirs: [personal, repo], adapters: { fake: new FakeAdapter(demoScripts) }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, personal, repo };
}

const role = (body = 'Do it.') => `---\nharness: fake\nmodel: opus\n---\n${body}\n`;
const config = (d: Daemon) => d.command({ cmd: 'config.get' }) as Promise<any>;
const named = (l: { name: string }[], n: string) => l.find(x => x.name === n) as any;

test('folders: roles and workflows load from one level of folders, under their own names', async () => {
  const { d, repo } = setup();
  write(repo, 'roles/game/dev.md', role());
  write(repo, 'roles/loose.md', role());
  write(repo, 'roles/game/deep/too-far.md', role());
  write(repo, 'roles/.hidden/nope.md', role());
  write(repo, 'workflows/game/ship.md', '---\ngood_at: shipping\n---\nShip it.\n');
  const c = await config(d);
  assert.equal(named(c.roles, 'dev').folder, 'game');
  assert.equal(named(c.roles, 'loose').folder, '');
  assert.ok(!named(c.roles, 'too-far'), 'one level only');
  assert.ok(!named(c.roles, 'nope'));
  assert.equal(named(c.workflows, 'ship').folder, 'game');
  assert.deepEqual(c.folders.role, ['game']);
  assert.deepEqual(c.folders.workflow, ['game']);
});

test('folders: each tab has its own, and a config folder\'s are merged with the other\'s', async () => {
  const { d, repo, personal } = setup();
  write(repo, 'roles/mobile/a.md', role());
  write(personal, 'roles/game/b.md', role());
  write(repo, 'workflows/tools/w.md', 'Go.\n');
  const c = await config(d);
  assert.deepEqual(c.folders.role, ['game', 'mobile']);
  assert.deepEqual(c.folders.workflow, ['tools']);
});

test('folders: saving moves an item between folders, and a save that says nothing leaves it there', async () => {
  const { d, repo } = setup();
  write(repo, 'roles/dev.md', '<!-- kept -->\n---\nharness: fake\ncolor: blue\n---\nHi.\n');
  await d.command({ cmd: 'role.update', name: 'dev', changes: { folder: 'game' } });
  assert.ok(!existsSync(join(repo, 'roles/dev.md')));
  const moved = readFileSync(join(repo, 'roles/game/dev.md'), 'utf8');
  assert.match(moved, /<!-- kept -->/);
  assert.match(moved, /color: blue/);
  // The assistant's and older clients' saves don't mention folders.
  await d.command({ cmd: 'role.save', scope: 'repo', name: 'dev', harness: 'fake', instructions: 'New.', previous: { name: 'dev', scope: 'repo' } });
  assert.match(readFileSync(join(repo, 'roles/game/dev.md'), 'utf8'), /New\./);
  await d.command({ cmd: 'role.update', name: 'dev', changes: { folder: '' } });
  assert.ok(existsSync(join(repo, 'roles/dev.md')));
  assert.ok(!existsSync(join(repo, 'roles/game/dev.md')));

  write(repo, 'workflows/ship.md', '---\ngood_at: x\n---\nGo.\n');
  await d.command({ cmd: 'workflow.save', scope: 'repo', name: 'ship', body: 'Go.', goodAt: 'x', folder: 'game', previous: { name: 'ship', scope: 'repo' } });
  assert.ok(existsSync(join(repo, 'workflows/game/ship.md')));
  await d.command({ cmd: 'workflow.save', scope: 'repo', name: 'ship', body: 'Go on.', goodAt: 'x', previous: { name: 'ship', scope: 'repo' } });
  assert.match(readFileSync(join(repo, 'workflows/game/ship.md'), 'utf8'), /Go on/);
  await d.command({ cmd: 'workflow.delete', scope: 'repo', name: 'ship' });
  assert.ok(!existsSync(join(repo, 'workflows/game/ship.md')));
  await assert.rejects(d.command({ cmd: 'role.update', name: 'dev', changes: { folder: '../out' } }), /folder name/);
});

test('folders: a name is taken across folders, and a duplicate made by hand is pointed out', async () => {
  const { d, repo } = setup();
  write(repo, 'roles/game/dev.md', role());
  await assert.rejects(d.command({ cmd: 'role.save', scope: 'repo', name: 'dev', harness: 'fake', instructions: 'x' }), /already a role called dev.*under game/);
  await assert.rejects(d.command({ cmd: 'role.save', scope: 'repo', name: 'dev', harness: 'fake', instructions: 'x', folder: 'other' }), /already a role called dev/);
  write(repo, 'roles/other/dev.md', role('Other.'));
  const c = await config(d);
  assert.equal(named(c.roles, 'dev').folder, 'other');
  assert.deepEqual(named(c.roles, 'dev').alsoAt, [join(repo, 'roles/game/dev.md')]);
});

test('folders: a workflow names roles one by one, or a whole folder as it is now', async () => {
  assert.deepEqual(workflowRoleNames(['game/', 'solo'], [{ name: 'a', folder: 'game' }, { name: 'b', folder: 'game' }, { name: 'c', folder: 'x' }, { name: 'solo' }]), ['a', 'b', 'solo']);
  const { d, repo } = setup();
  write(repo, 'roles/game/dev.md', role());
  write(repo, 'roles/game/qa.md', role());
  write(repo, 'roles/other.md', role());
  write(repo, 'roles/solo.md', role());
  write(repo, 'workflows/ship.md', '---\nroles: game/, solo\n---\nGo.\n');
  d.reloadConfig();
  const started = await d.command({ cmd: 'goal.start', request: 'x', lead: 'solo', workflow: 'ship' }) as any;
  const g = (d as any).goals.get(started.goal);
  const lead = [...g.agents.values()][0];
  const can = () => d.rolesFor(lead, (d as any).defaultProject.config).roles.map((r: { name: string }) => r.name);
  assert.ok(can().includes('dev'));
  assert.ok(can().includes('qa'));
  assert.ok(can().includes('solo'));
  assert.ok(!can().includes('other'));
  // A role filed there later is in; a folder emptied doesn't open the list up to everyone.
  write(repo, 'roles/game/late.md', role());
  d.reloadConfig();
  assert.ok(can().includes('late'));
  write(repo, 'workflows/ship.md', '---\nroles: ghost/\n---\nGo.\n');
  d.reloadConfig();
  assert.ok(!can().includes('other'), 'a folder that is not there is nobody, not everybody');
  await d.command({ cmd: 'goal.end', goal: started.goal });
});

test('folders: making, renaming and removing one', async () => {
  const { d, repo, personal } = setup();
  let c = (await d.command({ cmd: 'folder.save', kind: 'role', scope: 'repo', name: 'game' })) as any;
  assert.deepEqual(c.config.folders.role, ['game'], 'an empty one shows');
  await assert.rejects(d.command({ cmd: 'folder.save', kind: 'role', scope: 'repo', name: 'game' }), /already a folder/);
  await assert.rejects(d.command({ cmd: 'folder.save', kind: 'role', scope: 'repo', name: '../x' }), /folder name/);
  await assert.rejects(d.command({ cmd: 'folder.save', kind: 'rule', scope: 'repo', name: 'x' }), /roles and workflows/);

  write(repo, 'roles/game/dev.md', role());
  write(personal, 'roles/game/qa.md', role());
  write(repo, 'workflows/ship.md', '<!-- note -->\n---\ngood_at: x\nroles: game/, solo\n---\nThe roles: game/ line in the body stays.\n');
  c = await d.command({ cmd: 'folder.save', kind: 'role', name: 'godot', previous: 'game' });
  assert.deepEqual(c.config.folders.role, ['godot']);
  assert.ok(existsSync(join(repo, 'roles/godot/dev.md')));
  assert.ok(existsSync(join(personal, 'roles/godot/qa.md')), 'in every config folder that has it');
  const text = readFileSync(join(repo, 'workflows/ship.md'), 'utf8');
  assert.match(text, /^<!-- note -->/);
  assert.match(text, /roles: godot\/, solo\n/, 'workflows naming it follow');
  assert.match(text, /The roles: game\/ line in the body stays/);

  // Removing leaves what's in it, and the workflow keeps the same team.
  c = await d.command({ cmd: 'folder.delete', kind: 'role', name: 'godot' });
  assert.deepEqual(c.config.folders.role, []);
  assert.ok(existsSync(join(repo, 'roles/dev.md')));
  assert.ok(existsSync(join(personal, 'roles/qa.md')));
  assert.match(readFileSync(join(repo, 'workflows/ship.md'), 'utf8'), /roles: (dev, qa|qa, dev), solo\n/);
});

test('folders: removing a folder never turns a workflow into one that allows every role', async () => {
  const { d, repo } = setup();
  mkdirSync(join(repo, 'roles/empty'), { recursive: true });
  write(repo, 'workflows/ship.md', '---\nroles: empty/\n---\nGo.\n');
  await d.command({ cmd: 'folder.delete', kind: 'role', name: 'empty' });
  assert.match(readFileSync(join(repo, 'workflows/ship.md'), 'utf8'), /roles: empty\//);
});

test('folders: a name also outside the folder stays put, and says so', async () => {
  const { d, repo } = setup();
  write(repo, 'roles/dup.md', role('Outside.'));
  write(repo, 'roles/game/dup.md', role('Inside.'));
  const r = (await d.command({ cmd: 'folder.delete', kind: 'role', name: 'game' })) as any;
  assert.match(r.result, /dup\.md stayed/);
  assert.match(readFileSync(join(repo, 'roles/dup.md'), 'utf8'), /Outside/);
  assert.match(readFileSync(join(repo, 'roles/game/dup.md'), 'utf8'), /Inside/);
});

/* ---------------- with exports ---------------- */

const exported = async (d: Daemon, spec: Record<string, unknown>) => (await d.command({ cmd: 'share.export', ...spec })) as any;

test('folders: a workflow naming a folder brings what is in it, and it arrives in that folder', async () => {
  const a = setup();
  write(a.repo, 'roles/game/dev.md', role());
  write(a.repo, 'roles/game/qa.md', role());
  write(a.repo, 'roles/other.md', role());
  write(a.repo, 'workflows/tools/ship.md', '---\nroles: game/\n---\nGo.\n');
  const r = await exported(a.d, { name: 'kit', items: [{ kind: 'workflow', name: 'ship' }] });
  assert.deepEqual(r.members.map((m: { name: string }) => m.name).sort(), ['dev', 'qa', 'ship']);
  const b = setup();
  await b.d.command({ cmd: 'share.import', scope: 'repo', text: r.text });
  assert.ok(existsSync(join(b.repo, 'roles/game/dev.md')));
  assert.ok(existsSync(join(b.repo, 'workflows/tools/ship.md')));
  const c = await config(b.d);
  assert.deepEqual(workflowRoleNames(named(c.workflows, 'ship').roles, c.roles).sort(), ['dev', 'qa']);
});

test('folders: a folder left out of an export is reported to whoever installs it', async () => {
  const a = setup();
  write(a.repo, 'roles/game/dev.md', role());
  write(a.repo, 'workflows/ship.md', '---\nroles: game/\n---\nGo.\n');
  const r = await exported(a.d, { name: 'kit', items: [{ kind: 'workflow', name: 'ship' }], leaveOut: [{ kind: 'role', name: 'dev' }] });
  const b = setup();
  const review = (await b.d.command({ cmd: 'share.review', scope: 'repo', text: r.text })) as any;
  assert.deepEqual(review.unmet.map((u: { name: string }) => u.name), ['game/']);
  // Naming one that's empty on the sender's side is a note there, and doesn't break the file.
  write(a.repo, 'workflows/ghost.md', '---\nroles: ghost/\n---\nGo.\n');
  const g = await exported(a.d, { name: 'g', items: [{ kind: 'workflow', name: 'ghost' }] });
  assert.ok(g.missing.some((m: { name: string }) => m.name === 'ghost/'));
  await b.d.command({ cmd: 'share.review', scope: 'repo', text: g.text });
});

test('folders: several loose items arrive in a folder of the export\'s name; one item arrives loose', async () => {
  const a = setup();
  write(a.repo, 'roles/one.md', role());
  write(a.repo, 'roles/two.md', role());
  write(a.repo, 'workflows/only.md', 'Go.\n');
  const { text } = await exported(a.d, { name: 'kit', items: [{ kind: 'role', name: 'one' }, { kind: 'role', name: 'two' }, { kind: 'workflow', name: 'only' }] });
  const b = setup();
  await b.d.command({ cmd: 'share.import', scope: 'repo', text });
  assert.ok(existsSync(join(b.repo, 'roles/kit/one.md')));
  assert.ok(existsSync(join(b.repo, 'roles/kit/two.md')));
  assert.ok(existsSync(join(b.repo, 'workflows/only.md')));
});

test('folders: a folder can go with everything in it, and workflows naming it allow nobody from it', async () => {
  const { d, repo, personal } = setup();
  write(repo, 'roles/game/dev.md', role());
  write(personal, 'roles/game/qa.md', role());
  write(repo, 'roles/stay.md', role());
  write(repo, 'workflows/ship.md', '---\nroles: game/\n---\nGo.\n');
  const r = (await d.command({ cmd: 'folder.delete', kind: 'role', name: 'game', contents: true })) as any;
  assert.match(r.result, /2 items/);
  assert.ok(!existsSync(join(repo, 'roles/game')));
  assert.ok(!existsSync(join(personal, 'roles/game')));
  assert.ok(existsSync(join(repo, 'roles/stay.md')));
  assert.match(readFileSync(join(repo, 'workflows/ship.md'), 'utf8'), /roles: game\//);
  const c = await config(d);
  assert.deepEqual(c.folders.role, []);
  assert.deepEqual(workflowRoleNames(named(c.workflows, 'ship').roles, c.roles), []);
  const started = (await d.command({ cmd: 'goal.start', request: 'x', lead: 'stay', workflow: 'ship' })) as any;
  const lead = [...(d as any).goals.get(started.goal).agents.values()][0];
  assert.ok(!d.rolesFor(lead, (d as any).defaultProject.config).roles.some((x: { name: string }) => x.name === 'stay'), 'not opened up to every role');
  await d.command({ cmd: 'goal.end', goal: started.goal });
});
