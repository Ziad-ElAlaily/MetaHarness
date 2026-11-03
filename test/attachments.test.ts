import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { FakeCtx } from '../src/adapters/fake.ts';
import { startServer } from '../src/server.ts';
import { MAX_UPLOAD_BYTES, saveUpload, uploadName } from '../src/shared.ts';
import { makeDaemon, settle, withTimeout } from './helpers.ts';

const until = (what: string, ok: () => boolean) =>
  withTimeout(
    (async () => {
      while (!ok()) await settle();
    })(),
    5000,
    what,
  );

/** A lead that keeps what reaches it, with a teammate alongside, both waiting for more. */
function team() {
  const heard: Record<string, string[]> = { lead: [], mate: [] };
  const listen = (who: string) => async (ctx: FakeCtx) => {
    while (!ctx.stopped()) {
      const m = await ctx.nextMessage(50);
      if (m) heard[who].push(m);
    }
  };
  const scripts = {
    architect: async (ctx: FakeCtx) => {
      await ctx.tool('spawn', { role: 'implementer', brief: 'stay', name: 'mate' });
      await listen('lead')(ctx);
    },
    implementer: listen('mate'),
  };
  return { heard, d: makeDaemon(scripts) };
}

async function serve(d: ReturnType<typeof makeDaemon>) {
  const server = await startServer(d, 0, 'secret');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const upload = (goal: string, name: string, body: BodyInit) => fetch(`${base}/upload?goal=${encodeURIComponent(goal)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body });
  return { server, base, upload };
}

test('a file name is safe on disk and in the line an agent reads', () => {
  assert.equal(uploadName('shot.png'), 'shot.png');
  assert.equal(uploadName('../../etc/passwd'), 'passwd');
  assert.equal(uploadName('..\\..\\evil.exe'), 'evil.exe');
  assert.equal(uploadName('.env'), 'env');
  assert.equal(uploadName('my photo (1).jpg'), 'my-photo-1-.jpg');
  assert.equal(uploadName('صورة.png'), 'صورة.png');
  assert.equal(uploadName('...'), 'file');
  const long = uploadName(`${'x'.repeat(300)}.png`);
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('.png'));
});

test('an attached file lands whole in the shared folder, never over another, and only those it was sent to hear of it', async () => {
  const { d, heard } = team();
  const { server, base, upload } = await serve(d);
  try {
    const goal = d.startGoal({ request: 'Look at this' });
    await until('the teammate started', () => d.agent(goal, 'mate')?.state === 'working');
    const sharedDir = d.goals.get(goal)!.sharedDir;

    assert.equal((await fetch(`${base}/upload?goal=${goal}&name=a.png`, { method: 'POST', body: 'x' })).status, 401);

    const first = await (await upload(goal, '../a shot.png', 'one')).json();
    assert.equal(first.path, 'uploads/a-shot.png');
    assert.equal(first.abs, join(sharedDir, 'uploads', 'a-shot.png'));
    assert.equal(first.size, 3);
    const second = await (await upload(goal, 'a shot.png', 'two')).json();
    assert.equal(second.path, 'uploads/a-shot-2.png');
    assert.equal(readFileSync(first.abs, 'utf8'), 'one');
    assert.equal(readFileSync(second.abs, 'utf8'), 'two');
    // No half-written file left beside the folder.
    assert.deepEqual(readdirSync(dirname(sharedDir)).filter(f => f.startsWith('.upload-')), []);

    // Logged at once, so the Files view has it; nobody's told but whoever the message goes to.
    assert.ok(d.store.since(goal).some(e => e.type === 'shared.write' && e.data.path === 'uploads/a-shot.png' && e.agent === 'human'));
    const mate = d.agent(goal, 'mate')!;
    assert.equal(mate.fileNotes.size, 0);

    const line = `[Attached image: ${first.abs} (3 B)]`;
    d.deliver(goal, 'human', d.goals.get(goal)!.lead, `what's wrong here?\n\n${line}`, false);
    await until('the lead heard it', () => heard.lead.some(t => t.includes(first.abs)));
    assert.ok(!heard.mate.some(t => t.includes('a-shot')), 'the teammate is not told');

    // The app shows it from the same place as a room's images.
    const media = await fetch(`${base}/media?goal=${goal}&path=uploads/a-shot.png&token=secret`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(await media.text(), 'one');
  } finally {
    server.close();
    await d.close();
  }
});

test('uploads refused: too big, or no such goal', async () => {
  const { d } = team();
  const { server, base, upload } = await serve(d);
  try {
    const goal = d.startGoal({ request: 'Look at this' });
    // Said before a byte of it comes, from the length it announces.
    const big = await new Promise<number>((resolve, reject) => {
      const r = request(`${base}/upload?goal=${goal}&name=big.bin`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-length': MAX_UPLOAD_BYTES + 1 } }, res => {
        resolve(res.statusCode!);
        r.destroy();
      });
      r.on('error', reject);
      r.flushHeaders();
    });
    assert.equal(big, 413);
    const none = await upload('deadbeef', 'a.png', 'x');
    assert.equal(none.status, 400);
    assert.match((await none.json()).error, /no goal/);
    const missing = await fetch(`${base}/upload?goal=${goal}`, { method: 'POST', headers: { authorization: 'Bearer secret' }, body: 'x' });
    assert.equal(missing.status, 400);
  } finally {
    server.close();
    await d.close();
  }
});

