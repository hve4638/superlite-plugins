// 오케스트레이션 플러그인 (ticket orchestration-plugin, 2026-09-25 사용자 확정; orchestration-plugin-apply 2026-10-23·24 개정).
//
//   superlite orchestrate new <역할> <브랜치> [--preset <이름>] -- <지시문>
//   superlite worker sync
//   superlite worker done --submit [--close] --message <m> | --close | --abandon <키>
//   superlite ticket new|ls|show|set|edit|log|done|drop|milestone|root       (ticket 저장소, ticketVerbs.js·tickets.js)
//   (ticket 동사를 친 셸의 카드에 맡은 ticket 알약을 붙인다 — ticketFloat.js, views/tickets.js)
//
// 역할과 연결선은 사용자가 탭에서 그린다(views/roles.js, storage config). 선의 뜻은 "이 역할이 저 역할을 시작할 수 있다" 하나다 (사용자 2026-11-04).
// 권한 칸은 없다: orchestrate new 는 호출자 역할에서 나가는 선의 대상만, worker 명령은 이 브랜치에 부모 기록이 있을 때만 쓴다 — 세션 트리(실제 부모)와 역할 그래프는 별개다.
// 검사는 동사 거절과 안내까지다. 역할이 없는 slcode 세션은 orchestrate new 를 막지 않는다. 처음 역할은 사용자가 slcode 세션에서
// /superlite:roleas <역할> 로 직접 정한다. 세션 → 역할은 storage `role:<세션 id>` 한 칸씩이다 (여러 세션이 동시에 적어도 서로 덮지 않게).
// 에이전트 쪽은 agent/ 의 애드온(베이스 superlite, sfa 의 에이전트 플러그인)이다 — roleas 명령과 역할 안내 SessionStart 훅. slcode 세션에만 실린다.
// 애드온을 실으려면 slcode 0.5.5 이상이어야 한다 (아직 내부 사용뿐이라 옛 판을 검사하지 않는다, 사용자 결정 2026-11-03).
// 자리·띄우기·부모 관계·메일은 slcode team 에 맡긴다 (ticket orchestration-slcode-team, 사용자 2026-11-11). 플러그인은 합치기·정리 시점·완료 보고·스스로 닫기·역할·ticket 만 한다.
// new 의 흐름: slcode 플러그인의 slcode.team 으로 이 세션의 teammate 를 새 worktree(<repo>.worktrees/<브랜치의 / 를 ->, 브랜치는 이름 그대로)에 띄우고
// 카드를 요청자 옆에 연다. 지시문은 첫 턴이다(안내는 guideOf 주석). teammate 프리셋이라 리더는 관계만 알고 닫힘 알림을 받지 않는다.
// slcode 세션 밖(일반 터미널)의 new 는 거절한다 — slcode.team 은 리더 세션이 있어야 한다 (사용자 2026-11-13). Windows 는 따로 막지 않고 slcode.team 의 거절을 그대로 보인다.
// 메시지는 slcode mail 로 오간다 — 리더는 slcode mail <브랜치>(teammate 이름), 팀원은 slcode mail leader. 그래서 orchestrate message·worker message 동사는 없다 (사용자 2026-11-13).
// 세션은 모든 역할이 전체 액세스(bypassPermissions)로 뜬다 — slcode 기본값 auto 는 저장소 밖 접근에서 승인을 기다리며 멈춘다 (사용자 2026-11-04).
// preset → model 배정표는 설정 탭의 플러그인 절(JSON, 키 이름은 저장값 보존을 위해 assign 그대로)에 있고 모르는 preset 은 거부한다.
// model 은 slcode 의 `<공급자>:<모델>` 꼴이라 벤더도 그 앞머리로 정해진다 (anthropic:·openai:, 사용자 2026-10-24).
// worker done: --submit=부모에 합침(역할의 merge 가 squash·no-ff 를 정한다. 역할이 없는 세션은 방식을 알 수 없어 거절한다, 사용자 2026-11-05), --close=지움(잃을 것이 있으면 거절), 둘 다=합치고 지움,
// --abandon <키>=그 키로 버리고 지움. 지우기는 slcode 의 cleanWorktree(= slcode team clean-worktree --self, 세션은 닫지 않는다)다 — 잃을 작업 판단과 확인 키는 slcode 것이라
// 이 세션 안에서만 된다. ponytail: cleanWorktree 는 harness 에 요청한 export 다 (사용자 2026-11-13, 데몬 PATH 에 slcode 가 없고 dir 설정을 모른다).
// 끝나면 자기를 띄운 세션(new 때의 리더)에 slcode.mail 로 알리고, 자리를 정리했으면 자기 세션을 slcode.close 로 닫는다 — 닫기는 맨 마지막, 이 동사의 결과가 셸에 돌아간 뒤
// (지운 폴더에 세션이 잠깐 남는다. 데몬 쪽 main 이라 PATH 무관).
// --submit 은 이 브랜치가 assignee 인 끝나지 않은 ticket 마다 메시지 끝에 `Ticket: <id>` trailer 를 붙인다 (ticket orchestration-commit-trailer, 사용자 2026-11-10: 지침만도, 거절도 아닌 자동 추가).
// done 은 나중에 ticket 자동 처리를 붙일 입구라 merge·land 동사를 따로 두지 않는다.
//
// 새 방식 플러그인(plugin.json apiVersion 2) — 이 main 은 창이 아니라 세션 머신의 node 에서 돈다. git 은 워크트리가 있는
// 세션 머신에서 돌고, 카드 열기·닫기는 slcode main 이 그 터미널을 연 창에 맡긴다. 설정값(assign)과 workers(팀원 세션 id → 리더 등)는 세션 머신에 저장된다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { exposeTicketFloat, withTicketFloat } from './ticketFloat.js';
import { handleTicketVerbs, withTicketTrailers } from './ticketVerbs.js';
import * as worktree from './worktree.js';

