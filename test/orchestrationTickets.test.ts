// orchestration 의 ticket 저장소(tickets.js)와 superlite ticket 동사(ticketVerbs.js) — `node --test test/orchestrationTickets.test.ts`.
// 동사는 plugin.json 의 선언을 데몬 인자 해석 사본(pluginhost-args.mjs)으로 거쳐 부른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../orchestration/tickets.js';
import { handleTicketVerbs, parseEditText, editText, addTicketTrailers, withTicketTrailers, assigneeLive, clearTicketSessions } from '../orchestration/ticketVerbs.js';
import { parseArgs } from './pluginhost-args.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync('/tmp/orch-ticket-'));
const fresh = async () => store.openStore(path.join(tmp(), '.superlite', 'tickets.db'));
const pkClash = () => Object.assign(new Error('UNIQUE constraint failed'), { errcode: 1555 });

test('찾기: TICKET_PATH 가 먼저, 없으면 위로 올라가며 처음 만나는 .ticket (상대 경로는 그 폴더 기준)', () => {
  const root = tmp();
  fs.mkdirSync(`${root}/a/b`, { recursive: true });
  assert.throws(() => store.findStore(`${root}/a/b`), /no ticket store.*echo \.superlite\/tickets\.db > \.ticket/);
  fs.writeFileSync(`${root}/.ticket`, '.superlite/tickets.db\n');
  assert.deepEqual(store.findStore(`${root}/a/b`), { file: `${root}/.superlite/tickets.db`, via: `${root}/.ticket` });
  fs.writeFileSync(`${root}/a/.ticket`, '/abs/x.db');
  assert.equal(store.findStore(`${root}/a/b`).file, '/abs/x.db');
  assert.deepEqual(store.findStore(`${root}/a/b`, { TICKET_PATH: 'here.db' }), { file: `${root}/a/b/here.db`, via: 'TICKET_PATH' });
  fs.writeFileSync(`${root}/a/.ticket`, '  \n');
  assert.throws(() => store.findStore(`${root}/a/b`), /\.ticket is empty/);
});

test('열기: 없으면 만들고 .superlite/.gitignore 를 두며, WAL·user_version 2. 더 새 스키마는 거절한다', async () => {
  const dir = tmp();
  const file = `${dir}/.superlite/tickets.db`;
  let db = await store.openStore(file);
  assert.equal(fs.readFileSync(`${dir}/.superlite/.gitignore`, 'utf8'), '*\n');
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();
  fs.writeFileSync(`${dir}/.superlite/.gitignore`, 'kept\n');
  db = await store.openStore(file);
  db.exec('PRAGMA user_version = 9');
  db.close();
  assert.equal(fs.readFileSync(`${dir}/.superlite/.gitignore`, 'utf8'), 'kept\n');
  await assert.rejects(store.openStore(file), /schema 9, newer than this plugin knows \(2\)/);
  // .superlite 가 아닌 폴더에는 .gitignore 를 두지 않는다
  (await store.openStore(`${dir}/other/t.db`)).close();
  assert.equal(fs.existsSync(`${dir}/other/.gitignore`), false);
});

