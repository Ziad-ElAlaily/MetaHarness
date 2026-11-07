import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAdapter, type FakeScript } from '../src/adapters/fake.ts';
import { configView } from '../src/configedit.ts';
import { Daemon } from '../src/daemon.ts';
import { doctorLines } from '../src/doctor.ts';
import { git } from '../src/git.ts';
import { buildExport, importExport, parseExport, reviewImport } from '../src/sharing.ts';
import { claimedSkills, loadSkills, missingPrograms, skillLayers, skillList, skillsFor, skillsPrompt, skillSummary, toolKit } from '../src/skills.ts';
import { sameTool, toolsTouched } from '../src/tools.ts';
import { makeRepo, settle, withTimeout } from './helpers.ts';

/** Tools agents make (design §24). */

function put(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const tool = (front: string, body = 'Run scripts/run.py.') => `---\n${front}\n---\n${body}\n`;

/** A personal library with one tool and one skill; a project with its own tools, one replacing a personal one. */
function setup() {
  const personal = mkdtempSync(join(tmpdir(), 'mh-tools-home-'));
  const repo = makeRepo();
  put(personal, {
    'skills/notes/SKILL.md': tool('description: writing notes'),
    'tools/spectrogram/SKILL.md': tool('description: draws a sound as an image\nneeds: sox'),
    'tools/spectrogram/scripts/run.py': 'print("png")\n',
    'tools/waveform/SKILL.md': tool('description: draws a waveform'),
  });
  put(repo, {
    '.metaharness/tools/sfx-layer/SKILL.md': tool('description: layers sound files into one\nmade_by: toolsmith-1\nasked_by: sound-1\nwhy: agents cannot hear\ngoal: g1\nneeds: sh, no-such-program-xyz\nuses: spectrogram'),
    '.metaharness/tools/sfx-layer/scripts/run.py': 'print("wav")\n',
    '.metaharness/tools/waveform/SKILL.md': tool('description: draws a waveform, with peaks'),
  });
  return { personal, repo, dirs: [personal, join(repo, '.metaharness')] };
}

test('tools: a tools folder next to skills, the project’s last; where each came from and what it needs', () => {
  const { repo, dirs } = setup();
  const skills = loadSkills(skillLayers(dirs, repo, false));
  const sfx = skills.get('sfx-layer')!;
  assert.equal(sfx.tool, true);
  assert.equal(sfx.source, 'repo');
  assert.deepEqual([sfx.madeBy, sfx.askedBy, sfx.why, sfx.goal], ['toolsmith-1', 'sound-1', 'agents cannot hear', 'g1']);
  assert.deepEqual(sfx.needs, ['sh', 'no-such-program-xyz']);
  assert.deepEqual(sfx.uses, ['spectrogram']);
  assert.equal(skills.get('notes')!.tool, false);
  assert.equal(skills.get('waveform')!.source, 'repo', 'the project’s copy of a tool wins over the personal one');
  assert.match(skills.get('waveform')!.description, /with peaks/);
  assert.deepEqual(missingPrograms(['sh', 'no-such-program-xyz']), ['no-such-program-xyz']);
  assert.deepEqual(toolsTouched(['.metaharness/tools/sfx-layer/SKILL.md', '.metaharness/tools/sfx-layer/scripts/run.py', 'src/a.ts', '.metaharness/tools/waveform/x'], '.metaharness/tools/'), ['sfx-layer', 'waveform']);
});

test('tools: every agent may read one; the kit is spelled out, the rest of the library named', () => {
  const { repo, dirs } = setup();
  const all = loadSkills(skillLayers(dirs, repo, false)).values();
  // A role naming a tool doesn't take it from the others, as it would a skill.
  const claimed = claimedSkills([{ skills: ['sfx-layer', 'notes'] }]);
  const mine = skillsFor(all, { harness: 'codex', skills: [] }, claimed);
  assert.deepEqual(mine.map(s => s.name), ['sfx-layer', 'spectrogram', 'waveform']);
  const kit = toolKit(mine, ['spectrogram', 'nope'], ['sfx-layer']);
  assert.deepEqual(kit.map(s => s.name), ['spectrogram', 'sfx-layer']);
  const prompt = skillsPrompt(mine, kit);
  assert.doesNotMatch(prompt, /## Skills/, 'no guides here: notes went to the role that names it');
  assert.match(prompt, /^## Tools\n\nPrograms agents made[\s\S]*Yours for this task:\n- spectrogram: draws a sound as an image\n- sfx-layer: layers sound files into one\n\nAlso in the library: waveform\.$/);
  assert.match(skillsPrompt(mine), /In the library: sfx-layer, spectrogram, waveform\./);
  assert.match(skillList(mine, kit), /^Tools:\n- spectrogram: draws a sound as an image \(in your kit\)\n- sfx-layer: [^\n]*\(in your kit\)\n- waveform/);
  const summary = skillSummary(kit[1]);
  assert.match(summary, /^# Tool: sfx-layer\n\nlayers sound files into one\n\nA tool, made by toolsmith-1 for sound-1 because agents cannot hear\. Needs: sh, no-such-program-xyz \(not installed here: no-such-program-xyz\)\. Uses: spectrogram\./);
});

test('tools in the app and in mh doctor: apart from skills, what they need, whether a project copy differs', () => {
  const { personal, repo } = setup();
  put(personal, { 'tools/same/SKILL.md': tool('description: same'), 'tools/same/a.sh': 'echo\n' });
  put(repo, { '.metaharness/tools/same/SKILL.md': tool('description: same'), '.metaharness/tools/same/a.sh': 'echo\n' });
  const view = configView([{ scope: 'personal', dir: personal }, { scope: 'repo', dir: join(repo, '.metaharness') }]);
  const by = Object.fromEntries(view.skills.map(s => [s.name, s]));
  assert.equal(by['sfx-layer'].tool, true);
  assert.deepEqual(by['sfx-layer'].missing, ['no-such-program-xyz']);
  assert.equal(by.waveform.overrides, 'personal');
  assert.equal(by.waveform.personalSame, false);
  assert.equal(by.same.personalSame, true);
  assert.equal(by.notes.tool, false);
  assert.ok(sameTool(join(personal, 'tools/same'), join(repo, '.metaharness/tools/same')));

  const lines = doctorLines([], [], new Map(), [{ name: 'sfx-layer', needs: ['sh', 'nope'], missing: ['nope'] }, { name: 'plain', needs: [], missing: [] }]).join('\n');
  assert.match(lines, /Tools agents made\n\n {2}✗ sfx-layer\s+needs sh, nope · not installed here: nope/);
  assert.doesNotMatch(lines, /plain/);
});

test('tools travel in an export: they bring what they use and land in tools/ again', () => {
  const { personal, repo } = setup();
  const scopes = [{ scope: 'personal' as const, dir: personal }, { scope: 'repo' as const, dir: join(repo, '.metaharness') }];
  const r = buildExport(scopes, { name: 'sound', items: [{ kind: 'skill', name: 'sfx-layer' }] });
  assert.deepEqual(r.members.map(m => `${m.name}${m.via ? ` via ${m.via}` : ''}`), ['sfx-layer', 'spectrogram via skill/sfx-layer']);
  assert.ok(r.file.items.every(i => i.tool === true));

  const other = mkdtempSync(join(tmpdir(), 'mh-tools-other-'));
  const there = [{ scope: 'personal' as const, dir: other }];
  const file = parseExport(JSON.stringify(r.file));
  const review = reviewImport(file, there, 'personal', { canRun: () => true, jobs: {} });
  const sfx = review.items.find(i => i.name === 'sfx-layer')!;
  assert.equal(sfx.target, 'tools/sfx-layer');
  assert.ok(sfx.powers.includes('A tool agents made, not a guide someone wrote'));
  assert.ok(sfx.powers.some(p => /Runs programs it expects on this machine: sh, no-such-program-xyz/.test(p)));
  assert.deepEqual(review.unmet, [], 'what it uses comes with it');
  importExport(file, there, 'personal', {}, { canRun: () => true, jobs: {} });
  assert.ok(existsSync(join(other, 'tools/sfx-layer/scripts/run.py')));
  assert.ok(existsSync(join(other, 'tools/spectrogram/SKILL.md')));
  assert.ok(!existsSync(join(other, 'skills/sfx-layer')));
  assert.equal(loadSkills(skillLayers([other], null, false)).get('sfx-layer')!.tool, true);
});

test('elevating a tool: it moves to the personal library, and its removal from the project is committed alone', async () => {
  const { personal, repo } = setup();
  put(repo, { 'src/wip.ts': 'unsaved work\n' });
  git(repo, 'add', '.metaharness');
  git(repo, 'commit', '-qm', 'Tools');
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [personal, join(repo, '.metaharness')], adapters: { fake: new FakeAdapter({}) }, pollMs: 0 });
  try {
    const r = (await d.command({ cmd: 'tool.elevate', name: 'waveform' })) as { result: string; config: { skills: { name: string; source: string; tool: boolean }[] } };
    assert.match(r.result, /^Moved waveform to your personal library \(.*tools\/waveform\)\. The project's copy is removed in commit [0-9a-f]{7}\.$/);
    assert.match(readFileSync(join(personal, 'tools/waveform/SKILL.md'), 'utf8'), /with peaks/, 'the project’s version replaced the personal one');
    assert.ok(!existsSync(join(repo, '.metaharness/tools/waveform')));
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Move the tool waveform to the personal library');
    assert.deepEqual(git(repo, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['.metaharness/tools/waveform/SKILL.md']);
    assert.match(git(repo, 'status', '--porcelain'), /\?\? src\//, 'the rest of the checkout is as it was');
    assert.equal(r.config.skills.find(s => s.name === 'waveform')!.source, 'personal');
    await assert.rejects(d.command({ cmd: 'tool.elevate', name: 'spectrogram' }), /in your personal library already/);
    await assert.rejects(d.command({ cmd: 'tool.elevate', name: 'notes' }), /no tool called notes/);
  } finally {
    await d.close();
  }
});

/** A team whose toolsmith starts when messaged; the project already has the tool spectrogram. */
function team(scripts: Record<string, FakeScript>) {
  const personal = mkdtempSync(join(tmpdir(), 'mh-tools-home-'));
  const repo = makeRepo();
  put(personal, {
    'roles/lead.md': '---\nharness: fake\nmodel: m\n---\nLead.\n',
    'roles/sound.md': '---\nharness: fake\nmodel: m\n---\nMake sounds.\n',
    'roles/toolsmith.md': '---\nharness: fake\nmodel: m\non_demand: true\ngood_at: making tools\n---\nMake tools.\n',
  });
  put(repo, { '.metaharness/tools/spectrogram/SKILL.md': tool('description: draws a sound as an image') });
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'A tool');
  const fake = new FakeAdapter(scripts);
  const d = new Daemon({ home: mkdtempSync(join(tmpdir(), 'mh-home-')), repo, dbPath: ':memory:', configDirs: [personal, join(repo, '.metaharness')], adapters: { fake }, pollMs: 0, settings: { approvals: 'ask' } });
  return { d, fake, repo };
}

test('tools in a run: a kit at spawn, the toolsmith started by a message, a new tool for the lead, a change for its users', async () => {
  const seen: Record<string, string | null> = {};
  const leadHeard: string[] = [];
  let goal = '';
  let soundDone = false;
  const { d, fake, repo } = team({
    lead: async ctx => {
      seen.team = await ctx.tool('team', {});
      seen.spawn = await ctx.tool('spawn', { role: 'sound', brief: 'Make an explosion', tools: ['spectrogram', 'sfx-layr', 'nope'] });
      while (!soundDone) {
        const w = await ctx.tool('wait', { timeout: 1, on: 'sound-1', for: 'the explosion' });
        leadHeard.push(w);
        if (/sound-1: exploded/.test(w)) soundDone = true;
        const m = await ctx.nextMessage(20);
        if (m) leadHeard.push(m);
      }
      await ctx.tool('done', { note: 'ok' });
    },
    sound: async ctx => {
      seen.list = await ctx.tool('skill', {});
      seen.ask = await ctx.tool('send', { to: 'toolsmith', text: 'I need to layer sounds: wavs in, one wav out, and a way to see it.' });
      seen.reply = await ctx.nextMessage(5000);
      seen.read = await ctx.tool('skill', { name: 'sfx-layer' });
      seen.again = await ctx.tool('send', { to: 'toolsmith', text: 'Can it fade each layer?' });
      seen.changed = await ctx.nextMessage(5000);
      await ctx.tool('done', { note: 'exploded' });
    },
    toolsmith: async ctx => {
      seen.brief = ctx.spec.brief;
      const commit = async (text: string, message: string) => {
        ctx.writeFile('.metaharness/tools/sfx-layer/SKILL.md', text);
        await ctx.run(`git add .metaharness/tools/sfx-layer && git commit -m "${message}"`, 5);
        git(repo, 'add', '.metaharness/tools/sfx-layer');
        git(repo, 'commit', '-qm', message);
        d.refreshGit(goal);
      };
      await commit(tool('description: layers sound files into one\nmade_by: toolsmith-1'), 'tool sfx-layer: layers wavs');
      await ctx.tool('send', { to: 'sound-1', text: 'sfx-layer is ready: skill("sfx-layer").' });
      seen.request2 = await ctx.nextMessage(5000);
      await commit(tool('description: layers sound files into one, with fades\nmade_by: toolsmith-1'), 'tool sfx-layer: fades');
      await ctx.tool('done', { note: 'Made sfx-layer' });
    },
  });
  goal = d.startGoal({ request: 'Sounds for the game', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 15_000, 'lead done');
  await settle();
  const g = d.goals.get(goal)!;

  assert.match(seen.team!, /- toolsmith \(starts when messaged\): making tools/);
  assert.match(seen.spawn!, /^Started sound-1 \(fake · m\) in the shared folder\. Its kit: spectrogram\. There's no tool called sfx-layr, nope, so sound-1 doesn't have them\. The tools are: spectrogram\./);
  const soundPrompt = fake.started.find(s => s.spec.agent === 'sound-1')!.spec.systemPrompt;
  assert.match(soundPrompt, /## Tools[\s\S]*Yours for this task:\n- spectrogram: draws a sound as an image/);
  assert.match(soundPrompt, /### tools\n\nYour team can make its own tools/, 'the default rule tells it about tools');
  const smithPrompt = fake.started.find(s => s.spec.agent === 'toolsmith-1')!.spec.systemPrompt;
  assert.doesNotMatch(smithPrompt, /### tools\n/, 'the toolsmith doesn’t get the rule about asking itself');
  assert.match(seen.list!, /Tools:\n- spectrogram: draws a sound as an image \(in your kit\)/);

  assert.match(seen.ask!, /^toolsmith wasn't on the team, so MetaHarness started toolsmith-1 with your message as its task\. It will answer you soon/);
  assert.match(seen.brief!, /^sound-1 asked for this:\n\nI need to layer sounds[\s\S]*Answer sound-1 with send \(to: sound-1\)/);
  const smith = g.agents.get('toolsmith-1')!;
  assert.equal(smith.parent, 'lead');
  assert.equal(smith.cwd, g.dir, 'in the checkout');
  assert.equal(smith.worktree, undefined);
  assert.match(seen.reply!, /from toolsmith-1|sfx-layer is ready/);
  assert.match(seen.read!, /^# Tool: sfx-layer\n\nlayers sound files into one/, 'a tool written since the library was read');
  assert.match(seen.again!, /^Sent to toolsmith-1\./, 'one toolsmith per goal: the next message reaches it');
  assert.match(seen.request2!, /Can it fade each layer\?/);
  assert.match(seen.changed!, /^\[MetaHarness\] The tool sfx-layer was changed by toolsmith-1 \(commit [0-9a-f]{7}: tool sfx-layer: fades\)\. Read it again with skill\("sfx-layer"\)/);

  const heard = leadHeard.join('\n');
  assert.match(heard, /\[MetaHarness\] sound-1 asked for toolsmith, so MetaHarness started toolsmith-1 \(it starts when messaged\)\. The request: "I need to layer sounds/);
  assert.match(heard, /\[MetaHarness\] New tool from toolsmith-1: sfx-layer: layers sound files into one Teammates can read it/);
  assert.doesNotMatch(heard, /sfx-layer was changed/, 'the lead never read it, so it doesn’t hear of changes');

  const events = d.store.since(goal);
  assert.deepEqual(events.filter(e => e.type === 'tool.changed').map(e => `${e.data.tool}${e.data.new ? ' new' : ''}`), ['sfx-layer new', 'sfx-layer']);
  assert.deepEqual(events.find(e => e.type === 'agent.spawned' && e.agent === 'sound-1')!.data.tools, ['spectrogram']);
  assert.equal(events.find(e => e.type === 'agent.spawned' && e.agent === 'toolsmith-1')!.data.onDemandBy, 'sound-1');
  assert.ok(events.some(e => e.type === 'skill.read' && e.data.skill === 'sfx-layer' && e.data.tool === true));
  const view = d.configView() as { skills: { name: string; usage?: { agents: number } }[] };
  assert.equal(view.skills.find(s => s.name === 'sfx-layer')!.usage!.agents, 1);
  await d.close();
});

test('tools turned off in the settings: no library, no toolsmith, the tools rule quiet', async () => {
  const seen: Record<string, string | null> = {};
  const { d, fake, repo } = team({
    lead: async ctx => {
      seen.team = await ctx.tool('team', {});
      seen.spawn = await ctx.tool('spawn', { role: 'sound', brief: 'Make an explosion', tools: ['spectrogram'] });
      seen.smith = await ctx.tool('spawn', { role: 'toolsmith', brief: 'Make a tool' });
      await ctx.tool('wait', { timeout: 5, on: 'sound-1', for: 'the explosion' });
      await ctx.tool('done', { note: 'ok' });
    },
    sound: async ctx => {
      seen.list = await ctx.tool('skill', {});
      seen.read = await ctx.tool('skill', { name: 'spectrogram' });
      seen.ask = await ctx.tool('send', { to: 'toolsmith', text: 'I need a tool' });
      await ctx.tool('done', { note: 'exploded' });
    },
  });
  writeFileSync(join(repo, '.metaharness/settings.json'), JSON.stringify({ agentTools: false }));
  d.reloadConfig();
  const goal = d.startGoal({ request: 'Sounds', lead: 'lead' });
  await withTimeout(d.goals.get(goal)!.leadDone, 15_000, 'lead done');
  await settle();

  assert.doesNotMatch(seen.team!, /toolsmith/);
  assert.match(seen.spawn!, /Tools are turned off in the settings, so sound-1 has none\./);
  assert.match(seen.smith!, /^toolsmith can't be started: making and using tools is turned off in the settings \(agentTools\)/);
  const prompt = fake.started.find(s => s.spec.agent === 'sound-1')!.spec.systemPrompt;
  assert.doesNotMatch(prompt, /## Tools|### tools\n/, 'no library and no rule about asking for tools');
  assert.doesNotMatch(seen.list!, /spectrogram/);
  assert.match(seen.read!, /^Tools are turned off in the settings, so spectrogram can't be used\./);
  assert.match(seen.ask!, /^Making and using tools is turned off in the settings, so there's no toolsmith to ask\./);
  assert.ok(!d.goals.get(goal)!.agents.has('toolsmith-1'));
  await d.close();
});