test("a body past the limit is refused while it's coming, and leaves nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), 'mh-up-'));
  const shared = join(home, 'shared');
  mkdirSync(shared);
  const chunk = Buffer.alloc(32 * 1024 * 1024);
  const body = Readable.from((function* () {
    for (let i = 0; i < 4; i++) yield chunk;
  })());
  await assert.rejects(saveUpload(shared, 'uploads', 'big.bin', body), /too big/);
  assert.deepEqual(readdirSync(home).filter(f => f.startsWith('.upload-')), []);
  assert.equal(existsSync(join(shared, 'uploads', 'big.bin')), false);
});

test("a room's files go where a goal started from it carries them, and the assistant has its own place", async () => {
  const { d } = team();
  const { server, base, upload } = await serve(d);
  try {
    const room = d.startRoom({ topic: 'The look' });
    const up = await (await upload(room, 'ref.png', 'r')).json();
    assert.equal(up.path, 'room/uploads/ref.png');
    assert.equal((await fetch(`${base}/media?goal=${room}&path=room/uploads/ref.png&token=secret`)).status, 200);

    const asked = await (await upload('assistant', 'q.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')).json();
    assert.equal(asked.path, 'uploads/q.svg');
    const svg = await fetch(`${base}/media?goal=assistant&path=uploads/q.svg&token=secret`);
    assert.equal(svg.status, 200);
    // Opened in a tab, it can't reach the app or its token.
    assert.match(svg.headers.get('content-security-policy') ?? '', /sandbox/);
  } finally {
    server.close();
    await d.close();
  }
});

test('a goal starts with files: they land in its shared folder, in the lead\'s brief, and not in its title', async () => {
  const { d } = team();
  const { server, upload } = await serve(d);
  const draft = `draft-${'a'.repeat(24)}`;
  try {
    const saved = await (await upload(draft, 'bug shot.png', 'pixels')).json();
    const line = `[Attached image: ${saved.abs} (6 B)]`;
    // A start that fails leaves the draft to try again from.
    await assert.rejects(d.command({ cmd: 'goal.start', request: 'Fix this', lead: 'nobody', attach: { draft, lines: [line] } }), /nobody/);
    assert.ok(existsSync(saved.abs));

    const { goal } = (await d.command({ cmd: 'goal.start', request: 'Fix this', attach: { draft, lines: [line] } })) as { goal: string };
    const g = d.goals.get(goal)!;
    const final = join(g.sharedDir, 'uploads', 'bug-shot.png');
    assert.equal(readFileSync(final, 'utf8'), 'pixels');
    assert.equal(g.request, 'Fix this');
    assert.equal(d.agent(goal, g.lead)!.brief, `Fix this\n\n[Attached image: ${final} (6 B)]`);
    const started = d.store.since(goal).find(e => e.type === 'goal.started')!;
    assert.equal(started.data.request, 'Fix this');
    assert.deepEqual(started.data.attachments, [`[Attached image: ${final} (6 B)]`]);
    assert.ok(d.store.since(goal).some(e => e.type === 'shared.write' && e.data.path === 'uploads/bug-shot.png' && e.agent === 'human'));
    assert.equal(existsSync(saved.abs), false, 'the draft is gone once the goal has started');
    await assert.rejects(d.command({ cmd: 'goal.start', request: 'Again', attach: { draft, lines: [line] } }), /gone/);
  } finally {
    server.close();
    await d.close();
  }
});

test('a room opens with files, where a goal started from it carries them', async () => {
  const { d } = team();
  const { server, upload } = await serve(d);
  const draft = `draft-${'b'.repeat(24)}`;
  try {
    const saved = await (await upload(draft, 'ref.png', 'r')).json();
    const room = d.startRoom({ topic: 'The look', attach: { draft, lines: [`[Attached image: ${saved.abs} (1 B)]`] } });
    const g = d.goals.get(room)!;
    const final = join(g.sharedDir, 'room', 'uploads', 'ref.png');
    assert.equal(readFileSync(final, 'utf8'), 'r');
    assert.equal(g.request, 'The look');
    assert.ok(d.agent(room, g.lead)!.brief.includes(`[Attached image: ${final} (1 B)]`));
    assert.ok(d.store.since(room).find(e => e.type === 'goal.started')!.data.attachments);
  } finally {
    server.close();
    await d.close();
  }
});

test("a draft's name can't reach outside its folder", async () => {
  const { d } = team();
  const { server, upload } = await serve(d);
  try {
    for (const bad of ['draft-../../evil', 'draft-', 'draft-zzzzzzzzzzzzzzzzzzzz']) {
      const r = await upload(bad, 'a.png', 'x');
      assert.equal(r.status, 400, bad);
      assert.match((await r.json()).error, /isn't a draft/);
    }
    await assert.rejects(d.command({ cmd: 'goal.start', request: 'x', attach: { draft: '../../etc', lines: ['l'] } }), /isn't a draft/);
    assert.equal(d.goals.size, 0);
  } finally {
    server.close();
    await d.close();
  }
});