test('스키마 1판 DB 를 열면 2판으로 옮기고, 기존 담당은 세션 id 없이 브랜치만 남는다', async () => {
  const file = `${tmp()}/tickets.db`;
  const { DatabaseSync } = await import('node:sqlite');
  const v1 = new DatabaseSync(file);
  // 1판 그대로 — tickets.js 의 SCHEMA[0] 에서 이 테스트가 쓰는 칸만
  v1.exec(`CREATE TABLE ticket (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','active','hold','done','dropped')), priority TEXT NOT NULL DEFAULT 'normal', lane TEXT, todo TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, closed TEXT);
    CREATE TABLE ticket_depends (ticket TEXT NOT NULL, depends TEXT NOT NULL, PRIMARY KEY (ticket, depends));
    CREATE TABLE ticket_assignee (ticket TEXT NOT NULL REFERENCES ticket(id), session TEXT NOT NULL, PRIMARY KEY (ticket, session));
    CREATE TABLE ticket_repo (ticket TEXT NOT NULL, repo TEXT NOT NULL, PRIMARY KEY (ticket, repo));
    CREATE TABLE ticket_log (ticket TEXT NOT NULL, at TEXT NOT NULL, session TEXT, text TEXT NOT NULL);
    CREATE TABLE milestone (id TEXT PRIMARY KEY, title TEXT NOT NULL, ord INTEGER NOT NULL UNIQUE, status TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, released TEXT);
    CREATE TABLE milestone_ticket (milestone TEXT NOT NULL, ticket TEXT NOT NULL, auto INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (milestone, ticket));
    INSERT INTO ticket (id, title, status, created) VALUES ('261101-0001', 'old', 'active', '2026-11-01T00:00:00.000Z');
    INSERT INTO ticket_assignee (ticket, session) VALUES ('261101-0001', 'feat/old');
    PRAGMA user_version = 1;`);
  v1.close();
  const db = await store.openStore(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const t = store.getTicket(db, '261101-0001');
  assert.deepEqual([t.assignees, t.assigneeSessions], [['feat/old'], [{ branch: 'feat/old', session: null }]]);
  store.claimTicket(db, t.id, 'feat/old', 's1');
  assert.deepEqual(store.getTicket(db, t.id).assigneeSessions, [{ branch: 'feat/old', session: 's1' }]);
  db.close();
});

test('claim: 담당을 더하고 open·hold 를 active 로, 같은 브랜치는 세션 id 만 바꾸고, 끝난 ticket 은 거절한다. 세션 비우기는 그 브랜치만', async () => {
  const db = await fresh();
  const a = store.createTicket(db, { title: 'a' });
  store.claimTicket(db, a, 'feat/x', 's1');
  const t = store.getTicket(db, a);
  assert.equal(t.status, 'active');
  assert.deepEqual(t.assigneeSessions, [{ branch: 'feat/x', session: 's1' }]);
  store.claimTicket(db, a, 'feat/x', 's2');
  store.claimTicket(db, a, 'feat/y', null);
  assert.deepEqual(store.getTicket(db, a).assigneeSessions, [{ branch: 'feat/x', session: 's2' }, { branch: 'feat/y', session: null }]);
  // set 의 assignee+= 는 claim 한 세션 id 를 건드리지 않는다
  store.updateTicket(db, a, { add: { assignee: ['feat/x'] } });
  assert.equal(store.getTicket(db, a).assigneeSessions[0].session, 's2');
  const b = store.createTicket(db, { title: 'b' });
  store.updateTicket(db, b, { fields: { status: 'hold' } });
  store.claimTicket(db, b, 'feat/x', 's2');
  assert.equal(store.getTicket(db, b).status, 'active');
  store.clearAssigneeSessions(db, 'feat/x');
  assert.deepEqual(store.getTicket(db, a).assigneeSessions, [{ branch: 'feat/x', session: null }, { branch: 'feat/y', session: null }]);
  assert.deepEqual(store.getTicket(db, b).assigneeSessions, [{ branch: 'feat/x', session: null }], '브랜치는 이력으로 남는다');
  for (const status of ['done', 'dropped']) {
    const c = store.createTicket(db, { title: status });
    store.updateTicket(db, c, { fields: { status } });
    assert.throws(() => store.claimTicket(db, c, 'feat/x', 's1'), new RegExp(`ticket ${c} is ${status}: only an unfinished ticket can be claimed`));
    assert.deepEqual(store.getTicket(db, c).assignees, []);
  }
  assert.throws(() => store.claimTicket(db, 'nope', 'feat/x', 's1'), /unknown ticket: nope/);
});

test('live·missing: slcode 목록에 있으면 live, 없으면 missing, 세션 id 가 없거나 끝난 ticket·옛 slcode 는 따지지 않는다', async () => {
  const row = (status: string, ...a: [string, string | null][]) => ({ status, assigneeSessions: a.map(([branch, session]) => ({ branch, session })) });
  let calls = 0;
  const api = (list?: () => Promise<unknown>) => ({ plugins: { get: (id: string) => (id === 'slcode' ? { list: list && (async () => { calls++; return list(); }) } : undefined) } }) as never;
  const alive = async () => [{ id: 's1', state: 'working', live: true }];
  const tickets = [row('active', ['feat/a', 's1'], ['feat/b', 's2'], ['feat/c', null]), row('done', ['feat/d', 's1'])];
  assert.deepEqual(await assigneeLive(api(alive), tickets), [
    [{ branch: 'feat/a', session: 's1', live: true, state: 'working' }, { branch: 'feat/b', session: 's2', live: false, state: null }, { branch: 'feat/c', session: null, live: null, state: null }],
    [{ branch: 'feat/d', session: 's1', live: null, state: null }],
  ]);
  assert.equal(calls, 1);
  const none = [{ branch: 'feat/a', session: 's1', live: null, state: null }];
  assert.deepEqual(await assigneeLive(api(), [row('active', ['feat/a', 's1'])]), [none], 'list 가 없는 옛 slcode');
  assert.deepEqual(await assigneeLive({ plugins: { get: () => undefined } } as never, [row('active', ['feat/a', 's1'])]), [none], 'slcode 플러그인이 없다');
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await assigneeLive(api(async () => { throw new Error('slcode: not found'); }), [row('active', ['feat/a', 's1'])]), [none], '목록을 못 읽으면 표시만 빠진다');
  } finally {
    console.error = err;
  }
  calls = 0;
  await assigneeLive(api(alive), [row('active', ['feat/c', null]), row('done', ['feat/d', 's1'])]);
  assert.equal(calls, 0, '따질 담당이 없으면 slcode 를 부르지 않는다');
});

