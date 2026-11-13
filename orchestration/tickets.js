// ticket·milestone 저장소 (ticket orchestration-ticket-store, 설계 ws docs/report/ticket-structure-draft.md). SQLite 파일 하나에 본문까지 넣는다.
// 동사(ticketVerbs.js)와 대시보드가 함께 쓴다 — milestone 범위와 릴리스 가능 판정은 여기 하나만 둔다.
//
// 찾기: 환경 변수 TICKET_PATH(DB 경로, 상대면 cwd 기준) → cwd 에서 위로 처음 만나는 .ticket(내용은 DB 경로 한 줄, 상대면 그 폴더 기준).
// DB 가 없으면 열 때 만든다. 그 폴더가 .superlite 이고 .gitignore 가 없으면 `*` 로 둔다 (code-superlight backend/common/src/memo.rs 와 같은 관례).
// WAL·busy_timeout 으로 여러 세션이 동시에 써도 트랜잭션이 막아 준다. 스키마 판은 PRAGMA user_version, 열 때 옮긴다.
// 시각은 ISO 8601 UTC 문자열(toISOString). id 앞자리만 로컬 날짜다.
// assignee·log 의 session 칸에는 워커의 브랜치 이름을 적는다 (lead-plugin 2026-11-09: SLCODE_SESSION_ID 는 tmux 안 워커에 없고 다시 띄우면 바뀐다).
// 스키마 2판(ticket orchestration-ticket-claim): ticket_assignee.session_id 는 ticket claim 한 slcode 세션 id 다. 없으면 NULL 이고, worker done --close 가 비운다.
// 살아 있음(live·missing)은 저장하지 않는다 — 읽을 때 ticketVerbs.js 의 assigneeLive 가 slcode 세션 목록과 견준다. 이 파일은 slcode 를 모른다.
// milestone_ticket.auto=1 은 done 이 계획 밖 ticket 을 다음 milestone 에 붙인 줄이다.
// node:sqlite 는 Node 22.5 이상에만 있어 openStore 안에서 불러온다 — 옛 Node 에서도 orchestration 의 다른 동사는 산다.

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['open', 'active', 'hold', 'done', 'dropped'];
export const PRIORITIES = ['critical', 'high', 'normal', 'low'];
const FINISHED = ['done', 'dropped'];
export const isFinished = (status) => FINISHED.includes(status);

const SCHEMA = [
  // 1
  `CREATE TABLE ticket (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    status    TEXT NOT NULL CHECK (status IN ('open','active','hold','done','dropped')),
    priority  TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low')),
    lane      TEXT,
    todo      TEXT NOT NULL DEFAULT '',
    reason    TEXT NOT NULL DEFAULT '',
    created   TEXT NOT NULL,
    closed    TEXT
  );
  CREATE TABLE ticket_depends  (ticket TEXT NOT NULL REFERENCES ticket(id), depends TEXT NOT NULL REFERENCES ticket(id), PRIMARY KEY (ticket, depends));
  CREATE TABLE ticket_assignee (ticket TEXT NOT NULL REFERENCES ticket(id), session TEXT NOT NULL, PRIMARY KEY (ticket, session));
  CREATE TABLE ticket_repo     (ticket TEXT NOT NULL REFERENCES ticket(id), repo TEXT NOT NULL, PRIMARY KEY (ticket, repo));
  CREATE TABLE ticket_log (ticket TEXT NOT NULL REFERENCES ticket(id), at TEXT NOT NULL, session TEXT, text TEXT NOT NULL);
  CREATE INDEX ticket_log_ticket ON ticket_log (ticket, at);
  CREATE TABLE milestone (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    ord       INTEGER NOT NULL UNIQUE,
    status    TEXT NOT NULL CHECK (status IN ('open','released')),
    goal      TEXT NOT NULL DEFAULT '',
    created   TEXT NOT NULL,
    released  TEXT
  );
  CREATE TABLE milestone_ticket (milestone TEXT NOT NULL REFERENCES milestone(id), ticket TEXT NOT NULL REFERENCES ticket(id), auto INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (milestone, ticket));`,
  // 2
  'ALTER TABLE ticket_assignee ADD COLUMN session_id TEXT',
];

