import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter } from '../src/adapters/fake.ts';
import type { Daemon } from '../src/daemon.ts';
import { makeTeam, settle, withTimeout } from './helpers.ts';

const role = '---\nharness: fake\nmodel: m\ngood_at: testing\n---\nYou are a test role.\n';
const roles = { architect: role, implementer: role, reviewer: role, tester: role };

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

const loops = (d: Daemon, goal: string) => d.store.since(goal).filter(e => e.type === 'agent.wait_loop');

/** The architect starts these and sits in a wait, collecting what wakes it. */
const lead = (heard: string[], ...spawn: string[]) => async (ctx: { tool(n: string, a?: unknown): Promise<string> }) => {
  for (const r of spawn) await ctx.tool('spawn', { role: r, brief: `You are the ${r}.` });
  for (let i = 0; i < 4; i++) heard.push(await ctx.tool('wait', { timeout: 600 }));
};

test('the wait that closes a loop is refused with what the other waits for, and its message wakes it', async () => {
  const replies: string[] = [];
  const woke: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer'),
    implementer: async ctx => {
      woke.push(await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'your review of part A' }));
      while (!ctx.stopped()) await ctx.sleep(10);
    },
    reviewer: async ctx => {
      await ctx.sleep(30);
      const r = await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'part A to be ready' });
      replies.push(r);
      await ctx.tool('send', { to: 'implementer-1', text: 'I need part A before I can review it.' });
      await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'part A to be ready' });
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('refused', () => replies.length === 1);
  assert.match(replies[0], /You didn't start waiting: implementer-1 is already waiting on you/);
  assert.match(replies[0], /- implementer-1 is waiting on you for "your review of part A"\./);
  assert.match(replies[0], /send it exactly what \("part A to be ready"\)/);
  assert.match(replies[0], /ask architect/);
  assert.deepEqual(loops(d, goal).map(e => e.data), [{ loop: ['implementer-1'], refused: true }]);

  await until('the message wakes it', () => woke.length === 1);
  assert.match(woke[0], /from reviewer-1: I need part A/);
  await until('the reviewer waits now', () => d.agent(goal, 'reviewer-1')?.state === 'waiting');
  await d.close();
});

test('without on: a child and the lead waiting for its result are a loop too', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer'),
    implementer: async ctx => {
      await ctx.sleep(30);
      replies.push(await ctx.tool('wait', { timeout: 600 }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  d.startGoal({ request: 'r' });
  await until('refused', () => replies.length === 1);
  assert.match(replies[0], /architect is already waiting on you/);
  assert.match(replies[0], /for the result of the work it gave you/);
  await d.close();
});

test('round a longer loop, each one named in order', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer', 'tester'),
    implementer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'a review' })),
    reviewer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'tester-1', for: 'test results' })),
    tester: async ctx => {
      await ctx.sleep(40);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  d.startGoal({ request: 'r' });
  await until('refused', () => replies.length === 1);
  assert.match(replies[0], /you, implementer-1, reviewer-1 would each be waiting on the next/);
  assert.match(replies[0], /- implementer-1 is waiting on reviewer-1 for "a review"\.\n- reviewer-1 is waiting on you for "test results"\./);
  assert.match(replies[0], /If what reviewer-1 needs is yours to do/);
  assert.match(replies[0], /something from implementer-1 first/);
  await d.close();
});

test('someone who can still move means no loop: a teammate working, the human; and a check never blocks', async () => {
  const replies: Record<string, string[]> = { implementer: [], tester: [] };
  const hold = { released: false };
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer', 'tester'),
    implementer: async ctx => {
      await ctx.sleep(40);
      // The lead waits on it, but also on the reviewer, who's working.
      replies.implementer.push(await ctx.tool('wait', { timeout: 0.2, on: 'architect', for: 'the go-ahead' }));
      replies.implementer.push(await ctx.tool('wait', { timeout: 0 }));
      await ctx.tool('wait', { timeout: 600, on: 'human', for: 'a yes' });
    },
    reviewer: async ctx => {
      while (!hold.released) await ctx.sleep(10);
    },
    tester: async ctx => {
      await ctx.sleep(40);
      replies.tester.push(await ctx.tool('wait', { timeout: 0.2, on: 'human' }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('both returned', () => replies.implementer.length === 2 && replies.tester.length === 1);
  assert.match(replies.implementer[0], /Nothing new after 0\.2s/);
  assert.equal(replies.implementer[1], 'Nothing new.');
  assert.match(replies.tester[0], /Nothing new after/);
  assert.equal(loops(d, goal).length, 0);
  hold.released = true;
  await d.close();
});

test('a message that ends the other wait leaves no loop: back and forth with something to say is fine', async () => {
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer'),
    implementer: async ctx => {
      await ctx.sleep(40);
      await ctx.tool('send', { to: 'reviewer-1', text: 'Part A is ready.' });
      await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'your review' });
      await ctx.tool('done', { note: 'ok' });
    },
    reviewer: async ctx => {
      await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'part A' });
      await ctx.tool('send', { to: 'implementer-1', text: 'Looks good.' });
      await ctx.tool('done', { note: 'ok' });
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('both done', () => d.agent(goal, 'implementer-1')?.doneNote !== undefined && d.agent(goal, 'reviewer-1')?.doneNote !== undefined);
  assert.equal(loops(d, goal).length, 0);
  await d.close();
});