test('세션 비우기: 지우기 전에 찾아 둔 저장소에서, 저장소가 없으면 아무것도 않고, 열지 못하면 사유를 돌려준다', async () => {
  assert.equal(await clearTicketSessions(null, 'feat/x'), '');
  const file = `${tmp()}/tickets.db`;
  const db = await store.openStore(file);
  const a = store.createTicket(db, { title: 'a' });
  store.claimTicket(db, a, 'feat/x', 's1');
  db.close();
  assert.equal(await clearTicketSessions(file, 'feat/x'), '');
  const again = await store.openStore(file);
  assert.deepEqual(store.getTicket(again, a).assigneeSessions, [{ branch: 'feat/x', session: null }]);
  again.exec('PRAGMA user_version = 9');
  again.close();
  assert.match(await clearTicketSessions(file, 'feat/x'), /^ticket assignee session not cleared: the ticket DB is schema 9/);
});

test('동시 쓰기: 여러 프로세스가 없는 DB 를 함께 열고 써도 하나도 잃지 않는다', async () => {
  const file = `${tmp()}/.superlite/tickets.db`;
  const mod = new URL('../orchestration/tickets.js', import.meta.url).href;
  const script = `const s = await import(${JSON.stringify(mod)}); const db = await s.openStore(process.argv[1]);
    for (let i = 0; i < 30; i++) { const id = s.createTicket(db, { title: 't' }); s.addLog(db, id, null, 'x'); await new Promise((r) => setTimeout(r, 2)); }
    db.close();`;
  const { spawn } = await import('node:child_process');
  const codes = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script, file], { stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('close', resolve);
  })));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);
  const db = await store.openStore(file);
  assert.equal(db.prepare('SELECT count(*) AS n FROM ticket_log').get().n, 180);
  db.close();
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.new')), [], '임시 파일이 남지 않는다');
});

test('id: YYMMDD-xxxx, 겹치면 다시 뽑고, 30번 뒤에는 1씩 올리며, 0xffff 다음은 5자리', () => {
  const day = new Date(2026, 10, 9, 23, 59);
  assert.equal(store.issueId(() => {}, day, () => 0x3fa), '261109-03fa');
  const taken = new Set(['261109-0001']);
  const insert = (id: string) => { if (taken.has(id)) throw pkClash(); taken.add(id); };
  const seq = [1, 2];
  assert.equal(store.issueId(insert, day, () => seq.shift()!), '261109-0002');
  let calls = 0;
  for (let n = 0x10; n <= 0x12; n++) taken.add(`261109-${n.toString(16).padStart(4, '0')}`);
  assert.equal(store.issueId(insert, day, () => { calls++; return 0x10; }), '261109-0013');
  assert.equal(calls, 30);
  taken.add('261109-ffff');
  assert.equal(store.issueId(insert, day, () => 0xffff), '261109-10000');
  assert.throws(() => store.issueId(() => { throw new Error('disk full'); }, day, () => 1), /disk full/);
});