// ---- 찾기·열기

/** DB 경로와 찾은 곳 — 못 찾으면 만드는 법과 함께 던진다 */
export function findStore(cwd, env = {}) {
  if (env.TICKET_PATH) return { file: path.resolve(cwd, env.TICKET_PATH), via: 'TICKET_PATH' };
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const marker = path.join(dir, '.ticket');
    if (fs.existsSync(marker)) {
      const line = fs.readFileSync(marker, 'utf8').split('\n')[0].trim();
      if (line === '') throw new Error(`${marker} is empty: write the ticket DB path in it, e.g. .superlite/tickets.db`);
      return { file: path.resolve(dir, line), via: marker };
    }
    if (path.dirname(dir) === dir) break;
  }
  throw new Error(`no ticket store: no .ticket above ${cwd} and TICKET_PATH is not set. Create one in the workspace root with: echo .superlite/tickets.db > .ticket`);
}

/** DB 를 연다 (없으면 만든다). 다 쓰면 close() */
export async function openStore(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    throw new Error(`superlite ticket needs Node 22.5 or later on this machine (it has ${process.version})`);
  }
  // 새 DB 는 옆 임시 파일에 WAL·스키마까지 만든 뒤 링크로 놓는다 — 갓 만든 파일을 여럿이 동시에 WAL 로 바꾸면 SQLite 가 기다리지 않고 locked 로 실패한다.
  // 링크는 이미 있으면 실패하므로 먼저 놓은 쪽이 이긴다
  if (!fs.existsSync(file)) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (path.basename(dir) === '.superlite' && !fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const tmp = `${file}.${process.pid}.new`;
    try {
      const t = new DatabaseSync(tmp);
      t.exec('PRAGMA journal_mode = WAL');
      migrate(t);
      t.close();
      fs.linkSync(tmp, file);
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    } finally {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    }
  }
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL'); // NORMAL: WAL 에서 권장값. 정전 때 마지막 커밋만 잃을 수 있고 깨지지는 않는다 — 커밋마다 fsync 하면 동시 쓰기에서 기다리던 쪽이 굶는다
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') db.exec('PRAGMA journal_mode = WAL'); // 다른 도구로 만든 파일
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

function migrate(db) {
  if (userVersion(db) === SCHEMA.length) return;
  tx(db, () => {
    const v = userVersion(db); // 잠근 뒤 다시 본다 — 다른 세션이 먼저 옮겼을 수 있다
    if (v > SCHEMA.length) throw new Error(`the ticket DB is schema ${v}, newer than this plugin knows (${SCHEMA.length}): update the orchestration plugin`);
    for (let i = v; i < SCHEMA.length; i++) db.exec(SCHEMA[i]);
    db.exec(`PRAGMA user_version = ${SCHEMA.length}`);
  });
}

/** 쓰기 트랜잭션 — 처음부터 쓰기 잠금을 잡아 읽고 판단한 사이에 다른 세션이 끼지 않게 한다 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- id: YYMMDD-xxxx (초안 3절)

const pad2 = (n) => String(n).padStart(2, '0');
const datePrefix = (d) => `${pad2(d.getFullYear() % 100)}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
const isPkClash = (e) => e?.errcode === 1555; // SQLITE_CONSTRAINT_PRIMARYKEY

/** insert(id) 가 성공하는 id 를 찾는다 — INSERT 한 번이 확인과 차지를 겸한다. 무작위 30번 뒤에는 마지막 수에서 1씩 올린다 (0xffff 다음은 5자리) */
export function issueId(insert, now = new Date(), rand = () => randomInt(0x10000)) {
  const pre = datePrefix(now);
  const tryId = (n) => {
    const id = `${pre}-${n.toString(16).padStart(4, '0')}`;
    try {
      insert(id);
      return id;
    } catch (e) {
      if (isPkClash(e)) return null;
      throw e;
    }
  };
  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = rand();
    const id = tryId(n);
    if (id !== null) return id;
  }
  for (;;) {
    n++;
    const id = tryId(n);
    if (id !== null) return id;
  }
}

