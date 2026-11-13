// orchestration main 의 대시보드 연결과 릴리스 가능 알림 (ticket orchestration-dashboard) — `node --test test/orchestrationDashboard.test.ts`.
// 가짜 api 로 main.js 를 켜고, 대시보드 탭이 부르는 tickets.plan 과 ticket 동사 뒤의 master 알림(훅 A)을 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { activate } from '../orchestration/main.js';
import * as store from '../orchestration/tickets.js';
import { parseArgs } from './pluginhost-args.mjs';

const manifest = JSON.parse(fs.readFileSync(new URL('../orchestration/plugin.json', import.meta.url), 'utf8'));
type Handler = (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

async function harness({ mailFails = false } = {}) {
  const ws = fs.realpathSync(fs.mkdtempSync('/tmp/orch-dash-ws-'));
  fs.writeFileSync(`${ws}/.ticket`, '.superlite/tickets.db\n');
  const handlers = new Map<string, Handler>();
  const exposed: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> = {};
  const kv = new Map<string, unknown>();
  const mails: { to: string; text: string; from?: string }[] = [];
  const toasts: { message: string; opts: unknown }[] = [];
  const api = {
    settings: { get: async () => '' },
    storage: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v) },
    expose: (name: string, impl: Record<string, (...a: unknown[]) => Promise<unknown>>) => void (exposed[name] = impl),
    notify: (_sev: string, message: string, opts?: unknown) => void toasts.push({ message, opts }),
    window: { main: async () => ({}) },
    folder: { path: `${fs.mkdtempSync('/tmp/orch-dash-pl-')}/plugins/orchestration`, deploy: async (sub: string) => `/plugin/${sub}`, read: async (f: string) => fs.readFileSync(new URL(`../orchestration/${f}`, import.meta.url), 'utf8') },
    verbs: { handle: (name: string, fn: Handler) => void handlers.set(name, fn), run: async () => { throw new Error('no window'); } },
    plugins: {
      get: (id: string) => id === 'slcode-plugin'
        ? { run: async () => ({ code: 0, stdout: '', stderr: '' }) }
        : id === 'slcode' ? { mail: async (m: { to: string; text: string; from?: string }) => { if (mailFails) throw new Error('session is gone'); mails.push(m); } } : undefined,
    },
  };
  await activate(api as never);
  /** `superlite ticket <하위> ...` — sid 는 부른 slcode 세션 (없으면 직접 연 터미널) */
  const sl = async (sid: string | null, ...argv: string[]) => {
    const def = manifest.verbs.find((v: { name: string }) => v.name === `ticket.${argv[0]}`);
    return String(await handlers.get(def.name)!(parseArgs(def, argv.slice(1)), { cwd: ws, tmux: '$7', env: sid ? { SLCODE_SESSION_ID: sid } : {} }));
  };
  // 세션 트리: master(m) → sub(s) → worker(w). workers 는 팀원 세션 id 마다 하나 (orchestrate new 가 적는 꼴)
  kv.set('workers', { s: { parent: 'm', branch: 'sub' }, w: { parent: 's', branch: 'worker' } });
  kv.set('role:m', 'master-orchestrator');
  kv.set('role:s', 'sub-orchestrator');
  kv.set('role:w', 'worker');
  return { ws, sl, kv, mails, toasts, plan: (folder: string) => exposed.tickets.plan(folder) };
}

async function seed(ws: string) {
  const db = await store.openStore(`${ws}/.superlite/tickets.db`);
  const t = store.createTicket(db, { title: 'only one', lane: 'plugin' });
  const m = store.createMilestone(db, { title: 'cut', order: 1 });
  store.addToMilestone(db, m, [t]);
  db.close();
  return { t, m };
}

test('tickets.plan: 탭이 넘긴 워크스페이스 폴더(그 아래 폴더도)에서 저장소를 찾아 그릴 모습을 돌려준다', async () => {
  const h = await harness();
  const { t, m } = await seed(h.ws);
  fs.mkdirSync(`${h.ws}/sub/dir`, { recursive: true });
  const p = (await h.plan(`${h.ws}/sub/dir`)) as { milestones: { id: string; direct: string[]; next: boolean }[]; tickets: Record<string, { lane: string }> };
  assert.deepEqual(p.milestones.map((x) => [x.id, x.direct, x.next]), [[m, [t], true]]);
  assert.equal(p.tickets[t].lane, 'plugin');
  await assert.rejects(h.plan(path.dirname(h.ws)), /no ticket store/);
});