test('ticket: 만들고 읽고, depends 고리와 없는 id 는 거절한다', async () => {
  const db = await fresh();
  const a = store.createTicket(db, { title: ' A ', lane: 'plugin', repos: ['r1', 'r2'], todo: 'do a', reason: 'why a' });
  const b = store.createTicket(db, { title: 'B', depends: [a], priority: 'high' });
  assert.match(a, /^\d{6}-[0-9a-f]{4}$/);
  const ta = store.getTicket(db, a);
  assert.equal(ta.title, 'A');
  assert.equal(ta.status, 'open');
  assert.deepEqual(ta.repos, ['r1', 'r2']);
  assert.deepEqual(ta.dependents.map((t) => t.id), [b]);
  assert.deepEqual(store.getTicket(db, b).depends.map((t) => t.id), [a]);
  assert.throws(() => store.updateTicket(db, a, { add: { depends: [b] } }), /cannot depend on .*loop/);
  assert.throws(() => store.updateTicket(db, a, { add: { depends: [a] } }), /loop/);
  assert.throws(() => store.createTicket(db, { title: 'C', depends: ['nope'] }), /unknown ticket: nope/);
  assert.throws(() => store.createTicket(db, { title: 'C', priority: 'urgent' }), /priority "urgent"/);
  assert.equal(store.listTickets(db, { status: store.STATUSES }).length, 2, '실패한 만들기는 아무것도 남기지 않는다');
  store.updateTicket(db, a, { fields: { status: 'done' } });
  assert.match(store.getTicket(db, a).closed!, /^\d{4}-\d\d-\d\dT/);
  store.updateTicket(db, a, { fields: { status: 'active' } });
  assert.equal(store.getTicket(db, a).closed, null);
});

test('done: 계획 밖 ticket 은 다음 milestone(open 중 ord 최저)에 auto 로 붙고, 범위에 든 ticket·drop 은 붙지 않는다', async () => {
  const db = await fresh();
  const loose = store.createTicket(db, { title: 'loose' });
  assert.equal(store.updateTicket(db, loose, { fields: { status: 'done' } }).attached, null, 'open milestone 이 없으면 붙이지 않는다');
  const m2 = store.createMilestone(db, { title: 'later', order: 2 });
  const m1 = store.createMilestone(db, { title: 'first', order: 1 });
  assert.throws(() => store.createMilestone(db, { title: 'dup', order: 1 }), /order 1 is taken/);
  const base = store.createTicket(db, { title: 'base' });
  const top = store.createTicket(db, { title: 'top', depends: [base], milestone: m2 });
  const bug = store.createTicket(db, { title: 'bug' });
  const gone = store.createTicket(db, { title: 'gone' });
  assert.equal(store.updateTicket(db, base, { fields: { status: 'done' } }).attached, null, 'depends 로 m2 범위에 있다');
  assert.equal(store.updateTicket(db, bug, { fields: { status: 'done' } }).attached, m1);
  assert.equal(store.updateTicket(db, gone, { fields: { status: 'dropped' } }).attached, null);
  assert.deepEqual(store.getTicket(db, bug).milestones.map((m) => [m.id, m.auto]), [[m1, 1]]);
  assert.deepEqual(store.milestoneScope(db, m2).map((t) => [t.id, t.direct]), [[base, false], [top, true]].sort());
  assert.deepEqual(store.listTickets(db, { milestone: m2, status: store.STATUSES }).map((t) => t.id).sort(), [base, top].sort());
});