/** preset → model 기본 배정 — 설정 `assign` 이 덮는다 */
const DEFAULT_ASSIGN = {
  high: 'anthropic:opus',
  low: 'anthropic:sonnet',
  coordinate: 'anthropic:fable',
  refactor: 'anthropic:opus',
  review: 'anthropic:opus',
};

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;

const WORKER_VERBS = `- Catch up with the parent branch: superlite worker sync
- Hand in your work (merge into the parent, keep this workspace): superlite worker done --submit --message "<commit title>"
- Hand in and remove this workspace, closing this session: superlite worker done --submit --close --message "<commit title>"
- Remove this workspace when nothing is left unmerged: superlite worker done --close
- Discard unmerged work and remove the workspace (only after the user confirms): superlite worker done --abandon <key> (the key is shown when --close refuses)
- Remove this workspace with worker done --close or --abandon, not slcode team clean-worktree --self: worker done also reports to the session that started you and closes this session.
- Message the session that started you: slcode mail leader <message>
- --submit adds a "Ticket: <id>" trailer to the message for each unfinished ticket assigned to this branch.
- That session gets the outcome and the first line of --message when you run worker done. Manage this branch only through these superlite commands.`;

const startVerbs = (names) => `- Start a session of another role (${names.join(', ')}) in a new workspace under this branch: superlite orchestrate new <role> <branch> [--preset <name>] -- <instruction>
- Start those sessions with orchestrate new, not slcode team new: only orchestrate new gives them their role and the commands to hand in their work.
- Message a session you started: slcode mail <branch> <message>
- They message you when they run worker done or have something for you. Check their result before handing in yours.`;

const ROLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 탭에서 고치기 전의 역할 — 지침은 defaults/<이름>.md: roleas 스킬에서 역할 설명만 옮긴 사본이고, 동사 사용법은 guideParts 가 그래프 위치대로 붙인다 (사용자 2026-11-04). x·y 는 탭의 상자 자리.
 *  자리를 따로 둘지(옛 separate)는 없다 — slcode team 이 모든 자리를 <repo>.worktrees/ 한 층에 만든다 (사용자 2026-11-13). 옛 저장값의 separate 는 쓰지 않고, 탭에서 저장하면 빠진다 */
const DEFAULT_ROLES = [
  { name: 'master-orchestrator', merge: 'no-ff', x: 40, y: 60 },
  { name: 'sub-orchestrator', merge: 'no-ff', x: 300, y: 60 },
  { name: 'worker', merge: 'squash', x: 560, y: 60 },
];
const DEFAULT_EDGES = [{ from: 'master-orchestrator', to: 'sub-orchestrator' }, { from: 'sub-orchestrator', to: 'worker' }];

