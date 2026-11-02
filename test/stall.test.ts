import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/adapters/fake.ts';
import type { Daemon } from '../src/daemon.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: testing\n---\nYou are a test role.\n';
const MIN = 60_000;

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

const stalls = (d: Daemon, goal: string) => d.store.since(goal).filter(e => e.type === 'goal.stalled');

test('two teammates waiting on each other: the lead hears once; if the whole team stays stuck, the human does', async () => {
  const heard: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'Review part A.' });
      for (let i = 0; i < 3; i++) heard.push(await ctx.tool('wait', { timeout: 600 }));
    },
    implementer: async ctx => {
      await ctx.tool('send', { to: 'reviewer-1', text: 'Are you ready to review?' });
      while (!ctx.stopped()) await ctx.tool('wait', { timeout: 600 });
    },
    reviewer: async ctx => {
      await ctx.sleep(30);
      await ctx.tool('send', { to: 'implementer-1', text: 'Tell me when part A is ready.' });
      await ctx.tool('wait', { timeout: 600 });
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role, reviewer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build and review part A' });
  const a = (n: string) => d.agent(goal, n);
  // Each one's wait returned the other's message; now all three wait.
  await until('all waiting', () => ['architect', 'implementer-1', 'reviewer-1'].every(n => a(n)?.state === 'waiting') && !a('implementer-1')!.inbox.length && !a('reviewer-1')!.inbox.length);
  await until('the second waits', () => d.store.since(goal).filter(e => e.type === 'message.delivered').length === 2);
  await settle();

  d.checkStalls(Date.now() + 5 * MIN);
  assert.equal(stalls(d, goal).length, 0, 'not before stallMinutes');

  const t1 = Date.now() + 11 * MIN;
  d.checkStalls(t1);
  await until('the lead hears', () => heard.length === 1);
  assert.match(heard[0], /Nobody on the team has done anything for 10\+ minutes/);
  assert.match(heard[0], /- implementer-1 \(implementer\): waiting 11 min with nothing happening; reviewer-1 is waiting too\. Last from reviewer-1, just now: "Tell me when part A is ready\."/);
  assert.match(heard[0], /- reviewer-1 \(reviewer\): .*implementer-1 is waiting too/);
  assert.match(heard[0], /the plan left a gap/);
  assert.equal(stalls(d, goal)[0].data.told, 'lead');

  d.checkStalls(t1 + MIN);
  assert.equal(stalls(d, goal).length, 1, 'once per stuck spell');
  assert.equal(d.humanInbox.length, 0);

  // The lead did nothing about it: another stallMinutes later the human hears.
  await until('the lead waits again', () => a('architect')!.state === 'waiting');
  d.checkStalls(t1 + 11 * MIN);
  const item = d.humanInbox.find(i => i.kind === 'stalled');
  assert.ok(item, 'the human is told');
  assert.equal(item.agent, 'architect');
  assert.match(item.text, /architect \(the lead\) was told 11 minutes ago but nothing has moved/);
  assert.equal(stalls(d, goal).at(-1)!.data.told, 'human');
  d.checkStalls(t1 + 30 * MIN);
  assert.equal(d.humanInbox.filter(i => i.kind === 'stalled').length, 1);

  // Answering it reaches the lead.
  d.resolveInbox(item.id, 'dismiss', 'Tell the reviewer part A is on implementer-1’s branch.');
  await until('the lead gets the answer', () => heard.length === 2);
  assert.match(heard[1], /from human: Tell the reviewer/);
  await d.close();
});

test("waiting on a teammate who has finished is a stall; waiting while others work, or on the human, isn't", async () => {
  const heard: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'Review part A when it is ready.' });
      await ctx.tool('spawn', { role: 'documenter', brief: 'Document part A.' });
      for (let i = 0; i < 5; i++) heard.push(await ctx.tool('wait', { timeout: 600 }));
    },
    implementer: async ctx => void (await ctx.tool('done', { note: 'Part A is on my branch.' })),
    reviewer: async ctx => {
      await ctx.tool('send', { to: 'implementer-1', text: 'Tell me when part A is ready.' });
      await ctx.tool('wait', { timeout: 600 });
    },
    documenter: async ctx => {
      await ctx.tool('send', { to: 'human', text: 'British or American spelling?' });
      await ctx.tool('wait', { timeout: 600 });
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role, reviewer: role, documenter: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build part A' });
  const a = (n: string) => d.agent(goal, n);
  await until('settled', () => a('reviewer-1')?.state === 'waiting' && a('documenter-1')?.state === 'waiting' && a('implementer-1')?.state === 'done' && a('architect')?.state === 'waiting');
  await until('the lead heard implementer-1 finish', () => heard.some(h => h.includes('Part A is on my branch')));
  await settle();

  const t = Date.now() + 11 * MIN;
  d.checkStalls(t);
  await until('the lead hears', () => heard.some(h => h.includes('From MetaHarness')));
  const report = heard.find(h => h.includes('From MetaHarness'))!;
  assert.match(report, /This teammate seems stuck, waiting for something that can't come:\n- reviewer-1 \(reviewer\): waiting 11 min with nothing happening; implementer-1 has finished\. Last to implementer-1/);
  assert.doesNotMatch(report, /documenter-1/, 'waiting on the human is not a stall');
  assert.doesNotMatch(report, /- architect/, 'the lead waits on teammates who are fine');
  assert.deepEqual((stalls(d, goal)[0].data.agents as { name: string }[]).map(x => x.name), ['reviewer-1']);
  await d.close();
});