test('릴리스 가능: 범위가 모두 끝난 open milestone — done·drop·add·remove 가 새로 그렇게 된 것을 돌려준다', async () => {
  const db = await fresh();
  const m = store.createMilestone(db, { title: 'v1', order: 1, goal: 'ship' });
  assert.deepEqual(store.releasableMilestones(db), [], '빈 milestone 은 릴리스 가능이 아니다');
  const a = store.createTicket(db, { title: 'a', milestone: m });
  const b = store.createTicket(db, { title: 'b' });
  store.updateTicket(db, a, { add: { depends: [b] } });
  assert.deepEqual(store.updateTicket(db, a, { fields: { status: 'done' } }).released, []);
  assert.throws(() => store.releaseMilestone(db, m), new RegExp(`unfinished tickets: ${b} \\(open\\)`));
  assert.deepEqual(store.updateTicket(db, b, { fields: { status: 'dropped' } }).released, [m]);
  assert.deepEqual(store.releasableMilestones(db), [m]);
  assert.equal(store.getMilestone(db, m).releasable, true);
  const c = store.createTicket(db, { title: 'c' });
  assert.deepEqual(store.addToMilestone(db, m, [c]).released, []);
  assert.deepEqual(store.releasableMilestones(db), []);
  assert.deepEqual(store.removeFromMilestone(db, m, [c]).released, [m]);
  assert.throws(() => store.removeFromMilestone(db, m, [b]), /not attached to .* directly/);
  store.releaseMilestone(db, m);
  assert.deepEqual(store.releasableMilestones(db), [], 'released 는 릴리스 가능 목록에 없다');
  const after = store.getMilestone(db, m);
  assert.equal(after.status, 'released');
  assert.equal(after.releasable, false);
  assert.throws(() => store.releaseMilestone(db, m), /already released/);
});

test('edit 글: 제목·todo·reason 을 오가고, 머리를 지우면 거절한다', () => {
  const t = { title: 'T', todo: 'line1\n\nline2', reason: '' };
  assert.deepEqual(parseEditText(editText(t)), t);
  assert.deepEqual(parseEditText('# New\r\n## todo\r\nx\r\n## reason\r\ny'), { title: 'New', todo: 'x', reason: 'y' });
  assert.throws(() => parseEditText('# T\n## reason\n## todo\n'), /keep the first line/);
});

// ---- 동사