test('the loop closing again with no real work: the wait goes ahead and the lead hears, once', async () => {
  const heard: string[] = [];
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: lead(heard, 'implementer', 'reviewer'),
    implementer: async ctx => {
      await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'your review' });
    },
    reviewer: async ctx => {
      await ctx.sleep(30);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'part A' }));
      replies.push(await ctx.tool('wait', { timeout: 0.1, on: 'implementer-1', for: 'part A' }));
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'part A' }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('the lead hears', () => heard.some(h => h.includes('From MetaHarness')));
  const report = heard.find(h => h.includes('From MetaHarness'))!;
  assert.match(report, /reviewer-1, implementer-1 are waiting on each other in a loop/);
  assert.match(report, /- reviewer-1 is waiting on implementer-1 for "part A"\./);
  assert.match(report, /- implementer-1 is waiting on reviewer-1 for "your review"\./);
  assert.match(replies[0], /You didn't start waiting/);
  await until('the second wait timed out', () => replies.length === 2);
  assert.match(replies[1], /Nothing new after/);
  await until('and the third waits', () => d.agent(goal, 'reviewer-1')?.state === 'waiting');
  assert.deepEqual(loops(d, goal).map(e => e.data.refused), [true, false]);
  await settle();
  assert.equal(heard.filter(h => h.includes('From MetaHarness')).length, 1, 'once');
  assert.equal(d.humanInbox.filter(i => i.kind === 'stalled').length, 0);
  await d.close();
});

test('real work in between starts over: it is refused again, not reported', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer'),
    implementer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'your review' })),
    reviewer: async ctx => {
      await ctx.sleep(30);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1' }));
      await ctx.sleep(5);
      await ctx.run('true', 1);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1' }));
      while (!ctx.stopped()) await ctx.sleep(10);
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('both refused', () => replies.length === 2);
  assert.match(replies[1], /You didn't start waiting/);
  assert.deepEqual(loops(d, goal).map(e => e.data.refused), [true, true]);
  await d.close();
});

test('the lead closing the loop again wakes nobody at once; the human hears through the stall report', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build it.' });
      await ctx.sleep(30);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' }));
      for (let i = 0; i < 3; i++) replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' }));
    },
    implementer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'architect', for: 'the spec' })),
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('refused, then waiting', () => replies.length === 1 && d.agent(goal, 'architect')?.state === 'waiting');
  assert.match(replies[0], /implementer-1 is already waiting on you/);
  assert.doesNotMatch(replies[0], /ask architect/);
  await settle();
  assert.deepEqual(loops(d, goal).map(e => e.data.refused), [true]);
  assert.equal(d.humanInbox.length, 0);

  const t = Date.now() + 11 * 60_000;
  d.checkStalls(t);
  await until('the lead hears of the stall', () => replies.length === 2);
  await until('and waits again', () => d.agent(goal, 'architect')?.state === 'waiting');
  d.checkStalls(t + 11 * 60_000);
  const item = d.humanInbox.find(i => i.kind === 'stalled');
  assert.ok(item, 'the human is told');
  assert.equal(item.agent, 'architect');
  await d.close();
});

test('a teammate closing a loop with the lead again: the lead, part of it, is woken and told', async () => {
  const heard: string[] = [];
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'Build it.' });
      heard.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' }));
    },
    implementer: async ctx => {
      await ctx.sleep(30);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'architect', for: 'the spec' }));
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'architect', for: 'the spec' }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('the lead is woken', () => heard.length === 1);
  assert.match(replies[0], /architect is already waiting on you/);
  assert.match(heard[0], /implementer-1, architect are waiting on each other in a loop/);
  assert.match(heard[0], /- architect is waiting on implementer-1 for "the build"\./);
  assert.deepEqual(loops(d, goal).map(e => e.data.refused), [true, false]);
  assert.equal(d.humanInbox.length, 0);
  await d.close();
});

