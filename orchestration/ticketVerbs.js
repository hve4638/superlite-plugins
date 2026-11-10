// superlite ticket 동사 (ticket orchestration-ticket-store) — 저장소는 tickets.js. 동사마다 DB 를 열고 닫는다 (cwd 마다 저장소가 다를 수 있다).
//
// 데몬은 `superlite ticket <하위>` 를 ticket.<하위> 로 한 단계만 가른다 — milestone 의 동작(new·ls·show·add·remove·release)은 ticket.milestone 이 다시 가른다.
// 셸의 표준 입력은 동사에 오지 않는다 — 본문은 --todo/--reason 값으로 받는다 (초안의 `--todo -` 대신. 여러 줄은 셸 인용으로).
// edit: 본문을 DB 옆 ticket-edit/<id>.md 로 꺼내 창의 편집기(내장 동사 open)로 열고, 이 main 이 그 파일을 지켜보다 저장될 때마다 DB 에 넣는다.
// 창이 없으면 경로만 알린다 — 다른 편집기로 고쳐 저장해도 같다. 지켜보기는 main 이 다시 뜨면 끝난다 (그때는 edit 를 다시 친다).
// show 의 커밋은 cwd 저장소의 git log --all 에서 `Ticket: <id>` trailer 로 찾는다 — DB 에는 커밋을 적지 않는다.

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

function showTicket(t, commits) {
  const ref = (r) => `${r.id} (${r.status}) ${r.title}`;
  const out = [
    `${t.id}  ${t.title}`,
    `status ${t.status} · priority ${t.priority}${t.lane ? ` · lane ${t.lane}` : ''}`,
    `created ${t.created}${t.closed ? ` · closed ${t.closed}` : ''}`,
  ];
  if (t.repos.length > 0) out.push(`repos: ${t.repos.join(', ')}`);
  if (t.assignees.length > 0) out.push(`assignee: ${t.assignees.join(', ')}`);
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

  api.verbs.handle('ticket.ls', (a, ctx) => withStore(ctx, (db) => {
    const status = a.status === undefined ? null : a.status === 'all' ? store.STATUSES : list(a.status);
    const rows = store.listTickets(db, { lane: a.lane ?? null, status, assignee: a.assignee ?? null, milestone: a.milestone ?? null });
    if (rows.length === 0) return 'no tickets';
    return table(rows.map((t) => [t.id, t.status, t.priority, t.lane ?? '-', t.assignees.join(',') || '-', t.title]));
  }));

  api.verbs.handle('ticket.show', (a, ctx) => withStore(ctx, async (db) => {
    const t = store.getTicket(db, a.id);
    return showTicket(t, await commitsOf(ctx.cwd, t.id));
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
