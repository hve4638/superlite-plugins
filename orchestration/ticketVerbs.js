// superlite ticket 동사 (ticket orchestration-ticket-store) — 저장소는 tickets.js. 동사마다 DB 를 열고 닫는다 (cwd 마다 저장소가 다를 수 있다).
//
// 데몬은 `superlite ticket <하위>` 를 ticket.<하위> 로 한 단계만 가른다 — milestone 의 동작(new·ls·show·add·remove·release)은 ticket.milestone 이 다시 가른다.
// 셸의 표준 입력은 동사에 오지 않는다 — 본문은 --todo/--reason 값으로 받는다 (초안의 `--todo -` 대신. 여러 줄은 셸 인용으로).
// edit: 본문을 DB 옆 ticket-edit/<id>.md 로 꺼내 창의 편집기(내장 동사 open)로 열고, 이 main 이 그 파일을 지켜보다 저장될 때마다 DB 에 넣는다.
// 창이 없으면 경로만 알린다 — 다른 편집기로 고쳐 저장해도 같다. 지켜보기는 main 이 다시 뜨면 끝난다 (그때는 edit 를 다시 친다).
// show 의 커밋은 cwd 저장소의 git log --all 에서 `Ticket: <id>` trailer 로 찾는다 — DB 에는 커밋을 적지 않는다.
// claim: 워커가 일을 시작할 때 친다 (ticket orchestration-ticket-claim, 사용자 2026-11-13). 이 셸의 브랜치와 SLCODE_SESSION_ID 를 담당에 적고 show 와 같은 본문을 낸다.
// ls·show 의 담당 표시(live `*`, missing `?`)는 assigneeLive 하나가 정한다 — 대시보드도 이것을 쓴다. 완료 처리(ticket done)는 leader 몫이라 역할 지침에 적고 동사로 막지 않는다.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './tickets.js';

const list = (s) => (typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter((x) => x !== '') : []);
const words = (a) => (Array.isArray(a) ? a.join(' ') : String(a ?? ''));

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** 이 폴더의 브랜치 — assignee·log 의 session 값. 저장소 밖이거나 분리된 HEAD 면 null */
export async function branchOf(cwd) {
  const b = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return b && b !== 'HEAD' ? b : null;
}

/** `Ticket: <id>` trailer 가 있는 커밋 — 저장소 밖이면 null */
async function commitsOf(cwd, id) {
  const out = await git(cwd, ['log', '--all', '-F', `--grep=${id}`, '--format=%h%x1f%as%x1f%s%x1f%(trailers:key=Ticket,valueonly,separator=%x1e)%x1d']);
  if (out === null) return null;
  return out.split('\x1d').map((r) => r.trim().split('\x1f')).filter((f) => f.length === 4 && f[3].split('\x1e').map((x) => x.trim()).includes(id))
    .map(([hash, date, subject]) => `${hash} ${date} ${subject}`);
}

async function withStore(ctx, fn) {
  const { file } = store.findStore(ctx.cwd, ctx.env);
  const db = await store.openStore(file);
  try {
    return await fn(db, file);
  } finally {
    db.close();
  }
}

/** 열 맞춤 표 — 마지막 열은 늘이지 않는다 */
function table(rows) {
  if (rows.length === 0) return '';
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? String(c) : String(c).padEnd(w[i]))).join('  ').trimEnd()).join('\n');
}

const releasedNote = (ids) => (ids.length > 0 ? [`releasable now: ${ids.map((id) => `milestone ${id}`).join(', ')}`] : []);

