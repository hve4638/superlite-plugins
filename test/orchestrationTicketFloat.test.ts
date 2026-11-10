// orchestration 의 ticket 알약 (ticketFloat.js) — `node --test test/orchestrationTicketFloat.test.ts`.
// ticket 동사를 가짜 api 로 부르고, 창(renderer 의 expose 'floats')에 간 호출을 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../orchestration/tickets.js';
import { assigned, withTicketFloat } from '../orchestration/ticketFloat.js';
import { handleTicketVerbs } from '../orchestration/ticketVerbs.js';
import { parseArgs } from './pluginhost-args.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync('/tmp/orch-float-'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const manifest = JSON.parse(fs.readFileSync(new URL('../orchestration/plugin.json', import.meta.url), 'utf8'));

type Call = [string, string, ...unknown[]];

/** 브랜치 feat/w 의 저장소, 가짜 창 하나 — calls 는 창이 받은 (iface, method, ...args) */
function harness({ windowFails = false } = {}) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'feat/w');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(`${repo}/.ticket`, '.superlite/tickets.db\n');
  const handlers = new Map<string, (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const calls: Call[] = [];
  const mains: unknown[] = [];
  const win = {
    id: 'w1',
    call: async (iface: string, method: string, ...args: unknown[]) => {
      if (windowFails) throw new Error('window closed');
      calls.push([iface, method, ...args]);
    },
  };
  const api = {
    verbs: { handle: (name: string, fn: (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => handlers.set(name, fn), run: async () => {} },
    window: {
      main: async (unit: unknown) => {
        mains.push(unit);
        return win;
      },
      all: async (iface: string) => (iface === 'orchestration/floats' ? [win] : []),
    },
    notify: () => {},
    folder: { read: async (rel: string) => fs.readFileSync(new URL(`../orchestration/${rel}`, import.meta.url), 'utf8') },
  };
  handleTicketVerbs(withTicketFloat(api) as never);
  const sl = async (ctx: { cwd: string; tmux: string | null; env?: Record<string, string> }, ...argv: string[]) => {
    const def = manifest.verbs.find((v: { name: string }) => v.name === `ticket.${argv[0]}`);
    return String(await handlers.get(def.name)!(parseArgs(def, argv.slice(1)), { env: {}, ...ctx }));
  };
  const db = path.join(repo, '.superlite', 'tickets.db');
  return { repo, db, sl, calls, mains };
}

test('assigned: 그 브랜치가 맡은 끝나지 않은 ticket 만, 할 일과 진행 기록까지. 저장소 파일이 없으면 빈 목록이고 만들지 않는다', async () => {
  const dir = tmp();
  const file = path.join(dir, 'tickets.db');
  assert.deepEqual(await assigned({ store: file, branch: 'feat/w' }), []);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await assigned({ branch: 'feat/w' }), []);

  const db = await store.openStore(file);
  const a = store.createTicket(db, { title: 'A', todo: 'do a' });
  const b = store.createTicket(db, { title: 'B' });
  const c = store.createTicket(db, { title: 'C' });
  store.updateTicket(db, a, { fields: { status: 'active' }, add: { assignee: ['feat/w'] } });
  store.updateTicket(db, b, { add: { assignee: ['feat/other'] } });
  store.updateTicket(db, c, { fields: { status: 'done' }, add: { assignee: ['feat/w'] } });
  store.addLog(db, a, 'feat/w', 'first');
  store.addLog(db, a, 'feat/w', 'second');
  db.close();

  const got = await assigned({ store: file, branch: 'feat/w' });
  assert.equal(got.length, 1);
  assert.deepEqual({ ...got[0], log: got[0].log.map((l: { text: string }) => l.text) }, { id: a, title: 'A', status: 'active', priority: 'normal', todo: 'do a', log: ['first', 'second'] });
  assert.match(got[0].log[0].at, /^\d{4}-\d\d-\d\dT/);
});

test('동사 뒤: 이 셸의 브랜치가 맡은 ticket 이 있으면 이 셸의 카드에 알약을 붙이고, 열린 알약 전부에 바뀜을 알린다', async () => {
  const h = harness();
  const ctx = { cwd: h.repo, tmux: '$7' };
  const id = (await h.sl(ctx, 'new', 'Work')).trim();
  // 아직 아무도 맡지 않았다 — 붙이지 않고 알리기만
  assert.deepEqual(h.calls, [['orchestration/floats', 'changed']]);
  h.calls.length = 0;

  await h.sl(ctx, 'set', id, 'assignee+=feat/w', 'status=active');
  assert.deepEqual(h.mains, [{ tmux: '$7' }]);
  assert.deepEqual(h.calls, [
    ['orchestration/floats', 'open', '$7', { store: h.db, branch: 'feat/w' }],
    ['orchestration/floats', 'changed'],
  ]);
  h.calls.length = 0;

  // 하위 폴더의 셸도 같은 저장소·브랜치다
  fs.mkdirSync(`${h.repo}/sub`);
  await h.sl({ cwd: `${h.repo}/sub`, tmux: '$7' }, 'log', id, 'halfway');
  assert.deepEqual(h.calls[0], ['orchestration/floats', 'open', '$7', { store: h.db, branch: 'feat/w' }]);
});

test('동사 뒤: tmux 밖의 셸, 저장소가 없는 곳, 다른 브랜치가 맡은 ticket 이면 붙이지 않는다', async () => {
  const h = harness();
  const id = (await h.sl({ cwd: h.repo, tmux: null }, 'new', 'Work')).trim();
  await h.sl({ cwd: h.repo, tmux: null }, 'set', id, 'assignee+=feat/w');
  assert.ok(h.calls.every(([, m]) => m === 'changed'));
  assert.deepEqual(h.mains, []);

  await h.sl({ cwd: h.repo, tmux: '$1' }, 'set', id, 'assignee-=feat/w', 'assignee+=feat/other');
  assert.ok(h.calls.every(([, m]) => m === 'changed'));

  // 저장소가 없는 곳 — 동사 자체가 실패하고 알약 쪽은 아무것도 하지 않는다
  const bare = tmp();
  await assert.rejects(h.sl({ cwd: bare, tmux: '$1' }, 'ls'), /no ticket store/);
  assert.deepEqual(h.mains, []);
});

test('동사 뒤: 창 호출이 실패해도 동사의 결과는 그대로다', async () => {
  const h = harness({ windowFails: true });
  const ctx = { cwd: h.repo, tmux: '$7' };
  const id = (await h.sl(ctx, 'new', 'Work')).trim();
  assert.equal(await h.sl(ctx, 'set', id, 'assignee+=feat/w'), `${id} updated`);
  assert.equal(await h.sl(ctx, 'log', id, 'still works'), `logged on ${id}`);
});