test('훅 A: 워커의 done 으로 릴리스 가능해지면 부모를 따라 올라가 master 세션에 메일, 동사 출력에도 적는다', async () => {
  const h = await harness();
  const { t, m } = await seed(h.ws);
  const out = await h.sl('w', 'done', t);
  assert.equal(out, `${t} done\nreleasable now: milestone ${m}\nreported to m (master-orchestrator)`);
  assert.equal(h.mails.length, 1);
  assert.equal(h.mails[0].to, 'm');
  assert.equal(h.mails[0].from, 'w');
  assert.match(h.mails[0].text, new RegExp(`^\\[ticket\\] milestone ${m} "cut" is releasable: .* superlite ticket milestone release ${m}$`));
  assert.equal(h.toasts.length, 0);
});

test('훅 A: SLCODE_SESSION_ID 가 없으면(카드 밖 셸) 이 폴더의 브랜치를 맡은 팀원 기록으로 부른 세션을 안다. 기록도 없으면 토스트', async () => {
  const h = await harness();
  const { t } = await seed(h.ws);
  assert.match(await h.sl(null, 'done', t), /no master-orchestrator session above this one: shown as a notification$/, 'git 저장소가 아니라 기록을 못 찾는다');
  assert.deepEqual(h.toasts.map((x) => x.opts), [{ tmux: '$7' }]);

  const g = await harness();
  const s = await seed(g.ws);
  execFileSync('git', ['init', '-q', '-b', 'worker2'], { cwd: g.ws });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: g.ws });
  g.kv.set('workers', { ...(g.kv.get('workers') as object), w2: { parent: 's', branch: 'worker2' } });
  assert.match(await g.sl(null, 'done', s.t), /reported to m \(master-orchestrator\)$/);
  assert.equal(g.mails[0].from, undefined);
});

test('훅 A: master 가 직접 부르면 출력만, master 가 없거나 메일이 실패하면 토스트', async () => {
  let h = await harness();
  let s = await seed(h.ws);
  assert.equal(await h.sl('m', 'drop', s.t), `${s.t} dropped\nreleasable now: milestone ${s.m}`);
  assert.equal(h.mails.length + h.toasts.length, 0);

  h = await harness();
  s = await seed(h.ws);
  h.kv.set('role:m', 'renamed-master');
  assert.match(await h.sl('w', 'done', s.t), /no master-orchestrator session above this one: shown as a notification$/);
  assert.match(h.toasts[0].message, /is releasable/);

  h = await harness({ mailFails: true });
  s = await seed(h.ws);
  assert.match(await h.sl('w', 'done', s.t), /not reported to m \(session is gone\): shown as a notification$/);
  assert.equal(h.toasts.length, 1);
});

test('훅 A: milestone add·remove 로 릴리스 가능해져도 알린다', async () => {
  const h = await harness();
  const db = await store.openStore(`${h.ws}/.superlite/tickets.db`);
  const m = store.createMilestone(db, { title: 'cut', order: 1 });
  const fin = store.createTicket(db, { title: 'finished' });
  const open = store.createTicket(db, { title: 'open' });
  store.addToMilestone(db, m, [fin, open]);
  store.updateTicket(db, fin, { fields: { status: 'done' } });
  const later = store.createMilestone(db, { title: 'later', order: 2 });
  db.close();
  // 남은 open 을 떼면 범위가 끝난 fin 하나만 남는다
  assert.match(await h.sl('s', 'milestone', 'remove', m, open), new RegExp(`^removed from ${m}: ${open}\nreleasable now: milestone ${m}\nreported to m \\(master-orchestrator\\)$`));
  // 빈 milestone 에 끝난 ticket 을 붙이면 그 milestone 이 릴리스 가능해진다
  assert.match(await h.sl('s', 'milestone', 'add', later, fin), new RegExp(`releasable now: milestone ${later}\nreported to m`));
  assert.deepEqual(h.mails.map((x) => x.text.match(/milestone (\S+)/)![1]), [m, later]);
});