const manifest = JSON.parse(fs.readFileSync(new URL('../orchestration/plugin.json', import.meta.url), 'utf8'));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function harness({ openFails = false } = {}) {
  const repo = tmp();
  git(repo, 'init', '-q', '-b', 'feat/x');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  fs.writeFileSync(`${repo}/.ticket`, '.superlite/tickets.db\n');
  const handlers = new Map<string, (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const opened: string[] = [];
  const notes: string[] = [];
  const alive = new Set<string>(); // slcode 의 살아 있는 세션 id
  const api = {
    plugins: { get: (id: string) => (id === 'slcode' ? { list: async () => [...alive].map((sid) => ({ id: sid, state: 'idle', live: true })) } : undefined) },
    verbs: {
      handle: (name: string, fn: (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => {
        assert.ok(manifest.verbs.some((v: { name: string }) => v.name === name), `${name} is declared`);
        handlers.set(name, fn);
      },
      run: async (name: string, argv: string[]) => {
        assert.equal(name, 'open');
        if (openFails) throw new Error('no window');
        opened.push(argv[0]);
      },
    },
    notify: (sev: string, msg: string) => void notes.push(`${sev}: ${msg}`),
    folder: { read: async (f: string) => fs.readFileSync(new URL(`../orchestration/${f}`, import.meta.url), 'utf8') },
  };
  handleTicketVerbs(api as never);
  const ctx = { cwd: repo, tmux: '%1', env: {} };
  // `superlite ticket <하위> ...` 처럼 — 데몬과 같이 ticket.<첫 인자> 로 고르고 나머지를 선언대로 해석한다
  const sl = async (...argv: string[]) => {
    const find = (n: string) => manifest.verbs.find((v: { name: string }) => v.name === n);
    const sub = argv[0] === undefined ? undefined : find(`ticket.${argv[0]}`);
    const def = sub ?? find('ticket');
    const rest = sub === undefined ? argv : argv.slice(1);
    return String(await handlers.get(def.name)!(parseArgs(def, rest), ctx));
  };
  return { repo, sl, opened, notes, handlers, ctx, alive };
}

test('Ticket trailer: 빠진 id 만 더하고, 끝 문단이 trailer 묶음이면 그 묶음에 잇는다', () => {
  assert.equal(addTicketTrailers('feat: x', ['261109-03fa']), 'feat: x\n\nTicket: 261109-03fa\n');
  assert.equal(addTicketTrailers('feat: x\n\nbody: not alone\n\n', ['a', 'b']), 'feat: x\n\nbody: not alone\nTicket: a\nTicket: b\n');
  assert.equal(addTicketTrailers('feat: x\n\nsome body\n', ['a']), 'feat: x\n\nsome body\n\nTicket: a\n');
  assert.equal(addTicketTrailers('feat: x\n\nTicket: a', ['a', 'b']), 'feat: x\n\nTicket: a\nTicket: b\n');
  assert.equal(addTicketTrailers('feat: x\n\nTicket: a', ['a']), 'feat: x\n\nTicket: a');
  assert.equal(addTicketTrailers('feat: x', []), 'feat: x');
});

test('Ticket trailer: 이 브랜치가 assignee 인 끝나지 않은 ticket 만, 저장소가 없으면 그대로 두고 DB 를 만들지 않는다', async () => {
  const root = tmp();
  assert.deepEqual(await withTicketTrailers({ cwd: root, env: {} }, 'feat/a', 'm'), { message: 'm', note: '' });
  fs.writeFileSync(`${root}/.ticket`, '.superlite/tickets.db\n');
  assert.deepEqual(await withTicketTrailers({ cwd: root, env: {} }, 'feat/a', 'm'), { message: 'm', note: '' });
  assert.equal(fs.existsSync(`${root}/.superlite`), false);
  const db = await store.openStore(`${root}/.superlite/tickets.db`);
  const [a, b, c] = ['a', 'b', 'c'].map((title) => store.createTicket(db, { title }));
  store.updateTicket(db, a, { add: { assignee: ['feat/a'] } });
  store.updateTicket(db, b, { add: { assignee: ['feat/a', 'feat/b'] } });
  store.updateTicket(db, c, { add: { assignee: ['feat/a'] }, fields: { status: 'done' } });
  db.close();
  const r = await withTicketTrailers({ cwd: root, env: {} }, 'feat/a', 'feat: x');
  assert.deepEqual(r.message.split('\n').filter((l) => l.startsWith('Ticket:')).sort(), [`Ticket: ${a}`, `Ticket: ${b}`].sort());
  assert.match(r.note, /^Ticket trailer: /);
  assert.deepEqual(await withTicketTrailers({ cwd: root, env: {} }, 'feat/none', 'm'), { message: 'm', note: '' });
});

test('동사: ticket 만 치면 하위 동사를 한 줄씩 보이고, 모르는 하위 동사는 사용법 오류다', async () => {
  const h = harness();
  const out = await h.sl();
  const subs = manifest.verbs.filter((v: { name: string }) => v.name.startsWith('ticket.'));
  assert.equal(out.split('\n').length, subs.length + 2);
  assert.match(out, /^superlite ticket new\s+Create a ticket and print its id$/m);
  assert.match(out, /^superlite ticket milestone\s+Milestones: new/m);
  assert.match(out, /--help explains its arguments\.$/);
  for (const v of subs) assert.match(manifest.verbs.find((x: { name: string }) => x.name === 'ticket').help, new RegExp(`\\b${v.name.slice(7)}\\b`), `${v.name} is named in the ticket help`);
  // superlite --help 에는 ticket 한 줄만 — 하위 동사는 숨겨도 위 목록과 ticket 의 help 에 모두 나온다
  const top = manifest.verbs.find((x: { name: string }) => x.name === 'ticket');
  assert.equal(top.visibility, 'advertise');
  assert.match(top.description, /superlite ticket --help/);
  assert.equal(subs.length, 11);
  assert.ok(subs.every((v: { visibility?: string }) => v.visibility === 'hidden'));
  for (const v of subs) assert.match(out, new RegExp(`^superlite ticket ${v.name.slice(7)}\\s`, 'm'));
  await assert.rejects(h.sl('frobnicate'), /unexpected argument: frobnicate\nUsage: superlite ticket\n/);
});

test('동사: new·ls·set·log·show — log 는 이 폴더의 브랜치로 서명하고, show 는 Ticket: trailer 커밋을 보인다', async () => {
  const h = harness();
  assert.match(await h.sl('root'), new RegExp(`^${h.repo}/\\.superlite/tickets\\.db \\(created on first use\\)\nfrom ${h.repo}/\\.ticket$`));
  const a = await h.sl('new', '--lane', 'plugin', '--todo', 'store 를 둔다', 'ticket', 'store');
  const b = await h.sl('new', '--depends', a, '--priority', 'high', '--', 'second', 'one');
  assert.match(a, /^\d{6}-[0-9a-f]{4}$/);
  assert.equal(await h.sl('set', b, 'status=active', 'assignee+=feat/x,feat/y', 'lane=core', '--reason', 'because\nof this'), `${b} updated`);
  await h.sl('set', b, 'assignee-=feat/y');
  await assert.rejects(h.sl('set', b), /nothing to change/);
  await assert.rejects(h.sl('set', b, 'status+=done'), /take =/);
  await assert.rejects(h.sl('set', b, 'status=closed'), /status "closed"/);
  const ls = await h.sl('ls');
  assert.match(ls, new RegExp(`${a}\\s+open\\s+normal\\s+plugin\\s+-\\s+ticket store`));
  assert.match(ls, new RegExp(`${b}\\s+active\\s+high\\s+core\\s+feat/x\\s+second one`));
  assert.equal((await h.sl('ls', '--assignee', 'feat/x')).split('\n').length, 1);
  assert.equal(await h.sl('ls', '--status', 'done'), 'no tickets');
  assert.equal(await h.sl('log', b, '--', '--flag', 'works'), `logged on ${b}`);

  git(h.repo, 'commit', '-q', '--allow-empty', '-m', `feat: second\n\nTicket: ${b}`);
  git(h.repo, 'commit', '-q', '--allow-empty', '-m', `chore: mentions ${b} in the body only`);
  const show = await h.sl('show', b);
  assert.match(show, new RegExp(`^${b}  second one\nstatus active · priority high · lane core\n`));
  assert.match(show, /assignee: feat\/x\n/);
  assert.match(show, new RegExp(`depends:\n  ${a} \\(open\\) ticket store`));
  assert.match(show, /## reason\nbecause\nof this\n/);
  assert.match(show, /## log\n\S+ feat\/x  --flag works\n/);
  assert.match(show, /## commits\n[0-9a-f]+ \d{4}-\d\d-\d\d feat: second$/);
  assert.match(await h.sl('show', a), new RegExp(`needed by:\n  ${b} \\(active\\) second one\n\n## todo\nstore 를 둔다\n[\\s\\S]*## commits\n\\(none with this Ticket: trailer\\)$`));
  await assert.rejects(h.sl('show', 'nope'), /unknown ticket: nope/);
});

test('동사: claim 은 이 브랜치와 세션을 담당에 적고 show 본문을 내며, ls 는 live 에 *·missing 에 ? 를 붙인다', async () => {
  const h = harness();
  const a = await h.sl('new', '--todo', 'do a', 'a');
  h.ctx.env = { SLCODE_SESSION_ID: 'abc123' };
  h.alive.add('abc123');
  const claimed = await h.sl('claim', a);
  assert.equal(claimed, await h.sl('show', a), 'show 와 같은 본문');
  assert.match(claimed, new RegExp(`^${a}  a\nstatus active · priority normal\n`));
  assert.match(claimed, /\nassignee: feat\/x \(live, session abc123\)\n[\s\S]*## todo\ndo a\n/);
  assert.match(await h.sl('ls'), new RegExp(`^${a}\\s+active\\s+normal\\s+-\\s+feat/x\\*\\s+a$`));
  // 다른 브랜치의 담당은 세션 없이 더해 둔다 — 브랜치만 보인다. 세션이 끝나면 missing
  await h.sl('set', a, 'assignee+=feat/y');
  h.alive.delete('abc123');
  assert.match(await h.sl('ls'), new RegExp(`^${a}\\s+active\\s+normal\\s+-\\s+feat/x\\?,feat/y\\s+a$`));
  assert.match(await h.sl('show', a), /\nassignee: feat\/x \(missing, session abc123\), feat\/y\n/);
  // 세션 id 가 없는 셸(tmux 워커)의 재 claim 은 브랜치만 남긴다
  h.ctx.env = {};
  assert.match(await h.sl('claim', a), /\nassignee: feat\/x, feat\/y\n/);
  // 끝난 ticket 에는 표시하지 않고, claim 은 거절한다
  h.ctx.env = { SLCODE_SESSION_ID: 'abc123' };
  await h.sl('claim', a);
  await h.sl('done', a);
  assert.match(await h.sl('show', a), /\nassignee: feat\/x, feat\/y\n/);
  assert.match(await h.sl('ls', '--status', 'done'), /feat\/x,feat\/y/);
  await assert.rejects(h.sl('claim', a), /is done: only an unfinished ticket can be claimed/);
  git(h.repo, 'checkout', '-q', '--detach');
  const b = await h.sl('new', 'b');
  await assert.rejects(h.sl('claim', b), /records the branch of this folder/);
  assert.equal((await h.sl('show', b)).includes('assignee'), false);
});

test('동사: done·drop·milestone — 다음 milestone 에 붙은 것과 새로 릴리스 가능해진 것을 알린다', async () => {
  const h = harness();
  const m1 = await h.sl('milestone', 'new', 'first', 'cut', '--order', '1', '--goal', 'core works');
  await assert.rejects(h.sl('milestone', 'new', 'x'), /needs --order/);
  await assert.rejects(h.sl('milestone', 'new', 'x', '--order', 'one'), /--order must be an integer/);
  const a = await h.sl('new', 'a');
  const b = await h.sl('new', 'b');
  assert.equal(await h.sl('milestone', 'add', m1, a), `added to ${m1}: ${a}`);
  assert.equal(await h.sl('done', b), `${b} done\nattached to milestone ${m1}`);
  assert.match(await h.sl('milestone', 'ls'), new RegExp(`^${m1}  1  open  1/2  first cut$`));
  assert.equal(await h.sl('drop', a), `${a} dropped\nreleasable now: milestone ${m1}`);
  assert.match(await h.sl('milestone', 'ls'), new RegExp(`^${m1}  1  releasable  2/2  first cut$`));
  const shown = await h.sl('milestone', 'show', m1);
  assert.match(shown, new RegExp(`^${m1}  first cut\norder 1 · open · 2/2 finished · releasable\n\ncore works\n`));
  assert.match(shown, new RegExp(`${a}  dropped\\s+a`));
  assert.equal(await h.sl('milestone', 'release', m1), `milestone ${m1} released`);
  assert.match(await h.sl('milestone', 'ls'), new RegExp(`^${m1}  1  released  2/2  first cut$`));
  await assert.rejects(h.sl('milestone', 'add', m1), /usage: superlite ticket milestone add <id> <ticket\.\.\.>/);
  await assert.rejects(h.sl('milestone', 'close', m1), /unknown milestone action "close"/);
});

test('동사: edit 는 마크다운을 편집기로 열고, 저장될 때마다 본문을 넣는다', async () => {
  const h = harness();
  const id = await h.sl('new', '--todo', 'old', 'title');
  const out = await h.sl('edit', id);
  const file = `${h.repo}/.superlite/ticket-edit/${id}.md`;
  assert.equal(out, `opened ${file} — each save updates ${id}`);
  assert.deepEqual(h.opened, [file]);
  assert.equal(fs.readFileSync(file, 'utf8'), '# title\n\n## todo\n\nold\n\n## reason\n\n\n');
  fs.writeFileSync(file, '# new title\n\n## todo\n\nnew todo\n\n## reason\n\nr\n');
  const until = async (re: RegExp) => {
    for (let i = 0; i < 50 && !re.test(await h.sl('show', id)); i++) await new Promise((r) => setTimeout(r, 50));
    return h.sl('show', id);
  };
  assert.match(await until(/new todo/), new RegExp(`^${id}  new title\n[\\s\\S]*## todo\nnew todo\n\n## reason\nr\n`));
  fs.writeFileSync(file, 'broken');
  for (let i = 0; i < 50 && h.notes.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(h.notes[0], /^error: ticket .*: not saved — keep the first line/);
  fs.rmSync(file); // 지우면 지켜보기를 멈춘다 — 테스트 프로세스가 끝날 수 있다

  const h2 = harness({ openFails: true });
  const id2 = await h2.sl('new', 'x');
  assert.match(await h2.sl('edit', id2), new RegExp(`^edit ${h2.repo}/\\.superlite/ticket-edit/${id2}\\.md — each save`));
  fs.rmSync(`${h2.repo}/.superlite/ticket-edit/${id2}.md`);
});