const COMMON = '_common'; // 공통 지침의 파일 이름 — ROLE_RE 에 맞지 않아 역할과 겹치지 않는다
/** 지침은 머신의 파일 하나씩이다 — 탭의 Edit in editor 가 일반 편집기 탭(모나코)으로 열어 Ctrl+S 로 저장한다. 화면은 sandbox iframe 이라 창의 모나코를 넣을 수 없다 (사용자 2026-11-04).
 *  storage 와 같은 config 폴더 아래, 플러그인 폴더 밖 — 갱신이 플러그인 폴더를 통째로 바꾼다. ponytail: 설치본 기준 경로, 개발 폴더로 켜면 그 폴더의 ../../ 가 된다 */
const guideDir = (api) => path.join(api.folder.path, '..', '..', 'plugin-data', 'orchestration-guides');
const readGuide = (api, name) => fs.readFile(path.join(guideDir(api), `${name}.md`), 'utf8').catch(() => null);
async function writeGuide(api, name, text) {
  await fs.mkdir(guideDir(api), { recursive: true });
  const file = path.join(guideDir(api), `${name}.md`);
  await fs.writeFile(file, text);
  return file;
}
/** roleas 자동 완성이 읽는 역할 이름, 한 줄에 하나 — complete 는 칠 때마다 불려 superlite 를 부르지 못하고, 받은 세션 상태는 저장을 모른다 (사용자 2026-11-05). 지침 폴더 밖이다 — 그 폴더는 저장 때 역할에 없는 파일을 지운다 */
const roleNamesFile = (api) => path.join(guideDir(api), '..', 'orchestration-role-names');
async function writeRoleNames(api, names) {
  await fs.mkdir(path.dirname(roleNamesFile(api)), { recursive: true });
  await fs.writeFile(roleNamesFile(api), names.join('\n'));
}

const loadConfig = async (api) => {
  const saved = await api.storage.get('config');
  return {
    common: (await readGuide(api, COMMON)) ?? (await api.folder.read(`defaults/${COMMON}.md`)) ?? '',
    roles: await Promise.all((saved?.roles ?? DEFAULT_ROLES).map(async (r) => ({ ...r, guide: (await readGuide(api, r.name)) ?? (await api.folder.read(`defaults/${r.name}.md`)) ?? '' }))),
    edges: saved?.edges ?? DEFAULT_EDGES,
  };
};

/** 선을 따라가다 돌아오는 길 — 없으면 null. 예: [a, b, a] */
function findLoop(names, edges) {
  const clear = new Set();
  const walk = (n, trail) => {
    if (trail.includes(n)) return [...trail.slice(trail.indexOf(n)), n];
    if (clear.has(n)) return null;
    for (const e of edges) {
      if (e.from !== n) continue;
      const loop = walk(e.to, [...trail, n]);
      if (loop !== null) return loop;
    }
    clear.add(n);
    return null;
  };
  for (const n of names) {
    const loop = walk(n, []);
    if (loop !== null) return loop;
  }
  return null;
}

/** 탭이 보낸 값 — 형식을 맞춰 돌려준다. 틀리면 그 사유로 던진다 */
function checkConfig(c) {
  const roles = (Array.isArray(c?.roles) ? c.roles : []).map((r) => ({ name: String(r.name ?? '').trim(), merge: r.merge === 'no-ff' ? 'no-ff' : 'squash', x: Number(r.x) || 0, y: Number(r.y) || 0, guide: String(r.guide ?? '') }));
  if (roles.length === 0) throw new Error('add at least one role');
  for (const r of roles) if (!ROLE_RE.test(r.name)) throw new Error(`role name "${r.name}": use lowercase letters, digits and -`);
  const names = roles.map((r) => r.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup !== undefined) throw new Error(`duplicate role: ${dup}`);
  const edges = (Array.isArray(c.edges) ? c.edges : []).map((e) => ({ from: String(e.from), to: String(e.to) }));
  for (const e of edges) if (!names.includes(e.from) || !names.includes(e.to)) throw new Error(`line ${e.from} → ${e.to}: unknown role`);
  const loop = findLoop(names, edges);
  if (loop !== null) throw new Error(`These lines form a loop: ${loop.join(' → ')}. Remove one of them`);
  return { common: String(c.common ?? ''), roles, edges };
}