// ---- milestone 범위와 릴리스 가능 (대시보드도 쓴다)

/** milestone 범위 — 직접 붙인 ticket 과 그 depends 를 따라간 선행 ticket 전부. [{ id, title, status, direct }] */
export function milestoneScope(db, milestone) {
  return db.prepare(`
    WITH RECURSIVE s(id) AS (
      SELECT ticket FROM milestone_ticket WHERE milestone = ?
      UNION SELECT d.depends FROM ticket_depends d JOIN s ON d.ticket = s.id
    )
    SELECT t.id, t.title, t.status, EXISTS (SELECT 1 FROM milestone_ticket m WHERE m.milestone = ? AND m.ticket = t.id) AS direct
    FROM s JOIN ticket t ON t.id = s.id ORDER BY t.id`).all(milestone, milestone).map((r) => ({ ...r, direct: r.direct === 1 }));
}

/** 릴리스 가능한 milestone 의 id — open 이고, 범위가 비어 있지 않고, 범위가 모두 done·dropped */
export function releasableMilestones(db) {
  return db.prepare("SELECT id FROM milestone WHERE status = 'open' ORDER BY ord").all().map((r) => r.id).filter((id) => {
    const scope = milestoneScope(db, id);
    return scope.length > 0 && scope.every((t) => isFinished(t.status));
  });
}

/** fn 을 한 트랜잭션으로 돌리고 { result, released } — released 는 이번에 새로 릴리스 가능해진 milestone id (알림은 호출한 쪽 몫) */
function withNewlyReleasable(db, fn) {
  return tx(db, () => {
    const before = new Set(releasableMilestones(db));
    const result = fn();
    return { result, released: releasableMilestones(db).filter((id) => !before.has(id)) };
  });
}

const inAnyScope = (db, ticket) => db.prepare(`
  WITH RECURSIVE s(id) AS (
    SELECT ticket FROM milestone_ticket
    UNION SELECT d.depends FROM ticket_depends d JOIN s ON d.ticket = s.id
  )
  SELECT 1 AS x FROM s WHERE id = ?`).get(ticket) !== undefined;

// ---- ticket

const nowIso = () => new Date().toISOString();

function mustTicket(db, id) {
  const t = db.prepare('SELECT * FROM ticket WHERE id = ?').get(id);
  if (t === undefined) throw new Error(`unknown ticket: ${id}`);
  return t;
}
function mustMilestone(db, id) {
  const m = db.prepare('SELECT * FROM milestone WHERE id = ?').get(id);
  if (m === undefined) throw new Error(`unknown milestone: ${id}`);
  return m;
}
function checkChoice(name, value, allowed) {
  if (!allowed.includes(value)) throw new Error(`${name} "${value}": use ${allowed.join(' | ')}`);
}

/** ticket 이 (재귀적으로) 기대는 것 — 고리 검사용 */
const dependsClosure = (db, id) => new Set(db.prepare(`
  WITH RECURSIVE s(id) AS (SELECT depends FROM ticket_depends WHERE ticket = ? UNION SELECT d.depends FROM ticket_depends d JOIN s ON d.ticket = s.id)
  SELECT id FROM s`).all(id).map((r) => r.id));

function addDepends(db, id, dep) {
  mustTicket(db, dep);
  if (dep === id || dependsClosure(db, dep).has(id)) throw new Error(`${id} cannot depend on ${dep}: that makes a loop`);
  db.prepare('INSERT OR IGNORE INTO ticket_depends (ticket, depends) VALUES (?, ?)').run(id, dep);
}

