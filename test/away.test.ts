import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeAdapter, type FakeCtx } from '../src/adapters/fake.ts';
import { onAway, parseRule, rulesPrompt } from '../src/rules.ts';
import { makeTeam, withTimeout } from './helpers.ts';

const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;

const until = (ok: () => boolean, what: string) =>
  withTimeout(
    new Promise<void>(r => {
      const t = setInterval(() => ok() && (clearInterval(t), r()), 5);
    }),
    2000,
    what,
  );

/**
 * A team whose lead answers teammates' requests as `answer` says (or not at all), and records
 * what reaches it; a worker that stays at work; a gatekeeper that asks about writing to /etc
 * and allows the rest.
 */
function team(o: { approvals: 'allow' | 'ask' | 'gatekeeper'; answer?: 'yes' | 'no'; stallMinutes?: number }) {
  const leadSaw: string[] = [];
  const judged: string[] = [];
  const lead = async (ctx: FakeCtx) => {
    while (!ctx.stopped()) {
      const m = await ctx.nextMessage(50);
      if (m === null) continue;
      leadSaw.push(m);
      const who = /(\S+) asks to run/.exec(m);
      if (who && o.answer) await ctx.tool('send', { to: who[1], allow: o.answer, text: o.answer === 'yes' ? 'the goal needs it' : 'not part of the goal' });
    }
  };
  const gk = async (ctx: FakeCtx, text: string) => {
    judged.push(text);
    ctx.say(/\/etc\//.test(text) ? 'ASK writes to /etc' : 'ALLOW fine');
  };
  const fake = new FakeAdapter(
    { architect: lead, worker: async ctx => {
      while (!ctx.stopped()) await ctx.sleep(20);
    }, gatekeeper: ctx => gk(ctx, ctx.spec.brief) },
    {},
    { gatekeeper: gk },
  );
  const d = makeTeam({
    roles: { architect: role(), worker: role(), gatekeeper: role('helper: true\n') },
    adapters: { fake },
    settings: { approvals: o.approvals, ...(o.stallMinutes ? { stallMinutes: o.stallMinutes } : {}) },
  });
  const goal = d.startGoal({ request: 'r' });
  const s = d.spawnAgent(goal, { role: 'worker', brief: 'b', parent: 'architect' });
  assert.ok(s.ok);
  return { d, goal, lead: d.agent(goal, 'architect')!, worker: s.rec, leadSaw, judged };
}

test('allow: what stays in the project runs without asking; what reaches outside goes to the gatekeeper, then the lead', async () => {
  const { d, goal, lead, worker, leadSaw, judged } = team({ approvals: 'allow', answer: 'yes' });
  // Writing, deleting and running in the project: no gatekeeper, no human.
  for (const cmd of ['echo x > notes.txt', 'rm -rf build && npm run build', "python3 - <<'PY'\nprint(1)\nPY"]) {
    assert.deepEqual(await d.requestApproval(worker, 'Bash', cmd), { allow: true }, cmd);
  }
  assert.equal(judged.length, 0);
  assert.deepEqual(d.store.since(goal).filter(e => e.type === 'approval.auto').map(e => e.data.why), ['allow', 'allow', 'allow']);

  // Outside, the gatekeeper settles what it can.
  assert.deepEqual(await withTimeout(d.requestApproval(worker, 'Bash', 'cp notes.txt ~/backup/'), 2000, 'the gatekeeper'), { allow: true });
  assert.match(judged[0], /reaches outside the project/);

  // What it asks about goes to the lead, which answers with send (allow).
  assert.deepEqual(await withTimeout(d.requestApproval(worker, 'Bash', 'echo x > /etc/motd'), 2000, "the lead's answer"), { allow: true });
  assert.match(leadSaw.find(m => /asks to run/.test(m))!, /worker-1 asks to run Bash:\necho x > \/etc\/motd\nGatekeeper: writes to \/etc/);
  assert.equal(d.humanInbox.length, 0, 'nothing reached the human');
  const answered = d.store.since(goal).find(e => e.type === 'approval.lead_answered')!;
  assert.deepEqual(answered.data, { id: answered.data.id, to: 'worker-1', allow: true, text: 'the goal needs it' });

  // The lead's own requests have no second eye: the human decides.
  void d.requestApproval(lead, 'Bash', 'echo x > /etc/motd');
  await until(() => d.humanInbox.some(i => i.kind === 'approval'), 'the Inbox item');
  // And a teammate's send with allow, when nothing waits, says so.
  assert.match(await d.hub.call(goal, 'worker-1', 'send', { to: 'architect', allow: 'yes' }), /isn't waiting on an approval/);
  await d.close();
});

test("the lead's refusal reaches the agent; a lead that doesn't answer hands the request to the human", async () => {
  const refusing = team({ approvals: 'allow', answer: 'no' });
  const r = await withTimeout(refusing.d.requestApproval(refusing.worker, 'Bash', 'echo x > /etc/motd'), 2000, 'the refusal');
  assert.deepEqual(r, { allow: false, message: 'architect (your lead) refused this: not part of the goal' });
  await refusing.d.close();

  const { d, goal, worker } = team({ approvals: 'allow', stallMinutes: 0.002 });
  const asked = d.requestApproval(worker, 'Bash', 'echo x > /etc/motd');
  await until(() => d.humanInbox.some(i => i.kind === 'approval'), 'the Inbox item');
  const item = d.humanInbox.find(i => i.kind === 'approval')!;
  assert.match(item.note!, /architect \(the lead\) didn't answer within/);
  assert.equal(d.store.since(goal).filter(e => e.type === 'approval.lead_silent').length, 1);
  d.resolveInbox(item.id, 'approve');
  assert.equal((await asked).allow, true);
  await d.close();
});

test('away: nothing waits on the human; the lead is the second eye and hears the away rules', async () => {
  const { d, goal, lead, worker, leadSaw, judged } = team({ approvals: 'ask', answer: 'yes' });
  // An approval already waiting when the human leaves is refused, so the agent can ask again.
  const before = d.requestApproval(worker, 'Bash', 'make deploy');
  await until(() => d.humanInbox.some(i => i.kind === 'approval'), 'the Inbox item');
  assert.equal(await d.hub.call(goal, 'architect', 'send', { to: 'human', text: 'Which colour?' }), 'Sent to the human. Their answer will arrive as a message.');

  assert.match(d.setAway(true), /You're away/);
  const r = await before;
  assert.equal(r.allow, false);
  assert.match(r.message!, /went away before answering/);
  assert.ok(d.snapshot().away);
  await until(() => leadSaw.some(m => /rule away\] The human is away now/.test(m)), 'the away rule');
  assert.match(leadSaw.find(m => /rule away/.test(m))!, /don't wait for the answer: "Which colour\?"/);
  assert.ok(d.store.since(goal).some(e => e.type === 'human.away'));

  // Even with approvals: ask, the gatekeeper judges while the human is away; the lead decides what it asks about.
  assert.deepEqual(await withTimeout(d.requestApproval(worker, 'Bash', 'make all'), 2000, 'the gatekeeper'), { allow: true });
  assert.deepEqual(await withTimeout(d.requestApproval(worker, 'Bash', 'echo x > /etc/motd'), 2000, 'the lead'), { allow: true });
  assert.equal(judged.length, 2);
  // The lead's own: nobody can approve it.
  const own = await withTimeout(d.requestApproval(lead, 'Bash', 'echo x > /etc/motd'), 2000, 'the refusal');
  assert.equal(own.allow, false);
  assert.match(own.message!, /The human is away, and nobody else can approve this/);

  // A teammate's message to the human isn't sent: it's told to ask the lead.
  assert.match(await d.hub.call(goal, 'worker-1', 'send', { to: 'human', text: 'Sync or async?' }), /The human is away, so this wasn't sent\. Ask architect \(your lead\) instead/);
  assert.equal(d.humanInbox.filter(i => i.agent === 'worker-1' && i.kind === 'question').length, 0);
  assert.ok(d.store.since(goal).some(e => e.type === 'message.held' && e.data.lead === 'architect'));

  // The lead's questions still reach the Inbox, but it's told not to wait.
  assert.match(await d.hub.call(goal, 'architect', 'send', { to: 'human', text: 'Approve the design?', decision: true }), /The human is away: this waits in their Inbox/);
  assert.equal(d.humanInbox.filter(i => i.kind === 'decision').length, 1);
  assert.equal(d.humanInbox.filter(i => i.kind === 'approval').length, 0);

  assert.match(d.setAway(false), /Welcome back/);
  assert.equal(d.snapshot().away, false);
  await until(() => leadSaw.some(m => /The human is back/.test(m)), 'the welcome back');
  await d.close();
});

test('away rules fire when the human goes away, and are in the prompt of agents that start while they are', () => {
  const r = parseRule('away', '---\nwhen: away\nroles: lead\n---\nDecide yourself.', 'away.md');
  const lead = { role: 'architect', helper: false, lead: true };
  assert.match(rulesPrompt([r], lead, '/tmp'), /- away, when the human goes away: Decide yourself\./);
  assert.match(rulesPrompt([r], lead, '/tmp', true), /### away \(the human is away now\)\n\nDecide yourself\./);
  assert.match(onAway([r], lead, '/tmp')!.text, /\[MetaHarness · rule away\] The human is away now\.\nDecide yourself\./);
  assert.equal(onAway([r], { ...lead, lead: false }, '/tmp'), undefined, 'only for the lead');
});