const startsOf = (cfg, name) => cfg.edges.filter((e) => e.from === name).map((e) => e.to);

/** 세션이 받는 안내 — 공통 지침·역할 지침 뒤에 쓸 수 있는 동사를 붙인다 (지침을 비워도 동사는 안다). 슬코드 훅이 startup·resume·압축 뒤마다, roleas 는
 *  그때 받아 넣는다. Codex 워커는 범위 밖이다 — slcode 안 Codex 세션은 아직 훅을 싣지 않아 안내가 없다 (사용자 2026-11-01: 분배 대상은 나중에 설정으로) */
function guideOf(cfg, role, at, isChild) {
  return guideParts(cfg, role, at, isChild).map((p) => p.text).filter((x) => x !== '').join('\n');
}

/** 안내의 조각 — 들어가는 순서대로. text 가 빈 조각은 들어가지 않는다 (미리 보기가 그 사유를 함께 보인다). isChild: 부모 기록이 있는 세션인가 */
function guideParts(cfg, role, at, isChild) {
  const starts = startsOf(cfg, role.name);
  return [
    { label: 'Role line', auto: true, text: `[superlite orchestration] Your role is ${role.name}${at}.` },
    { label: 'Common guide', text: cfg.common.trim(), off: 'empty' },
    { label: 'Role guide', text: role.guide.trim(), off: 'empty' },
    { label: 'orchestrate commands', auto: true, text: starts.length > 0 ? startVerbs(starts) : '', off: 'it starts no role' },
    { label: 'worker commands', auto: true, text: isChild ? WORKER_VERBS : '', off: 'no role starts it' },
  ];
}

/** 이 동사를 부른 세션의 역할 — 역할이 없거나 그 역할이 지워졌으면 null. orchestrate new 는 막지 않고, 합치는 worker done --submit 만 거절한다 */
async function callerRole(api, cfg, ctx) {
  const sid = ctx.env.SLCODE_SESSION_ID;
  if (!sid) return null;
  const name = await api.storage.get(`role:${sid}`);
  return cfg.roles.find((r) => r.name === name) ?? null;
}

/** @type {import('@superlite/plugin').MainApi | null} */
let host = null;