/** 새 ticket — id 를 돌려준다. milestone 을 주면 거기 붙인다 */
export function createTicket(db, { title, lane = null, priority = 'normal', depends = [], repos = [], milestone = null, todo = '', reason = '' }, now = new Date()) {
  if (title.trim() === '') throw new Error('title is empty');
  checkChoice('priority', priority, PRIORITIES);
  return tx(db, () => {
    if (milestone !== null) mustMilestone(db, milestone);
    const ins = db.prepare("INSERT INTO ticket (id, title, status, priority, lane, todo, reason, created) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)");
    const id = issueId((cand) => ins.run(cand, title.trim(), priority, lane, todo, reason, now.toISOString()), now);
    for (const d of depends) addDepends(db, id, d);
    for (const r of repos) db.prepare('INSERT OR IGNORE INTO ticket_repo (ticket, repo) VALUES (?, ?)').run(id, r);
    if (milestone !== null) db.prepare('INSERT INTO milestone_ticket (milestone, ticket) VALUES (?, ?)').run(milestone, id);
    return id;
  });
}

/** 담당 칸 — assignees 는 브랜치(대시보드·필터가 쓰는 꼴), assigneeSessions 는 같은 순서의 { branch, session(claim 한 세션 id 또는 null) } */
function assigneeFields(db, id) {
  const rows = db.prepare('SELECT session, session_id FROM ticket_assignee WHERE ticket = ? ORDER BY session').all(id);
  return { assignees: rows.map((r) => r.session), assigneeSessions: rows.map((r) => ({ branch: r.session, session: r.session_id })) };
}

/** 한 ticket 의 전부 — 칸, depends·dependents(그 ticket 을 기다리는 것), assignee, repo, milestone(직접 붙은 것), 진행 기록 */
export function getTicket(db, id) {
  const t = mustTicket(db, id);
  const col = (sql) => db.prepare(sql).all(id);
  return {
    ...t,
    depends: col('SELECT t.id, t.title, t.status FROM ticket_depends d JOIN ticket t ON t.id = d.depends WHERE d.ticket = ? ORDER BY t.id'),
    dependents: col('SELECT t.id, t.title, t.status FROM ticket_depends d JOIN ticket t ON t.id = d.ticket WHERE d.depends = ? ORDER BY t.id'),
    ...assigneeFields(db, id),
    repos: col('SELECT repo FROM ticket_repo WHERE ticket = ? ORDER BY repo').map((r) => r.repo),
    milestones: col('SELECT m.id, m.title, m.status, mt.auto FROM milestone_ticket mt JOIN milestone m ON m.id = mt.milestone WHERE mt.ticket = ? ORDER BY m.ord'),
    log: col('SELECT at, session, text FROM ticket_log WHERE ticket = ? ORDER BY at, rowid'),
  };
}

/** ticket 목록 — status 는 배열(없으면 끝나지 않은 것), milestone 은 그 범위. 각 행에 assignees 를 붙인다 */
export function listTickets(db, { lane = null, status = null, assignee = null, milestone = null } = {}) {
  const statuses = status ?? STATUSES.filter((s) => !isFinished(s));
  for (const s of statuses) checkChoice('status', s, STATUSES);
  let rows = db.prepare(`SELECT * FROM ticket WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`).all(...statuses);
  if (lane !== null) rows = rows.filter((t) => t.lane === lane);
  if (milestone !== null) {
    mustMilestone(db, milestone);
    const scope = new Set(milestoneScope(db, milestone).map((t) => t.id));
    rows = rows.filter((t) => scope.has(t.id));
  }
  rows = rows.map((t) => ({ ...t, ...assigneeFields(db, t.id) }));
  return assignee === null ? rows : rows.filter((t) => t.assignees.includes(assignee));
}

/** status 를 바꾼다 (트랜잭션 안에서 부른다). done 이 되면 어느 milestone 범위에도 없는 ticket 을 다음 milestone(open 중 ord 최저)에 붙이고 그 id 를 돌려준다 */
function applyStatus(db, t, status) {
  checkChoice('status', status, STATUSES);
  if (t.status === status) return null;
  const closed = isFinished(status) ? (isFinished(t.status) ? t.closed : nowIso()) : null;
  db.prepare('UPDATE ticket SET status = ?, closed = ? WHERE id = ?').run(status, closed, t.id);
  if (status !== 'done' || inAnyScope(db, t.id)) return null;
  const next = db.prepare("SELECT id FROM milestone WHERE status = 'open' ORDER BY ord LIMIT 1").get();
  if (next === undefined) return null;
  db.prepare('INSERT INTO milestone_ticket (milestone, ticket, auto) VALUES (?, ?, 1)').run(next.id, t.id);
  return next.id;
}