/** set 의 바꿀 칸 — key=value, key+=a,b, key-=a,b */
const SCALAR = ['title', 'status', 'priority', 'lane'];
const MULTI = { assignee: 'assignee', depends: 'depends', repo: 'repo', repos: 'repo' };
function parseChanges(items) {
  const fields = {}, add = {}, remove = {};
  for (const item of items) {
    const m = /^([a-z]+)([+-]?)=(.*)$/s.exec(item);
    if (m === null) throw new Error(`"${item}": write key=value, key+=value or key-=value`);
    const [, key, op, value] = m;
    if (SCALAR.includes(key) && op === '') fields[key] = key === 'lane' && value === '' ? null : value;
    else if (MULTI[key] !== undefined && op !== '') {
      const into = op === '+' ? add : remove;
      into[MULTI[key]] = [...(into[MULTI[key]] ?? []), ...list(value)];
    } else throw new Error(`"${item}": ${SCALAR.join(', ')} take =, ${Object.keys(MULTI).join(', ')} take += or -=`);
  }
  return { fields, add, remove };
}

/** show 의 담당 한 칸 — feat-x (live, session abc123), 따지지 않는 담당은 브랜치만 */
const assigneeText = (a) => (a.live === null ? a.branch : `${a.branch} (${a.live ? 'live' : 'missing'}, session ${a.session})`);

/** ls 의 담당 한 칸 — live 는 *, missing 은 ? */
const assigneeMark = (a) => `${a.branch}${a.live === true ? '*' : a.live === false ? '?' : ''}`;

/** live: assigneeLive 가 돌려준 이 ticket 의 담당 */
function showTicket(t, live, commits) {
  const ref = (r) => `${r.id} (${r.status}) ${r.title}`;
  const out = [
    `${t.id}  ${t.title}`,
    `status ${t.status} · priority ${t.priority}${t.lane ? ` · lane ${t.lane}` : ''}`,
    `created ${t.created}${t.closed ? ` · closed ${t.closed}` : ''}`,
  ];
  if (t.repos.length > 0) out.push(`repos: ${t.repos.join(', ')}`);
  if (live.length > 0) out.push(`assignee: ${live.map(assigneeText).join(', ')}`);
  if (t.milestones.length > 0) out.push(`milestone: ${t.milestones.map((m) => `${m.id} ${m.title}${m.auto ? ' (attached at done)' : ''}`).join(', ')}`);
  if (t.depends.length > 0) out.push('depends:', ...t.depends.map((r) => `  ${ref(r)}`));
  if (t.dependents.length > 0) out.push('needed by:', ...t.dependents.map((r) => `  ${ref(r)}`));
  out.push('', '## todo', t.todo.trim() || '(empty)', '', '## reason', t.reason.trim() || '(empty)');
  if (t.log.length > 0) out.push('', '## log', ...t.log.map((l) => `${l.at}${l.session ? ` ${l.session}` : ''}  ${l.text}`));
  out.push('', '## commits', ...(commits === null ? ['(not in a git repository)'] : commits.length === 0 ? ['(none with this Ticket: trailer)'] : commits));
  return out.join('\n');
}

function showMilestone(m) {
  const out = [
    `${m.id}  ${m.title}`,
    `order ${m.ord} · ${m.status}${m.released ? ` ${m.released}` : ''} · ${m.done}/${m.scope.length} finished${m.releasable ? ' · releasable' : ''}`,
  ];
  if (m.goal.trim() !== '') out.push('', m.goal.trim());
  if (m.scope.length > 0) out.push('', table(m.scope.map((t) => [t.id, t.status, t.direct ? '' : '(via depends)', t.title])));
  return out.join('\n');
}

// ---- edit: 임시 마크다운 ↔ 본문

export const editText = (t) => `# ${t.title}\n\n## todo\n\n${t.todo.trim()}\n\n## reason\n\n${t.reason.trim()}\n`;

/** editText 의 역 — 제목 줄과 두 절 머리는 그대로 둬야 한다 */
export function parseEditText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const title = /^# (.*)$/.exec(lines[0] ?? '')?.[1]?.trim();
  const ti = lines.indexOf('## todo'), ri = lines.indexOf('## reason');
  if (!title || ti < 0 || ri < ti) throw new Error('keep the first line "# <title>" and the "## todo" and "## reason" headings in this order');
  return { title, todo: lines.slice(ti + 1, ri).join('\n').trim(), reason: lines.slice(ri + 1).join('\n').trim() };
}

