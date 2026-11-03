import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import type { Daemon } from '../src/daemon.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = (extra = '') => `---\nharness: fake\nmodel: m\ngood_at: testing\n${extra}---\nYou are a test role.\n`;
const ROLES = { architect: role(), implementer: role(), reviewer: role() };

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

/** A teammate that reports back at once, and one that stays at work until told to stop. */
const finishes = async (ctx: FakeCtx) => void (await ctx.tool('done', { note: `${ctx.spec.agent} did its part.` }));
const staysAtWork = async (ctx: FakeCtx) => {
  while (!ctx.stopped()) {
    const m = await ctx.nextMessage(5000);
    if (m === null || m.includes('stop now')) return;
  }
};

/** Everything that has come into a script's running turn. */
const heard = async (ctx: FakeCtx) => {
  const all: string[] = [];
  for (let m = await ctx.nextMessage(200); m; m = await ctx.nextMessage(200)) all.push(m);
  return all.join('\n');
};

const deliveredTo = (d: Daemon, goal: string, name: string) => d.store.since(goal).filter(e => e.type === 'message.delivered' && e.agent === name);

test('messages to all or a role leave finished teammates asleep, and reach them when they next wake', async () => {
  const replies: Record<string, string> = {};
  const workerHeard: string[] = [];
  const woken: string[] = [];
  const fake = new FakeAdapter(
    {
      architect: async ctx => {
        const d = made;
        await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'a' });
        await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'b' });
        await ctx.tool('spawn', { role: 'reviewer', brief: 'b', name: 'w' });
        await until('both implementers finished', () => d.agent(goalId, 'a')?.state === 'done' && d.agent(goalId, 'b')?.state === 'done');
        replies.heard = await heard(ctx);
        replies.all = await ctx.tool('send', { to: 'all', text: 'UserDTO is now User.' });
        replies.role = await ctx.tool('send', { to: 'implementer', text: 'Are you there?' });
        await until('the worker heard', () => workerHeard.length > 0);
        assert.equal(deliveredTo(d, goalId, 'a').length, 0, 'a was not woken');
        assert.equal(deliveredTo(d, goalId, 'b').length, 0, 'b was not woken');
        replies.byName = await ctx.tool('send', { to: 'a', text: 'One more thing.' });
        await until('a woke with the note', () => woken.length > 0);
        await ctx.tool('send', { to: 'w', text: 'stop now' });
        await until('the worker stopped', () => d.agent(goalId, 'w')?.state === 'idle');
        await ctx.tool('done', { note: 'ok' });
      },
      implementer: finishes,
      reviewer: async ctx => {
        const m = await ctx.nextMessage(5000);
        workerHeard.push(m ?? '');
        await staysAtWork(ctx);
      },
    },
    {},
    { implementer: async (_ctx, text) => void woken.push(text) },
  );
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 8000, 'the lead finishes');

  assert.match(replies.heard, /a finished: a did its part\.\n\(If you won't need a again, dismiss it\.\)/, 'the spawner is told it can dismiss');
  assert.match(replies.all, /a, b have finished, so this didn't wake them/);
  assert.match(replies.all, /Sent to w\./);
  assert.match(workerHeard[0], /UserDTO is now User/);
  assert.match(replies.role, /Every implementer has finished: a, b\. To wake one, send to it by name\./);
  assert.match(replies.byName, /Sent to a\./);
  assert.match(woken[0], /One more thing/);
  assert.match(woken[0], /While you were finished, architect sent the team: UserDTO is now User\./);

  const held = made.store.since(goalId).find(e => e.type === 'message.held');
  assert.deepEqual(held?.data.held, ['a', 'b']);
  assert.equal(held?.data.why, 'finished');
  assert.equal(made.agent(goalId, 'b')!.ruleNotes.length, 1, "b keeps the note for whenever it wakes");
  await made.close();
});

test('a role with one finished agent still wakes it, and one with someone going reaches only them', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter(
    {
      architect: async ctx => {
        await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'solo' });
        await until('it finished', () => made.agent(goalId, 'solo')?.state === 'done');
        replies.push(await ctx.tool('send', { to: 'implementer', text: 'Follow-up.' }));
        await ctx.tool('spawn', { role: 'reviewer', brief: 'b', name: 'r1' });
        await ctx.tool('spawn', { role: 'reviewer', brief: 'b', name: 'r2' });
        await until('r1 finished', () => made.agent(goalId, 'r1')?.state === 'done');
        replies.push(await ctx.tool('send', { to: 'reviewer', text: 'stop now' }));
        await until('r2 stopped', () => made.agent(goalId, 'r2')?.state === 'idle');
        await ctx.tool('done', { note: 'ok' });
      },
      implementer: finishes,
      reviewer: async ctx => (ctx.spec.agent === 'r1' ? finishes(ctx) : staysAtWork(ctx)),
    },
  );
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 8000, 'the lead finishes');
  assert.match(replies[0], /Sent to solo\./);
  assert.match(replies[1], /r1 has finished, so this didn't wake it/);
  assert.match(replies[1], /Sent to r2\./);
  await made.close();
});

test('the human messaging everyone wakes nobody once all have finished', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'a' });
      await until('it finished', () => made.agent(goalId, 'a')?.state === 'done');
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: finishes,
  });
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 5000, 'the lead finishes');
  await until('the lead has settled', () => made.agent(goalId, 'architect')?.state === 'done');
  const reply = made.deliver(goalId, 'human', 'all', 'Anyone?', true);
  assert.doesNotMatch(reply, /Sent to/);
  assert.match(reply, /architect, a have finished/);
  await settle();
  assert.equal(deliveredTo(made, goalId, 'a').length, 0);
  assert.equal(deliveredTo(made, goalId, 'architect').length, 0);
  await made.close();
});