/**
 * ticket 을 고친다. fields: title·status·priority·lane·todo·reason, add·remove: { assignee, depends, repo } 의 배열.
 * { attached: done 때 붙은 milestone 또는 null, released: 새로 릴리스 가능해진 milestone id }
 */
export function updateTicket(db, id, { fields = {}, add = {}, remove = {} } = {}) {
  const { result, released } = withNewlyReleasable(db, () => {
    const t = mustTicket(db, id);
    if (fields.title !== undefined && fields.title.trim() === '') throw new Error('title is empty');
    if (fields.priority !== undefined) checkChoice('priority', fields.priority, PRIORITIES);
    for (const k of ['title', 'priority', 'lane', 'todo', 'reason']) {
      if (fields[k] !== undefined) db.prepare(`UPDATE ticket SET ${k} = ? WHERE id = ?`).run(k === 'title' ? fields[k].trim() : fields[k], id);
    }
    for (const a of add.assignee ?? []) db.prepare('INSERT OR IGNORE INTO ticket_assignee (ticket, session) VALUES (?, ?)').run(id, a);
    for (const a of remove.assignee ?? []) db.prepare('DELETE FROM ticket_assignee WHERE ticket = ? AND session = ?').run(id, a);
    for (const d of add.depends ?? []) addDepends(db, id, d);
    for (const d of remove.depends ?? []) db.prepare('DELETE FROM ticket_depends WHERE ticket = ? AND depends = ?').run(id, d);
    for (const r of add.repo ?? []) db.prepare('INSERT OR IGNORE INTO ticket_repo (ticket, repo) VALUES (?, ?)').run(id, r);
    for (const r of remove.repo ?? []) db.prepare('DELETE FROM ticket_repo WHERE ticket = ? AND repo = ?').run(id, r);
    return fields.status === undefined ? null : applyStatus(db, t, fields.status);
  });
  return { attached: result, released };
}

/** ticket claim — branch 를 담당에 더하고(이미 있으면 세션 id 만 새 값으로) open·hold 면 active 로 바꾼다. session 은 slcode 세션 id 또는 null. 끝난 ticket 은 거절한다 */
export function claimTicket(db, id, branch, session) {
  tx(db, () => {
    const t = mustTicket(db, id);
    if (isFinished(t.status)) throw new Error(`ticket ${id} is ${t.status}: only an unfinished ticket can be claimed`);
    db.prepare('INSERT INTO ticket_assignee (ticket, session, session_id) VALUES (?, ?, ?) ON CONFLICT (ticket, session) DO UPDATE SET session_id = excluded.session_id').run(id, branch, session);
    applyStatus(db, t, 'active'); // active 가 되어도 끝난 것은 늘지 않아 릴리스 가능은 그대로다
  });
}

/** worker done --close·--abandon — 그 브랜치 담당의 세션 id 만 비운다. 브랜치는 이력으로 남는다 */
export function clearAssigneeSessions(db, branch) {
  tx(db, () => db.prepare('UPDATE ticket_assignee SET session_id = NULL WHERE session = ?').run(branch));
}

/** 진행 기록 한 줄 — session 은 쓴 워커의 브랜치 (모르면 null) */
export function addLog(db, id, session, text) {
  if (text.trim() === '') throw new Error('log text is empty');
  tx(db, () => {
    mustTicket(db, id);
    db.prepare('INSERT INTO ticket_log (ticket, at, session, text) VALUES (?, ?, ?, ?)').run(id, nowIso(), session, text);
  });
}

// ---- milestone