/** @param {import('@superlite/plugin').MainApi} api */
export async function activate(api) {
  host = api;
  const addAddon = async () => {
    const r = await api.plugins.get('slcode-plugin').run(['add', await api.folder.deploy('agent')]);
    if (r.code !== 0) throw new Error(`orchestration addon: ${(r.stderr || r.stdout).trim()}`);
  };

  api.expose('roles', {
    get: () => loadConfig(api),
    set: async (c) => {
      const cfg = checkConfig(c);
      const keep = new Set([COMMON, ...cfg.roles.map((r) => r.name)]);
      for (const f of await fs.readdir(guideDir(api)).catch(() => [])) if (!keep.has(f.replace(/\.md$/, ''))) await fs.rm(path.join(guideDir(api), f));
      await writeGuide(api, COMMON, cfg.common);
      for (const r of cfg.roles) await writeGuide(api, r.name, r.guide);
      await api.storage.set('config', { roles: cfg.roles.map(({ guide, ...r }) => r), edges: cfg.edges });
      await writeRoleNames(api, cfg.roles.map((r) => r.name));
      return cfg;
    },
    /** 저장 전 값으로 본 i 번째 역할의 안내 — 이름이 틀린 값도 받는다. worker 명령은 들어오는 선으로 짐작한다 (실제 세션은 부모 기록을 본다) */
    preview: (c, i) => guideParts(c, c.roles[i], ' (branch <branch>)', c.edges.some((e) => e.to === c.roles[i].name)),
    /** 편집기로 열 파일 — 지금 글을 적고 경로를 돌려준다 */
    file: (name, text) => {
      if (name !== COMMON && !ROLE_RE.test(name)) throw new Error(`role name "${name}": use lowercase letters, digits and -`);
      return writeGuide(api, name, String(text));
    },
  });

  api.verbs.handle('orchestrate.new', async (a, ctx) => {
    const cfg = await loadConfig(api);
    const target = cfg.roles.find((r) => r.name === a.role);
    if (target === undefined) throw new Error(`unknown role: ${a.role} (known: ${cfg.roles.map((r) => r.name).join(', ')})`);
    const leader = ctx.env.SLCODE_SESSION_ID;
    if (!leader) throw new Error('orchestrate new works only inside a slcode session: it starts the new session as a teammate of this one');
    const me = await callerRole(api, cfg, ctx);
    if (me !== null && !startsOf(cfg, me.name).includes(target.name)) throw new Error(`role ${me.name} cannot start ${target.name} (it can start: ${startsOf(cfg, me.name).join(', ') || 'nothing'})`);
    const role = target.name;
    const branch = String(a.branch);
    if (!BRANCH_RE.test(branch)) throw new Error(`branch name: ${branch}`);
    const prompt = /** @type {string[]} */ (a.prompt).join(' ');
    if (prompt.trim() === '') throw new Error('prompt is empty');
    const assign = await loadAssign(api);
    const preset = typeof a.preset === 'string' ? a.preset : startsOf(cfg, role).length > 0 ? 'coordinate' : 'high';
    const model = assign[preset];
    if (model === undefined) throw new Error(`unknown preset: ${preset} (known: ${Object.keys(assign).join(', ')})`);

    // 켤 때 실패했거나 sfa 팔레트 Remove 로 함께 지워졌으면 여기서 다시 실어 본다 (같은 내용이면 아무것도 하지 않는다) — 실패는 띄우기 전에 알린다
    await addAddon();

    // 띄우지 못하면 slcode 가 만든 worktree 를 지운다. 이름(--name)이 브랜치라 리더는 slcode mail <브랜치> 로 부른다
    const session = String(await api.verbs.run('slcode.team', ['--leader', leader, '--teammate', '--worktree', branch, '--name', branch, '--model', model, '--mode', 'bypassPermissions', '--param', `ORCH_ROLE=${role}`, '--prompt', prompt], ctx));
    const dir = (await worktree.locate(ctx.cwd)).list.find((x) => x.branch === branch)?.path ?? '';
    const workers = (await api.storage.get('workers')) ?? {};
    workers[session] = { branch, role, preset, model, parent: leader, prompt, at: Date.now() };
    await api.storage.set('workers', workers);
    return `${session} ${branch} ${dir} (${role}, ${model})`;
  });

  // 애드온 훅·roleas 가 부른다 — 역할 이름, 자동 완성이 읽을 파일과, --role 이 있으면 그 역할을 이 세션에 적고 안내. 모르는 역할이면 안내가 빈 글이다
  api.verbs.handle('orchestrate.enter', async (a, ctx) => {
    const cfg = await loadConfig(api);
    const roles = cfg.roles.map((r) => r.name);
    const role = cfg.roles.find((r) => r.name === a.role);
    const rolesFile = roleNamesFile(api);
    if (role === undefined) return JSON.stringify({ roles, rolesFile, guide: '' });
    if (ctx.env.SLCODE_SESSION_ID) await api.storage.set(`role:${ctx.env.SLCODE_SESSION_ID}`, role.name);
    const w = await worktree.locate(ctx.cwd).catch(() => null); // 저장소 밖에서도 역할은 정할 수 있다
    return JSON.stringify({ roles, rolesFile, guide: guideOf(cfg, role, w === null ? '' : ` (branch ${w.branch})`, w !== null && w.parent !== null) });
  });

  api.verbs.handle('worker.sync', async (a, ctx) => worktree.sync(await worktree.locate(ctx.cwd)));

  api.verbs.handle('worker.done', async (a, ctx) => {
    const submit = a.submit === true, close = a.close === true, key = typeof a.abandon === 'string' ? a.abandon : null;
    const message = typeof a.message === 'string' ? a.message : null;
    if (!submit && !close && key === null) {
      throw new Error(`choose how to finish:
  --submit --message <m>          merge into the parent, keep this workspace
  --close                         remove this workspace (refused if anything is left unmerged)
  --submit --close --message <m>  merge, then remove this workspace
  --abandon <key>                 discard what is left and remove this workspace (key from a refused --close)`);
    }
    if (key !== null && (submit || close)) throw new Error('--abandon cannot be combined with --submit or --close');
    if (submit && (message === null || message.trim() === '')) throw new Error('--submit needs --message <commit message>');
    if (!submit && message !== null) throw new Error('--message is only for --submit');

    const w = await worktree.locate(ctx.cwd);
    const { branch } = w;
    const me = await callerRole(api, await loadConfig(api), ctx);
    if (submit && me === null && w.parent !== null) throw new Error('this session has no role, so the merge method is unknown. Nothing was merged. Run this from a slcode session that has a role (set one with /superlite:roleas <role>)');
    const self = ctx.env.SLCODE_SESSION_ID ?? null;
    const slcode = api.plugins.get('slcode');
    const removed = close || key !== null;
    // 지우지 못할 것이면 합치기 전에 거절한다 — slcode 가 이 세션 기록으로 자리를 찾으므로 그 세션 안에서만 된다. 자식·미추적 파일은 submit 이 합치기 전에 본다
    if (removed) {
      if (self === null) throw new Error('only the slcode session of this workspace can remove it. Nothing was changed');
      if (typeof slcode?.cleanWorktree !== 'function') throw new Error('the slcode plugin is too old to remove a workspace (update it). Nothing was changed');
      if (!submit) await worktree.checkRemovable(w);
    }
    const outcome = submit && close ? 'landed' : submit ? 'submitted' : close ? 'closed' : 'abandoned';
    const trailed = submit ? await withTicketTrailers(ctx, branch, message) : { note: '' };
    const merged = submit ? await worktree.submit(w, me?.merge, trailed.message, close) : ''; // me 가 null 이면 부모 기록이 없는 경우뿐이고, submit 이 그 사유로 거절한다
    // 합친 뒤에 지우므로 slcode 의 유실 판단(부모 브랜치에 반영됐나)이 새 상태를 본다. 확인 키도 slcode 것이다
    if (removed) {
      const r = await slcode.cleanWorktree({ self, key: key ?? undefined });
      if (!r.removed) throw new Error(`${merged === '' ? '' : `${merged}, but `}not removed: ${r.reasons.join('; ')}. Hand it in with --submit, or discard it (after the user confirms) with: superlite worker done --abandon ${r.key}`);
    }

    const workers = (await api.storage.get('workers')) ?? {};
    const rec = self === null ? undefined : workers[self];
    if (removed) {
      await api.storage.set(`role:${self}`, null);
      if (rec !== undefined) {
        delete workers[self];
        await api.storage.set('workers', workers);
      }
    }
    const lines = [`${branch}: ${outcome}`, merged, trailed.note];

    // 자기를 띄운 세션에 알린다 — 그 세션이 꺼졌으면 알리지 못한 까닭만 출력에 남긴다
    const parent = rec?.parent ?? null;
    if (parent !== null) {
      try {
        await slcode.mail({ to: parent, text: `[worker done] ${branch}: ${outcome}${submit ? ` — ${message.split('\n')[0]}` : ''}`, from: self });
        lines.push(`reported to ${parent}`);
      } catch (e) {
        lines.push(`not reported to ${parent}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 자리를 정리했으면 자기 세션을 닫는다 — 이 결과가 셸에 돌아간 뒤에 (먼저 닫으면 출력이 셸에 닿기 전에 세션이 끊긴다)
    if (removed) {
      lines.push('this session closes now');
      setTimeout(() => { slcode.close(self).catch((e) => console.error(`orchestration: close ${self}: ${e instanceof Error ? e.message : e}`)); }, 1000);
    }
    return lines.filter((l) => l !== '').join('\n');
  });

  handleTicketVerbs(withTicketFloat(api));
  exposeTicketFloat(api);

  // 핸들러 뒤에 — 실패해도 동사는 산다. 데몬 시작 때는 창이 없어 알림이 버려지므로 로그에 남기고, 다음 orchestrate 가 다시 시도하며 오류를 낸다
  await writeRoleNames(api, (await loadConfig(api)).roles.map((r) => r.name));
  await addAddon().catch((e) => console.error(e.message));
}

export async function uninstall() {
  if (host !== null) await host.plugins.get('slcode-plugin').run(['remove', 'orchestration']);
}

async function loadAssign(api) {
  const raw = await api.settings.get('assign');
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_ASSIGN;
  let map;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    throw new Error(`setting assign is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (map === null || typeof map !== 'object') throw new Error('setting assign must be an object');
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'string' || v === '') throw new Error(`setting assign.${k} must be a model string like anthropic:opus`);
  }
  return map;
}