test('dismissing: spawner or lead only, finished only, takes what it spawned along, and tells nobody', async () => {
  const replies: Record<string, string> = {};
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'mid' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'b', name: 'other' });
      await until('mid and its helper finished', () => made.agent(goalId, 'mid')?.state === 'done' && made.agent(goalId, 'kid')?.state === 'done');
      await ctx.tool('wait', { timeout: 0 });
      replies.working = await ctx.tool('dismiss', { name: 'other' });
      replies.self = await ctx.tool('dismiss', { name: 'architect' });
      replies.unknown = await ctx.tool('dismiss', { name: 'nobody-here-at-all' });
      replies.dismissed = await ctx.tool('dismiss', { name: 'mid' });
      replies.again = await ctx.tool('dismiss', { name: 'mid' });
      replies.toGone = await ctx.tool('send', { to: 'mid', text: 'Still there?' });
      await ctx.tool('send', { to: 'other', text: 'try' });
      await until('other tried', () => 'other' in replies);
      replies.lead = await heard(ctx);
      await ctx.tool('send', { to: 'other', text: 'stop now' });
      await until('other finished', () => made.agent(goalId, 'other')?.state === 'done');
      await ctx.tool('wait', { timeout: 0 });
      replies.all = await ctx.tool('dismiss', { name: 'all' });
      replies.none = await ctx.tool('dismiss', { name: 'all' });
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: async ctx => {
      if (ctx.spec.agent === 'mid') {
        await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'kid' });
        await until('kid finished', () => made.agent(goalId, 'kid')?.state === 'done');
      }
      await finishes(ctx);
    },
    reviewer: async ctx => {
      await until('mid finished', () => made.agent(goalId, 'mid')?.state === 'done');
      replies.notYours = await ctx.tool('dismiss', { name: 'mid' });
      await ctx.nextMessage(5000);
      await ctx.tool('send', { to: 'kid', text: 'Where did you put it?' });
      replies.other = 'sent';
      await staysAtWork(ctx);
      await finishes(ctx);
    },
  });
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 12000, 'the lead finishes');

  assert.match(replies.working, /other: it hasn't finished \(working\)/);
  assert.match(replies.self, /that's you/);
  assert.match(replies.unknown, /there's nobody by that name/);
  assert.match(replies.notYours, /only architect \(who spawned it\) or the lead can dismiss it/);
  assert.match(replies.dismissed, /Dismissed mid, and kid, which it spawned\./);
  assert.match(replies.again, /mid: it has already ended/);

  for (const name of ['mid', 'kid']) {
    assert.equal(made.agent(goalId, name)!.state, 'ended');
    const ended = made.store.since(goalId).find(e => e.type === 'agent.ended' && e.agent === name);
    assert.match(String(ended?.data.reason), /dismissed by architect/);
  }

  // The spawner isn't sent back a message of its own, and hears nothing about the ending.
  assert.match(replies.toGone, /mid has ended, so it can't take messages/);
  assert.doesNotMatch(replies.toGone, /Sent to/);
  assert.doesNotMatch(replies.lead, /was stopped by/);
  // A message for someone whose spawner went too reaches the nearest one still going.
  assert.match(replies.lead, /from other: Where did you put it\?/);

  assert.match(replies.all, /Dismissed other\./);
  assert.match(replies.none, /Nobody to dismiss/);
  await made.close();
});

test('a teammate that stopped without calling done can be dismissed quietly', async () => {
  let heard = '';
  let reply = '';
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'a' });
      await until('it stopped', () => made.agent(goalId, 'a')?.state === 'idle');
      await ctx.tool('wait', { timeout: 0 });
      reply = await ctx.tool('dismiss', { name: 'a' });
      heard = await ctx.tool('wait', { timeout: 0 });
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: async ctx => ctx.say('All done, I think.'),
  });
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 5000, 'the lead finishes');
  assert.match(reply, /Dismissed a\./);
  assert.equal(heard, 'Nothing new.');
  assert.equal(made.agent(goalId, 'a')!.state, 'ended');
  await made.close();
});

test("the lead dismissing someone's helper leaves its spawner a note", async () => {
  let spawnerSaw = '';
  let done: () => void = () => {};
  const go = new Promise<void>(r => (done = r));
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'mid' });
      await until('kid finished', () => made.agent(goalId, 'kid')?.state === 'done');
      await ctx.tool('dismiss', { name: 'kid' });
      done();
      await ctx.tool('wait', { timeout: 5, on: 'mid' });
      await ctx.tool('done', { note: 'ok' });
    },
    implementer: async ctx => {
      if (ctx.spec.agent === 'kid') return finishes(ctx);
      await ctx.tool('spawn', { role: 'implementer', brief: 'b', name: 'kid' });
      await go;
      spawnerSaw = await ctx.tool('status', { text: 'carrying on' });
      await finishes(ctx);
    },
  });
  const made = makeTeam({ roles: ROLES, adapters: { fake } });
  const goalId = made.startGoal({ request: 'r' });
  await withTimeout(made.goals.get(goalId)!.leadDone, 5000, 'the lead finishes');
  assert.match(spawnerSaw, /architect dismissed kid, which you spawned\./);
  await made.close();
});