export function createMilestone(db, { title, order, goal = '' }, now = new Date()) {
  if (title.trim() === '') throw new Error('title is empty');
  if (!Number.isInteger(order)) throw new Error('--order must be an integer (lower comes first)');
  return tx(db, () => {
    const clash = db.prepare('SELECT id FROM milestone WHERE ord = ?').get(order);
    if (clash !== undefined) throw new Error(`order ${order} is taken by milestone ${clash.id}`);
    const ins = db.prepare("INSERT INTO milestone (id, title, ord, status, goal, created) VALUES (?, ?, ?, 'open', ?, ?)");
    return issueId((cand) => ins.run(cand, title.trim(), order, goal, now.toISOString()), now);
  });
}

/** milestone 하나에 범위의 진행을 붙인다 — { ...칸, scope, done(끝난 수), releasable } */
function withProgress(db, m) {
  const scope = milestoneScope(db, m.id);
  const done = scope.filter((t) => isFinished(t.status)).length;
  return { ...m, scope, done, releasable: m.status === 'open' && scope.length > 0 && done === scope.length };
}

export const listMilestones = (db) => db.prepare('SELECT * FROM milestone ORDER BY ord').all().map((m) => withProgress(db, m));
export const getMilestone = (db, id) => withProgress(db, mustMilestone(db, id));

/** 직접 붙인다 — { released } */
export function addToMilestone(db, id, tickets) {
  return withNewlyReleasable(db, () => {
    mustMilestone(db, id);
    for (const t of tickets) {
      mustTicket(db, t);
      db.prepare('INSERT OR IGNORE INTO milestone_ticket (milestone, ticket) VALUES (?, ?)').run(id, t);
    }
  });
}

/** 직접 붙인 것을 뗀다 — 범위에서 빠지면 남은 것이 모두 끝나 릴리스 가능해질 수 있다. { released } */
export function removeFromMilestone(db, id, tickets) {
  return withNewlyReleasable(db, () => {
    mustMilestone(db, id);
    for (const t of tickets) {
      if (db.prepare('DELETE FROM milestone_ticket WHERE milestone = ? AND ticket = ?').run(id, t).changes === 0) throw new Error(`${t} is not attached to ${id} directly`);
    }
  });
}

/** 릴리스로 닫는다 — 범위에 끝나지 않은 ticket 이 있으면 거절한다 */
export function releaseMilestone(db, id) {
  tx(db, () => {
    const m = withProgress(db, mustMilestone(db, id));
    if (m.status === 'released') throw new Error(`milestone ${id} is already released`);
    const left = m.scope.filter((t) => !isFinished(t.status));
    if (left.length > 0) throw new Error(`milestone ${id} has unfinished tickets: ${left.map((t) => `${t.id} (${t.status})`).join(', ')}. Finish or drop them, or detach them with: superlite ticket milestone remove ${id} <ticket...>`);
    db.prepare("UPDATE milestone SET status = 'released', released = ? WHERE id = ?").run(nowIso(), id);
  });
}

// ---- 대시보드 (ticket orchestration-dashboard)

/** 대시보드가 한 번에 읽는 것 — ticket 전부(assignees·depends 를 붙이고 본문은 뺀다), milestone 전부(listMilestones 의 범위·진행), milestone_ticket 행(auto 포함).
 *  읽기 트랜잭션(BEGIN)으로 한 시점의 모습을 본다 — 몇 초마다 읽으므로 쓰기 잠금(tx)을 잡지 않는다 */
export function snapshot(db) {
  db.exec('BEGIN');
  try {
    const depends = db.prepare('SELECT ticket, depends FROM ticket_depends ORDER BY depends').all();
    const tickets = listTickets(db, { status: STATUSES }).map(({ todo, reason, ...t }) => ({ ...t, depends: depends.filter((d) => d.ticket === t.id).map((d) => d.depends) }));
    return { tickets, milestones: listMilestones(db), links: db.prepare('SELECT milestone, ticket, auto FROM milestone_ticket ORDER BY rowid').all() };
  } finally {
    db.exec('COMMIT');
  }
}