test('waiting for something of its own, said with for and no on, is never a loop, and draws no arrow', async () => {
  const polls: string[] = [];
  const first: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer'),
    implementer: async ctx => {
      await ctx.sleep(20);
      await ctx.tool('send', { to: 'reviewer-1', text: 'Starting the build, will tell you when it is ready.' });
      await ctx.run('build-in-background &', 1);
      await ctx.sleep(30);
      polls.push(await ctx.tool('wait', { timeout: 0.1, for: 'my build' }));
      polls.push(await ctx.tool('wait', { timeout: 0.3, for: 'my build' }));
      while (!ctx.stopped()) await ctx.sleep(10);
    },
    reviewer: async ctx => {
      first.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' }));
      // While the implementer is on its own timer, this is no loop either.
      await ctx.sleep(120);
      first.push(await ctx.tool('wait', { timeout: 0.1, on: 'implementer-1', for: 'the build' }));
      while (!ctx.stopped()) await ctx.sleep(10);
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('on its second timer', () => polls.length === 1 && d.agent(goal, 'implementer-1')?.state === 'waiting');
  assert.equal(d.snapshot(goal).goals[0].agents.find(a => a.name === 'implementer-1')!.waitingOn, null);
  await until('all returned', () => polls.length === 2 && first.length === 2);
  assert.match(polls[0], /Nothing new after/);
  assert.match(polls[1], /Nothing new after/);
  assert.match(first[1], /Nothing new after/);
  assert.equal(loops(d, goal).length, 0);
  await d.close();
});

test('a plain wait that closes a loop: refused once with the way out, then it goes ahead and wakes nobody', async () => {
  const heard: string[] = [];
  const polls: string[] = [];
  const fake = new FakeAdapter({
    architect: lead(heard, 'implementer', 'reviewer'),
    implementer: async ctx => {
      await ctx.sleep(20);
      await ctx.tool('send', { to: 'reviewer-1', text: 'Starting the build, will tell you when it is ready.' });
      await ctx.sleep(30);
      polls.push(await ctx.tool('wait', { timeout: 0.1 }));
      polls.push(await ctx.tool('wait', { timeout: 0.1 }));
      while (!ctx.stopped()) await ctx.sleep(10);
    },
    reviewer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'implementer-1', for: 'the build' })),
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('both polls', () => polls.length === 2);
  assert.match(polls[0], /You didn't start waiting: reviewer-1 is already waiting on you/);
  assert.match(polls[0], /something of your own, like a build, say what with for and no on/);
  assert.match(polls[1], /Nothing new after/);
  await settle();
  assert.deepEqual(loops(d, goal).map(e => e.data.refused), [true]);
  assert.equal(heard.filter(h => h.includes('From MetaHarness')).length, 0, 'the lead is left alone');
  await d.close();
});

test('an agent that stopped expecting something from you is part of a loop; naming someone unknown says who there is', async () => {
  const replies: string[] = [];
  const fake = new FakeAdapter({
    architect: lead([], 'implementer', 'reviewer'),
    implementer: async ctx => {
      await ctx.tool('send', { to: 'reviewer-1', text: 'Tell me when you have looked at it.' });
    },
    reviewer: async ctx => {
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'nobody-here' }));
      await ctx.tool('wait', { timeout: 0 });
      await ctx.sleep(40);
      replies.push(await ctx.tool('wait', { timeout: 600, on: 'implementer-1' }));
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  d.startGoal({ request: 'r' });
  await until('both replies', () => replies.length === 2);
  assert.match(replies[0], /Not waiting yet\. There's nobody called "nobody-here"\. Teammates: .*implementer-1/);
  assert.match(replies[1], /- implementer-1 has stopped until a message reaches it, expecting something from you; last it said: "Tell me when you have looked at it\."/);
  await d.close();
});

test('stallMinutes 0 turns it off', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b' });
      await ctx.tool('wait', { timeout: 600, on: 'implementer-1' });
    },
    implementer: async ctx => {
      await ctx.sleep(30);
      await ctx.tool('wait', { timeout: 600, on: 'architect' });
    },
  });
  const d = makeTeam({ roles, adapters: { fake }, settings: { approvals: 'ask', stallMinutes: 0 } });
  const goal = d.startGoal({ request: 'r' });
  await until('both wait', () => d.agent(goal, 'architect')?.state === 'waiting' && d.agent(goal, 'implementer-1')?.state === 'waiting');
  assert.equal(loops(d, goal).length, 0);
  await d.close();
});

test('the graph shows who an agent named', async () => {
  const fake = new FakeAdapter({
    architect: async ctx => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'b' });
      await ctx.tool('spawn', { role: 'reviewer', brief: 'b' });
      await ctx.tool('wait', { timeout: 600 });
    },
    implementer: async ctx => void (await ctx.tool('wait', { timeout: 600, on: 'reviewer-1', for: 'a review' })),
    reviewer: async ctx => {
      while (!ctx.stopped()) await ctx.sleep(10);
    },
  });
  const d = makeTeam({ roles, adapters: { fake } });
  const goal = d.startGoal({ request: 'r' });
  await until('it waits', () => d.agent(goal, 'implementer-1')?.state === 'waiting');
  assert.deepEqual(d.snapshot(goal).goals[0].agents.find(a => a.name === 'implementer-1')!.waitingOn, { who: ['reviewer-1'], why: 'partner' });
  await d.close();
});