/** 파일 → 지켜보기. 같은 파일을 다시 edit 하면 지켜보기를 새로 건다 */
const watching = new Map();
function watchEdit(api, ctx, dbFile, id, file) {
  watching.get(file)?.close();
  let last = fs.readFileSync(file, 'utf8');
  let timer = null;
  const apply = async () => {
    if (!fs.existsSync(file)) {
      watcher.close();
      watching.delete(file);
      return;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (text === last) return;
    last = text;
    try {
      const fields = parseEditText(text);
      const db = await store.openStore(dbFile);
      try {
        store.updateTicket(db, id, { fields });
      } finally {
        db.close();
      }
    } catch (e) {
      api.notify('error', `ticket ${id}: not saved — ${e instanceof Error ? e.message : String(e)}`, { tmux: ctx.tmux });
    }
  };
  // 폴더를 지켜본다 — 편집기가 새 파일로 바꿔 쓰면 파일 하나의 지켜보기는 끊긴다
  const watcher = fs.watch(path.dirname(file), (_, name) => {
    if (name !== path.basename(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void apply(), 100);
  });
  watching.set(file, watcher);
}

// ---- worker done --submit 의 Ticket trailer

/** 메시지 끝에 ids 의 `Ticket: <id>` 줄을 더한다 — 이미 적힌 id 는 건너뛰고, 끝 문단이 trailer 묶음이면 그 묶음에 잇는다 */
export function addTicketTrailers(message, ids) {
  const have = new Set([...message.matchAll(/^Ticket:\s*(\S+)\s*$/gm)].map((m) => m[1]));
  const add = ids.filter((id) => !have.has(id));
  if (add.length === 0) return message;
  const body = message.trimEnd();
  const paras = body.split(/\n[ \t]*\n/);
  const inBlock = paras.length > 1 && paras.at(-1).split('\n').every((l) => /^[A-Za-z0-9-]+:\s/.test(l));
  return `${body}${inBlock ? '\n' : '\n\n'}${add.map((id) => `Ticket: ${id}`).join('\n')}\n`;
}

/** 이 셸이 쓰는 저장소 파일 — 저장소를 못 찾거나 파일이 아직 없으면 null (worker done 이 빈 DB 를 만들지 않게) */
export function existingStore(ctx) {
  try {
    const { file } = store.findStore(ctx.cwd, ctx.env);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** 이 브랜치가 assignee 인, 끝나지 않은 ticket 의 trailer 를 붙인 메시지와 출력에 남길 줄. 저장소가 없으면 그대로, 저장소를 열지 못하면 붙이지 않고 사유만 알린다 (제출은 막지 않는다) */
export async function withTicketTrailers(ctx, branch, message) {
  const file = existingStore(ctx);
  if (file === null) return { message, note: '' };
  let ids;
  try {
    const db = await store.openStore(file);
    try {
      ids = store.listTickets(db, { assignee: branch }).map((t) => t.id);
    } finally {
      db.close();
    }
  } catch (e) {
    return { message, note: `no Ticket trailer: ${e instanceof Error ? e.message : String(e)}` };
  }
  const next = addTicketTrailers(message, ids);
  return { message: next, note: next === message ? '' : `Ticket trailer: ${ids.join(', ')}` };
}

/** worker done --close·--abandon 이 자리를 지운 뒤 — 이 브랜치 담당의 세션 id 를 비운다. file 은 지우기 전에 existingStore 로 찾아 둔다 (지운 cwd 에서는
 *  그 안의 .ticket 을 못 찾는다). 실패는 지우기를 되돌리지 않고 출력에 남길 줄로 돌려준다 */
export async function clearTicketSessions(file, branch) {
  if (file === null) return '';
  try {
    const db = await store.openStore(file);
    try {
      store.clearAssigneeSessions(db, branch);
    } finally {
      db.close();
    }
    return '';
  } catch (e) {
    return `ticket assignee session not cleared: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---- 담당 세션의 live·missing (구상 orchestration-ticket-assignee-live D)

/** slcode 의 살아 있는 세션, id → 행. slcode 플러그인이 list 를 export 하지 않는 옛 판이거나 목록을 못 읽으면 null (표시만 빠지고 동사는 산다) */
async function aliveSessions(api) {
  const list = api.plugins.get('slcode')?.list;
  if (typeof list !== 'function') return null;
  try {
    return new Map((await list()).map((s) => [s.id, s]));
  } catch (e) {
    console.error(`orchestration: slcode list: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * ticket 마다 담당의 살아 있음 — [{ branch, session, live, state }] 를 tickets 순서대로. tickets 는 listTickets·getTicket 의 행(assigneeSessions 를 쓴다).
 * live: true 는 세션 id 가 slcode 의 살아 있는 목록에 있음, false 는 없음(missing), null 은 따지지 않음(세션 id 기록이 없다, 끝난 ticket, 목록을 모른다).
 * state 는 살아 있는 세션의 slcode 상태. 따질 담당이 없으면 slcode 를 부르지 않는다
 * @param {import('@superlite/plugin').MainApi} api
 */
export async function assigneeLive(api, tickets) {
  const asks = (t) => !store.isFinished(t.status) && t.assigneeSessions.some((a) => a.session !== null);
  const alive = tickets.some(asks) ? await aliveSessions(api) : null;
  return tickets.map((t) => t.assigneeSessions.map(({ branch, session }) => {
    if (alive === null || session === null || store.isFinished(t.status)) return { branch, session, live: null, state: null };
    const row = alive.get(session);
    return { branch, session, live: row !== undefined, state: row?.state ?? null };
  }));
}

/** show·claim 의 본문 */
async function showBody(api, ctx, t) {
  const [live] = await assigneeLive(api, [t]);
  return showTicket(t, live, await commitsOf(ctx.cwd, t.id));
}

/** @param {import('@superlite/plugin').MainApi} api */
export function handleTicketVerbs(api) {
  // 하위 동사 목록 — plugin.json 의 선언에서 만든다. `superlite ticket --help` 는 데몬이 가로채 이 동사의 help 를 보인다
  api.verbs.handle('ticket', async () => {
    const verbs = JSON.parse(await api.folder.read('plugin.json')).verbs.filter((v) => v.name.startsWith('ticket.'));
    return [table(verbs.map((v) => [`superlite ${v.name.replace('.', ' ')}`, v.help])), '', 'superlite ticket <command> --help explains its arguments.'].join('\n');
  });

  api.verbs.handle('ticket.root', async (a, ctx) => {
    const { file, via } = store.findStore(ctx.cwd, ctx.env);
    return `${file}${fs.existsSync(file) ? '' : ' (created on first use)'}\nfrom ${via}`;
  });

  api.verbs.handle('ticket.new', (a, ctx) => withStore(ctx, (db) => store.createTicket(db, {
    title: words(a.title),
    lane: a.lane ?? null,
    priority: a.priority ?? 'normal',
    depends: list(a.depends),
    repos: list(a.repos),
    milestone: a.milestone ?? null,
    todo: a.todo ?? '',
    reason: a.reason ?? '',
  })));

  api.verbs.handle('ticket.ls', (a, ctx) => withStore(ctx, async (db) => {
    const status = a.status === undefined ? null : a.status === 'all' ? store.STATUSES : list(a.status);
    const rows = store.listTickets(db, { lane: a.lane ?? null, status, assignee: a.assignee ?? null, milestone: a.milestone ?? null });
    if (rows.length === 0) return 'no tickets';
    const live = await assigneeLive(api, rows);
    return table(rows.map((t, i) => [t.id, t.status, t.priority, t.lane ?? '-', live[i].map(assigneeMark).join(',') || '-', t.title]));
  }));

  api.verbs.handle('ticket.show', (a, ctx) => withStore(ctx, (db) => showBody(api, ctx, store.getTicket(db, a.id))));

  api.verbs.handle('ticket.claim', (a, ctx) => withStore(ctx, async (db) => {
    const branch = await branchOf(ctx.cwd);
    if (branch === null) throw new Error('ticket claim records the branch of this folder: run it in a git workspace on a branch');
    store.claimTicket(db, a.id, branch, ctx.env.SLCODE_SESSION_ID || null);
    return showBody(api, ctx, store.getTicket(db, a.id));
  }));

  api.verbs.handle('ticket.set', (a, ctx) => withStore(ctx, (db) => {
    const changes = parseChanges(a.changes ?? []);
    if (a.todo !== undefined) changes.fields.todo = a.todo;
    if (a.reason !== undefined) changes.fields.reason = a.reason;
    if (Object.keys(changes.fields).length + Object.keys(changes.add).length + Object.keys(changes.remove).length === 0) throw new Error('nothing to change: give key=value, key+=value, key-=value, --todo or --reason');
    const { attached, released } = store.updateTicket(db, a.id, changes);
    return [`${a.id} updated`, ...(attached ? [`attached to milestone ${attached}`] : []), ...releasedNote(released)].join('\n');
  }));

  for (const [verb, status] of [['ticket.done', 'done'], ['ticket.drop', 'dropped']]) {
    api.verbs.handle(verb, (a, ctx) => withStore(ctx, (db) => {
      const { attached, released } = store.updateTicket(db, a.id, { fields: { status } });
      return [`${a.id} ${status}`, ...(attached ? [`attached to milestone ${attached}`] : []), ...releasedNote(released)].join('\n');
    }));
  }

  api.verbs.handle('ticket.log', (a, ctx) => withStore(ctx, async (db) => {
    store.addLog(db, a.id, await branchOf(ctx.cwd), words(a.text));
    return `logged on ${a.id}`;
  }));

  api.verbs.handle('ticket.edit', (a, ctx) => withStore(ctx, async (db, dbFile) => {
    const t = store.getTicket(db, a.id);
    const file = path.join(path.dirname(dbFile), 'ticket-edit', `${t.id}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, editText(t));
    watchEdit(api, ctx, dbFile, t.id, file);
    const opened = await api.verbs.run('open', [file], ctx).then(() => true, () => false);
    return `${opened ? 'opened' : 'edit'} ${file} — each save updates ${t.id}`;
  }));

  api.verbs.handle('ticket.milestone', (a, ctx) => withStore(ctx, (db) => {
    const args = a.args ?? [];
    const need = (n, usage) => {
      if (args.length < n) throw new Error(`usage: superlite ticket milestone ${usage}`);
    };
    switch (a.action) {
      case 'new': {
        need(1, 'new <title...> --order <n> [--goal <text>]');
        if (a.order === undefined) throw new Error('milestone new needs --order <n> (lower comes first)');
        return store.createMilestone(db, { title: args.join(' '), order: Number(a.order), goal: a.goal ?? '' });
      }
      case 'ls': {
        const ms = store.listMilestones(db);
        if (ms.length === 0) return 'no milestones';
        return table(ms.map((m) => [m.id, m.ord, m.releasable ? 'releasable' : m.status, `${m.done}/${m.scope.length}`, m.title]));
      }
      case 'show':
        need(1, 'show <id>');
        return showMilestone(store.getMilestone(db, args[0]));
      case 'add':
      case 'remove': {
        need(2, `${a.action} <id> <ticket...>`);
        const fn = a.action === 'add' ? store.addToMilestone : store.removeFromMilestone;
        const { released } = fn(db, args[0], args.slice(1));
        return [`${a.action === 'add' ? 'added to' : 'removed from'} ${args[0]}: ${args.slice(1).join(', ')}`, ...releasedNote(released)].join('\n');
      }
      case 'release':
        need(1, 'release <id>');
        store.releaseMilestone(db, args[0]);
        return `milestone ${args[0]} released`;
      default:
        throw new Error(`unknown milestone action "${a.action}": use new, ls, show, add, remove or release`);
    }
  }));
}
