import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { endTagged, endTree, spawnTree, tagged } from '../src/procs.ts';
import { FakeAdapter, type FakeTurnScript } from '../src/adapters/fake.ts';
import { makeTeam, settle } from './helpers.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts bash with a script that prints the PIDs it leaves behind, one per line, and returns them once `n` are printed. */
async function start(script: string, n: number) {
  const proc = spawnTree('bash', ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.setEncoding('utf8');
  await new Promise<void>(res => proc.stdout.on('data', (c: string) => ((out += c), out.trim().split('\n').length >= n && res())));
  return { proc, pids: out.trim().split('\n').map(Number) };
}

async function gone(pids: number[], ms = 4000) {
  const end = Date.now() + ms;
  while (pids.some(alive) && Date.now() < end) await settle();
  return pids.filter(alive);
}

test('ending a harness process ends what it started, in its group or not', { skip: process.platform === 'win32' }, async () => {
  // A background job stays in the group; setsid leaves it. cat waits for stdin, like a CLI.
  const { proc, pids } = await start('sleep 300 & echo $!; setsid sleep 301 & echo $!; cat', 2);
  assert.ok(pids.every(alive));
  endTree(proc, 200);
  assert.deepEqual(await gone([proc.pid!, ...pids]), [], 'nothing is left running');
});

test('a harness that exits by itself takes its leftover children with it', { skip: process.platform === 'win32' }, async () => {
  const { pids } = await start('sleep 300 & echo $!; sleep 0.2; exit 0', 1);
  assert.deepEqual(await gone(pids), []);
});

test('finished agents let their process go after a quiet spell, and resume when messaged', async () => {
  const echo: FakeTurnScript = async (ctx, text) => ctx.say(`Got: ${text}`);
  const adapter = new FakeAdapter({ architect: async ctx => void (await ctx.tool('done', { note: 'built it' })) }, {}, { architect: echo });
  const d = makeTeam({ roles: { architect: '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n' }, adapters: { fake: adapter }, releaseMs: 60_000 });
  const goal = d.startGoal({ request: 'r' });
  const rec = () => d.agent(goal, 'architect')!;
  const end = Date.now() + 3000;
  while (rec().state !== 'done' && Date.now() < end) await settle();
  assert.equal(rec().state, 'done');

  d.releaseIdle(Date.now() + 30_000);
  assert.ok(rec().session, 'kept while it was only quiet for a while');
  d.releaseIdle(Date.now() + 61_000);
  assert.equal(rec().session, undefined, 'let go');
  const native = d.store.since(goal).find(e => e.type === 'agent.session')!.data.nativeSession;
  assert.equal(rec().resumeId, native);
  assert.ok(d.store.since(goal).some(e => e.type === 'agent.released'));

  d.deliver(goal, 'human', 'architect', 'One more thing.');
  const back = Date.now() + 3000;
  while (!d.store.since(goal).some(e => e.type === 'agent.text' && /Got: .*One more thing/s.test(String(e.data.text))) && Date.now() < back) await settle();
  assert.equal(adapter.started.at(-1)!.resume, native, 'the same session picked up the message');
  assert.ok(d.store.since(goal).some(e => e.type === 'agent.text' && /One more thing/.test(String(e.data.text))));
  await d.close();
});

/** A process that left its parent's group and tree, as a dev server started with setsid from a subshell does, tagged as an agent's. */
async function ghost(goal: string, agent: string): Promise<number> {
  const sh = spawn('bash', ['-c', '(setsid sleep 302 >/dev/null 2>&1 & echo $!)'], { env: { ...process.env, MH_GOAL: goal, MH_AGENT: agent }, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  sh.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
  await new Promise(res => sh.once('exit', res));
  return Number(out.trim());
}

const tagSupported = process.platform === 'linux' || process.platform === 'darwin';

test('a process that left the tree is still found by its tag, and ended', { skip: !tagSupported }, async () => {
  const goal = `g-${process.pid}-${Date.now()}`;
  const pid = await ghost(goal, 'implementer');
  assert.ok(alive(pid));
  const found = tagged(new Set([goal]));
  assert.deepEqual(found.map(p => [p.pid, p.agent]), [[pid, 'implementer']]);
  assert.match(found[0].command, /sleep 302/);
  assert.deepEqual(tagged(new Set(['some-other-goal'])).filter(p => p.pid === pid), []);
  endTagged(found);
  assert.deepEqual(await gone([pid]), []);
});

test("what an agent's commands left running ends once its session does, and the log says so", { skip: !tagSupported }, async () => {
  const adapter = new FakeAdapter({ architect: async ctx => void (await ctx.tool('done', { note: 'built it' })) });
  const d = makeTeam({ roles: { architect: '---\nharness: fake\nmodel: m\ngood_at: x\n---\nx\n' }, adapters: { fake: adapter }, straysMs: 50 });
  const goal = d.startGoal({ request: 'r' });
  const end = Date.now() + 3000;
  while (d.agent(goal, 'architect')?.state !== 'done' && Date.now() < end) await settle();
  assert.equal(adapter.started[0].spec.env?.MH_GOAL, goal, 'its harness gets the tag to pass on');
  assert.equal(adapter.started[0].spec.env?.MH_AGENT, 'architect');

  const server = await ghost(goal, 'architect');
  const other = await ghost(goal, 'reviewer');
  const listed = d.listProcs().procs;
  assert.deepEqual(listed.map(p => [p.pid, p.stray]).sort(), [[server, false], [other, true]].sort(), "the architect's session is still there; nobody's is the reviewer's");
  d.endGoal(goal);
  assert.deepEqual(await gone([server]), [], "the architect's is ended");
  assert.ok(alive(other), "another agent's is left alone");
  const ev = d.store.since(goal).find(e => e.type === 'procs.ended')!;
  assert.equal(ev.agent, 'architect');
  assert.deepEqual((ev.data.procs as { pid: number }[]).map(p => p.pid), [server]);

  // As if a killed daemon had left it: the next one ends whatever its log's goals still have running.
  assert.equal(d.endLeftovers(), 1);
  assert.deepEqual(await gone([other]), []);
  assert.ok(d.store.since(goal).some(e => e.type === 'procs.ended' && e.data.reason === 'left by the last daemon'));
  await d.close();
});