test('an agent that stopped without calling done is not stuck, and stall reports can be turned off', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => void ctx.say('I stopped early.'),
  });
  const d = makeTeam({ roles: { architect: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('idle', () => d.agent(goal, 'architect')?.state === 'idle');
  d.checkStalls(Date.now() + 60 * MIN);
  assert.equal(stalls(d, goal).length, 0);
  await d.close();

  const waiting = new FakeAdapter({ architect: async ctx => void (await ctx.tool('wait', { timeout: 600 })) });
  const off = makeTeam({ roles: { architect: role }, adapters: { fake: waiting }, settings: { approvals: 'ask', stallMinutes: 0 } });
  const g2 = off.startGoal({ request: 'r' });
  await until('waiting', () => off.agent(g2, 'architect')?.state === 'waiting');
  off.checkStalls(Date.now() + 60 * MIN);
  assert.equal(stalls(off, g2).length, 0);
  await off.close();
});

test("a turn gone silent: its spawner hears once, with the harness's last warning, and can respawn it", async () => {
  const heard: string[] = [];
  let reply = '';
  let runs = 0;
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
      heard.push(await ctx.tool('wait', { timeout: 600 }));
      reply = await ctx.tool('respawn', { name: 'implementer-1', fresh: true });
      heard.push(await ctx.tool('wait', { timeout: 600 }));
      await ctx.tool('done', { note: 'Part A is built.' });
    },
    implementer: async ctx => {
      if (++runs > 1) return void (await ctx.tool('done', { note: 'Part A is built.' }));
      await ctx.tool('status', { text: 'Writing the parser' });
      // Its model call hangs: the harness retries and says so, then nothing.
      ctx.warn('Codex is retrying its model call: stream disconnected before completion');
      while (!ctx.stopped()) await ctx.sleep(10);
    },
  });
  const d = makeTeam({ roles: { architect: role, implementer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build part A' });
  const impl = () => d.agent(goal, 'implementer-1')!;
  await until('the implementer hangs', () => impl()?.state === 'working' && !!impl().lastWarning && d.agent(goal, 'architect')?.state === 'waiting');
  await settle();
  const silents = () => d.store.since(goal).filter(e => e.type === 'agent.silent');

  const early = d.respawnAgent(goal, 'implementer-1', { by: 'human' });
  assert.ok(!early.ok && /hasn't crashed or hung \(it's working/.test(early.error), 'a working agent is left alone');
  d.checkStalls(Date.now() + 5 * MIN);
  assert.equal(silents().length, 0, 'not before stallMinutes');

  // Eleven minutes with nothing from its harness.
  impl().heardAt = Date.now() - 11 * MIN;
  d.checkStalls();
  d.checkStalls();
  await until('the spawner hears', () => heard.length >= 1);
  assert.match(heard[0], /implementer-1 \(implementer\) has been in a turn for 11 min with nothing from fake · m: no reply, no tool call, no command running/);
  assert.match(heard[0], /The last thing fake said, \d+ min ago: "Codex is retrying its model call: stream disconnected before completion"/);
  assert.match(heard[0], /call respawn with name: implementer-1: that stops this session and resumes it; add fresh: true/);
  assert.equal(silents().length, 1);
  assert.equal(silents()[0].data.told, 'architect');
  assert.equal(silents().length, 1, 'once per silent spell');
  assert.equal(stalls(d, goal).length, 0, "the spawner waiting on it isn't stuck");

  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'the lead finishes');
  assert.match(reply, /Started implementer-1 again on fake · m, in a fresh session, from a handoff\. The stalled one is kept as implementer-1-stalled\./);
  assert.equal(d.agent(goal, 'implementer-1-stalled')!.state, 'ended');
  assert.match(heard[1], /Part A is built/);
  const ended = d.store.since(goal).find(e => e.agent === 'implementer-1-stalled' && e.type === 'agent.ended');
  assert.match(String(ended?.data.reason), /respawned by architect: it hung \(nothing came from fake for 11 min; its last warning: Codex is retrying/);
  await d.close();
});

test('a hung agent respawned without fresh resumes its session once the hung one has stopped', async () => {
  const firstMessages: string[] = [];
  let reply = '';
  const fake = new FakeAdapter(
    {
      architect: async ctx => {
        await ctx.tool('spawn', { role: 'implementer', brief: 'Build part A.' });
        await ctx.tool('wait', { timeout: 600 });
        reply = await ctx.tool('respawn', { name: 'implementer-1' });
        await ctx.tool('wait', { timeout: 600 });
        await ctx.tool('done', { note: 'Part A is built.' });
      },
      implementer: async ctx => {
        await ctx.tool('status', { text: 'Writing the parser' });
        while (!ctx.stopped()) await ctx.sleep(10);
      },
    },
    {},
    {
      implementer: async (ctx, text) => {
        firstMessages.push(text);
        await ctx.tool('done', { note: 'Part A is built.' });
      },
    },
  );
  const d = makeTeam({ roles: { architect: role, implementer: role }, adapters: { fake } });
  const goal = d.startGoal({ request: 'Build part A' });
  const impl = () => d.agent(goal, 'implementer-1')!;
  await until('the implementer hangs', () => impl()?.state === 'working' && impl().heardAt !== undefined && d.agent(goal, 'architect')?.state === 'waiting');
  await settle();
  impl().heardAt = Date.now() - 11 * MIN;
  d.checkStalls();

  await withTimeout(d.goals.get(goal)!.leadDone, 5000, 'the lead finishes');
  assert.match(reply, /Started implementer-1 again on fake · m, resuming its session\. The stalled one is kept as implementer-1-stalled\./);
  assert.ok(fake.started.at(-1)!.resume, 'resumed');
  assert.match(firstMessages[0], /Your session hung \(nothing came from fake for 11 min\), and architect started it again/);
  await d.close();
});
