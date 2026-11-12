// orchestration 의 slcode.team 띄우기·애드온 등록·worker done (ticket orchestration-slcode-param·orchestration-sfa-addon·orchestration-slcode-team) — `node --test test/orchestrationParam.test.ts`.
// 실제 slcode 없이 가짜 api 로 main.js 를 돌린다. slcode.team 인자 해석은 main 끼리 verbs.run 이 거치는 데몬 pluginhost.mjs 의 parseArgs 를
// 사본(pluginhost-args.mjs)으로 쓰고, 자리는 slcode team --worktree 와 같은 꼴로 만든다 (slcodeTeam.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { activate, uninstall } from '../orchestration/main.js';
import * as tickets from '../orchestration/tickets.js';
import { parseArgs } from './pluginhost-args.mjs';
import { removeTeamWorktree, teamWorktree } from './slcodeTeam.ts';

// slcode plugin.json 의 slcode.team 인자 (0.5.11)
const opt = (name: string) => ({ name, kind: 'option' });
const flag = (name: string) => ({ name, kind: 'flag' });
const slcodeTeam = {
  name: 'slcode.team',
  args: [opt('leader'), ...['subagent', 'teammate', 'detached'].map(flag), ...['cwd', 'worktree', 'name', 'options', 'agent', 'model', 'effort', 'mode', 'profile', 'env', 'param', 'prompt'].map(opt)],
};

type Call = Record<string, unknown>;
/** 워크트리 동사는 실제 git 을 부른다 — 임시 저장소를 cwd 로 쓴다 */
function tempRepo() {
  const r = `${fs.realpathSync(fs.mkdtempSync('/tmp/orch-param-'))}/r`;
  fs.mkdirSync(r);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: r, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return r;
}

/** loss: slcode clean-worktree 가 잃을 작업을 찾은 것처럼 — 그 key 를 주어야 지운다 */
async function harness({ failWith = null as string | null, addFails = false, mailFails = false, loss = null as { reasons: string[]; key: string } | null } = {}) {
  const repo = tempRepo();
  const handlers = new Map<string, (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const calls: Call[] = [];
  const cli: string[][] = [];
  const mails: { to: string; text: string; from?: string }[] = [];
  const cleans: { self: string; key?: string }[] = [];
  const worktrees = new Map<string, string>(); // 팀원 세션 id → worktree (slcode 세션 기록의 meta.worktree)
  let nextSession = 1;
  const store = new Map<string, unknown>();
  const exposed: Record<string, Record<string, (...a: unknown[]) => unknown>> = {};
  const api = {
    settings: { get: async () => '' },
    storage: { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => void (v === null ? store.delete(k) : store.set(k, v)) },
    expose: (name: string, impl: Record<string, (...a: unknown[]) => unknown>) => void (exposed[name] = impl),
    window: { main: async () => ({}) },
    folder: { path: `${fs.mkdtempSync('/tmp/orch-test-')}/plugins/orchestration`, deploy: async (sub: string) => `/plugin/${sub}`, read: async (f: string) => fs.readFileSync(new URL(`../orchestration/${f}`, import.meta.url), 'utf8') },
    verbs: {
      handle: (name: string, fn: (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>) => void handlers.set(name, fn),
      run: async (name: string, argv: string[], ctx: { cwd: string }) => {
        assert.equal(name, 'slcode.team');
        const a = parseArgs(slcodeTeam, argv);
        calls.push(a);
        if (failWith !== null) throw new Error(failWith);
        const id = `sid${nextSession++}`;
        worktrees.set(id, teamWorktree(ctx.cwd, String(a.worktree)));
        return id;
      },
    },
    plugins: {
      get: (id: string) => id === 'slcode-plugin'
        ? { run: async (args: string[]) => { cli.push(args); return addFails ? { code: 1, stdout: '', stderr: 'error: needs superlite' } : { code: 0, stdout: '', stderr: '' }; } }
        : id === 'slcode'
          ? {
              mail: async (m: { to: string; text: string; from?: string }) => { if (mailFails) throw new Error('session is gone'); mails.push(m); },
              close: async () => {},
              cleanWorktree: async (c: { self: string; key?: string }) => {
                cleans.push(c);
                const dir = worktrees.get(c.self);
                if (dir === undefined) throw new Error(`session ${c.self} has no worktree made by slcode team new --worktree`);
                if (loss !== null && c.key !== loss.key) return { removed: false, ...loss };
                removeTeamWorktree(dir);
                return { removed: true, path: dir };
              },
            }
          : undefined,
    },
  };
  await activate(api as never);
  const ctx = { cwd: repo, tmux: '%1', env: {} };
  const asSession = (sid: string) => ({ ...ctx, env: { SLCODE_SESSION_ID: sid } });
  return { repo, asSession, calls, cli, mails, cleans, store, exposed, handlers, run: (verb: string, a: Record<string, unknown>, c: unknown = ctx) => handlers.get(verb)!(a, c) };
}

const DEFAULT_NAMES = ['master-orchestrator', 'sub-orchestrator', 'worker'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('켤 때 애드온을 싣고, uninstall 은 애드온을 지운다', async () => {
  const h = await harness();
  assert.deepEqual(h.cli, [['add', '/plugin/agent']]);
  await uninstall();
  assert.deepEqual(h.cli.at(-1), ['remove', 'orchestration']);
});

test('이 세션의 teammate 로 브랜치 이름의 worktree 에 띄우고, 역할은 --param, 첫 프롬프트는 지시문만', async () => {
  const h = await harness();
  assert.match(String(await h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['do', 'it'] }, h.asSession('L'))), new RegExp(`^sid1 feat/x ${h.repo}\\.worktrees/feat-x \\(worker, anthropic:opus\\)$`));
  assert.equal(h.calls.length, 1);
  const c = h.calls[0];
  assert.deepEqual([c.leader, c.teammate, c.worktree, c.name, c.subagent, c.detached, c.cwd], ['L', true, 'feat/x', 'feat/x', false, false, undefined]);
  assert.equal(c.param, 'ORCH_ROLE=worker');
  assert.equal(c.mode, 'bypassPermissions');
  assert.equal(c.prompt, 'do it');
  assert.equal((h.store.get('workers') as Record<string, { parent: string }>).sid1.parent, 'L');
  assert.equal(git(h.repo, 'config', 'branch.feat/x.slcodeparent'), 'main');
});

test('애드온을 실을 수 없으면 띄우기 전에 거부한다 (켤 때는 동사가 산다)', async () => {
  const h = await harness({ addFails: true });
  await assert.rejects(h.run('orchestrate.new', { role: 'sub-orchestrator', branch: 'feat/x', prompt: ['x'] }, h.asSession('L')), /orchestration addon: error: needs superlite/);
  assert.equal(h.calls.length, 0);
});

test('일반 터미널의 new 는 거절하고, slcode.team 의 거절(Windows 등)은 그대로 보인다', async () => {
  const h = await harness({ failWith: 'slcode.team is not available on Windows yet' });
  await assert.rejects(h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['x'] }), /only inside a slcode session/);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['x'] }, h.asSession('L')), /^Error: slcode.team is not available on Windows yet$/);
  assert.equal(h.store.get('workers'), undefined);
});

test('enter: 역할 이름과 안내를 주고 역할을 적는다, 모르는 역할은 빈 안내', async () => {
  const h = await harness();
  const enter = async (a: Record<string, unknown>, sid = 's1') => JSON.parse(String(await h.run('orchestrate.enter', a, h.asSession(sid))));
  const first = await enter({});
  assert.deepEqual(first, { roles: DEFAULT_NAMES, rolesFile: first.rolesFile, guide: '' });
  assert.equal(h.store.get('role:s1'), undefined);
  const worker = (await enter({ role: 'worker' })).guide;
  assert.match(worker, /^\[superlite orchestration\] Your role is worker \(branch main\)\./);
  assert.doesNotMatch(worker, /orchestrate new/);
  assert.equal(h.store.get('role:s1'), 'worker');
  const top = (await enter({ role: 'master-orchestrator' }, 's2')).guide;
  assert.match(top, /another role \(sub-orchestrator\)/);
  assert.match(top, /slcode mail <branch> <message>/);
  assert.match(top, /with orchestrate new, not slcode team new/);
  // 기본 지침은 역할 설명만 담고, 동사 사용법은 그래프 위치대로 붙는다
  assert.match(top, /milestone 을 만들고 닫는다/);
  assert.match(worker, /지목한 ticket 을 수행한다/);
  // 처음에는 공통 지침도 기본값이다 — 역할 지침보다 앞에 온다
  assert.match(worker, /Your role is worker[^\n]*\n- ticket 과 milestone 은 `superlite ticket` 으로만[\s\S]*지목한 ticket 을 수행한다/);
  assert.doesNotMatch(`${top}${worker}`, /ruleof|wsticket/);
  assert.doesNotMatch(`${top}${worker}`, /wtree|SendMessage|\/roleas/);
  assert.equal((await enter({ role: 'toString' }, 's3')).guide, '');
  assert.equal(h.store.get('role:s3'), undefined);
});

test('enter: worker 명령은 실제 부모 기록이 있는 세션에만 안내한다', async () => {
  const h = await harness();
  const enter = async (role: string, cwd: string) => JSON.parse(String(await h.run('orchestrate.enter', { role }, { ...h.asSession('s'), cwd }))).guide as string;
  assert.doesNotMatch(await enter('worker', h.repo), /superlite worker/);
  await h.run('orchestrate.new', { role: 'master-orchestrator', branch: 'feat/m', prompt: ['x'] }, h.asSession('L'));
  const m = await enter('master-orchestrator', `${h.repo}.worktrees/feat-m`);
  assert.match(m, /superlite worker done/);
  assert.match(m, /slcode mail leader <message>/);
  // slcode 가 첫 안내에 넣는 clean-worktree --self 와 어긋나지 않게 — 지우기는 worker done 으로
  assert.match(m, /not slcode team clean-worktree --self/);
  // 저장소 밖에서도 역할은 정해진다
  const out = fs.mkdtempSync('/tmp/orch-out-');
  assert.match(await enter('worker', out), /Your role is worker\.\n/);
});

test('값 검사: 이름·중복·모르는 선·순환을 거부하고, 지침이 안내에 들어간다', async () => {
  const h = await harness();
  const set = h.exposed.roles.set;
  await assert.rejects(async () => set({ roles: [] }), /at least one role/);
  await assert.rejects(async () => set({ roles: [{ name: 'Bad Name' }] }), /role name/);
  await assert.rejects(async () => set({ roles: [{ name: 'a' }, { name: 'a' }] }), /duplicate role: a/);
  await assert.rejects(async () => set({ roles: [{ name: 'a' }], edges: [{ from: 'a', to: 'b' }] }), /line a → b: unknown role/);
  await assert.rejects(async () => set({ roles: [{ name: 'a' }], edges: [{ from: 'a', to: 'a' }] }), /loop: a → a/);
  await assert.rejects(async () => set({ roles: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }] }), /loop: b → c → b/);
  // 다이아몬드는 순환이 아니다
  await set({ roles: [{ name: 'o' }, { name: 'l' }, { name: 'm' }, { name: 'w' }], edges: [{ from: 'o', to: 'l' }, { from: 'o', to: 'm' }, { from: 'l', to: 'w' }, { from: 'm', to: 'w' }] });
  await set({ common: 'Be brief.', roles: [{ name: 'boss', guide: 'Lead it.' }, { name: 'dev', guide: 'Do it.' }], edges: [{ from: 'boss', to: 'dev' }] });
  const { roles, guide } = JSON.parse(String(await h.run('orchestrate.enter', { role: 'boss' }, h.asSession('s1'))));
  assert.deepEqual(roles, ['boss', 'dev']);
  assert.match(guide, /Be brief\.\nLead it\.\n- Start a session of another role \(dev\)/);
  await assert.rejects(h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['x'] }), /unknown role: worker \(known: boss, dev\)/);
});

test('roleas 자동 완성: 세션 상태의 경로로 저장값을 읽어 이미 열린 세션의 후보도 바로 바뀐다', async () => {
  registerHooks({
    resolve: (spec, ctx, next) => (spec === 'slcode/api' ? { url: 'data:text/javascript,export const slcode = { command: (d) => { globalThis.roleasCommand = d; } }', shortCircuit: true } : next(spec, ctx)),
  });
  await import('../orchestration/agent/orch/commands/roleas/COMMAND.ts');
  const { complete } = (globalThis as unknown as { roleasCommand: { complete(c: unknown): string[] } }).roleasCommand;
  const h = await harness();
  const { rolesFile } = JSON.parse(String(await h.run('orchestrate.enter', {}, h.asSession('s1'))));
  const state = { rolesFile };
  const at = (value: string, index = 0) => complete({ index, value, state });
  // 저장한 적이 없어도 활성화 때 파일이 있다
  assert.deepEqual(at(''), DEFAULT_NAMES);
  assert.deepEqual(at('w'), ['worker']);
  assert.deepEqual(at('', 1), []);
  assert.deepEqual(complete({ index: 0, value: '', state: {} }), []);
  // 같은 state 그대로 — 이름을 바꾸고 지우면 다음 입력부터 후보가 바뀐다
  await h.exposed.roles.set({ roles: [{ name: 'lead' }, { name: 'dev' }], edges: [] });
  assert.deepEqual(at(''), ['lead', 'dev']);
  await h.exposed.roles.set({ roles: [{ name: 'dev' }], edges: [] });
  assert.deepEqual(at(''), ['dev']);
});

test('지침 파일: 저장하면 파일에 적고, 편집기가 고친 글을 안내가 읽고, 지운 역할의 파일은 치운다', async () => {
  const h = await harness();
  const { get, set, file } = h.exposed.roles;
  const f = String(await file('worker', 'Do it.'));
  assert.match(f, /plugin-data\/orchestration-guides\/worker\.md$/);
  assert.equal(((await get()) as any).roles.find((r: any) => r.name === 'worker').guide, 'Do it.');
  fs.writeFileSync(f, 'Edited in Monaco.');
  assert.match(JSON.parse(String(await h.run('orchestrate.enter', { role: 'worker' }, h.asSession('s1')))).guide, /Edited in Monaco\./);
  await assert.rejects(async () => file('../x', 'y'), /role name/);
  await set({ roles: [{ name: 'boss', guide: 'Lead.', x: 12, y: 34 }] });
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(await get(), { common: '', roles: [{ name: 'boss', merge: 'squash', x: 12, y: 34, guide: 'Lead.' }], edges: [] });
});

test('미리 보기: 저장 전 값으로 그래프 위치대로 조각을 주고, 실제 안내와 글이 같다', async () => {
  const h = await harness();
  const c = { common: 'Be brief.', roles: [{ name: 'boss', guide: 'Lead.' }, { name: 'dev', guide: '' }], edges: [{ from: 'boss', to: 'dev' }] };
  const parts = (i: number) => h.exposed.roles.preview(c, i) as { label: string; text: string; off?: string }[];
  assert.deepEqual(parts(0).map((p) => p.label), ['Role line', 'Common guide', 'Role guide', 'orchestrate commands', 'worker commands']);
  assert.match(parts(0)[3].text, /another role \(dev\)/);
  assert.deepEqual([parts(0)[4].off, parts(0)[4].text], ['no role starts it', '']);
  assert.deepEqual([parts(1)[2].off, parts(1)[2].text], ['empty', '']);
  assert.deepEqual([parts(1)[3].off, parts(1)[3].text], ['it starts no role', '']);
  assert.match(parts(1)[4].text, /superlite worker done/);
  await h.exposed.roles.set(c);
  const real = JSON.parse(String(await h.run('orchestrate.enter', { role: 'boss' }, h.asSession('s1')))).guide as string;
  assert.equal(real, parts(0).map((p) => p.text).filter(Boolean).join('\n').replace(' (branch <branch>)', ' (branch main)'));
});

test('권한: 나가는 선의 대상만 띄운다, 역할 없는 세션은 막지 않는다', async () => {
  const h = await harness();
  let n = 0;
  const spawn = (role: string, sid: string) => h.run('orchestrate.new', { role, branch: `feat/x${n++}`, prompt: ['x'] }, h.asSession(sid));
  await h.exposed.roles.set({ roles: ['orch', 'lead', 'monitor', 'worker'].map((name) => ({ name })), edges: [{ from: 'orch', to: 'lead' }, { from: 'orch', to: 'monitor' }, { from: 'orch', to: 'worker' }, { from: 'lead', to: 'worker' }, { from: 'monitor', to: 'worker' }] });
  for (const [sid, role] of [['O', 'orch'], ['L', 'lead'], ['W', 'worker']]) await h.run('orchestrate.enter', { role }, h.asSession(sid));
  await spawn('worker', 'O'); // 계층을 건너뛰어도 선이 있으면 된다
  await spawn('monitor', 'O');
  await spawn('worker', 'L');
  await assert.rejects(spawn('monitor', 'L'), /role lead cannot start monitor \(it can start: worker\)/);
  await assert.rejects(spawn('orch', 'L'), /cannot start orch/);
  await assert.rejects(spawn('worker', 'W'), /role worker cannot start worker \(it can start: nothing\)/);
  await spawn('orch', 'nobody');
  // 선이 있어 자식을 띄우는 역할은 기본 preset 이 coordinate, 없으면 high
  assert.equal(h.calls.at(-1)!.model, 'anthropic:fable');
  assert.equal(h.calls[0].model, 'anthropic:opus');
});

test('worker 명령: 부모 기록이 없으면 sync·done 을 모두 거절하고 브랜치를 지우지 않는다', async () => {
  const h = await harness();
  git(h.repo, 'worktree', 'add', '-q', '-b', 'feat/other', `${h.repo}-other`);
  const other = { ...h.asSession('s'), cwd: `${h.repo}-other` };
  for (const a of [{ close: true }, { abandon: 'abcde' }, { submit: true, message: 'm' }]) await assert.rejects(h.run('worker.done', a, other), /no recorded parent/);
  await assert.rejects(h.run('worker.sync', {}, other), /no recorded parent/);
  assert.equal(fs.existsSync(`${h.repo}-other`), true);
  assert.match(git(h.repo, 'branch', '--list', 'feat/other'), /feat\/other/);
});

test('합치기: 역할을 찾지 못하면 합치지 않고 거절한다, 지우기와 sync 는 역할 없이 된다', async () => {
  const h = await harness();
  const work = (d: string, file: string) => {
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'user.email', 't@t');
    fs.writeFileSync(`${d}/${file}`, 'x\n');
    git(d, 'add', file);
    git(d, 'commit', '-qm', file);
  };
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, h.asSession('L'));
  const a = `${h.repo}.worktrees/feat-a`;
  work(a, 'a.txt');
  const main0 = git(h.repo, 'rev-parse', 'main');
  const head0 = git(a, 'rev-parse', 'HEAD');
  const inA = (sid: string) => ({ ...h.asSession(sid), cwd: a });
  const refused = /no role.*Nothing was merged/;
  // 터미널(세션 없음), 역할을 정하지 않은 세션
  await assert.rejects(h.run('worker.done', { submit: true, message: 'm' }, { cwd: a, tmux: '%1', env: {} }), refused);
  await assert.rejects(h.run('worker.done', { submit: true, message: 'm' }, inA('none')), refused);
  await assert.rejects(h.run('worker.done', { submit: true, close: true, message: 'm' }, inA('none')), refused);
  // 설정에서 지워진 역할
  await h.run('orchestrate.enter', { role: 'worker' }, inA('W'));
  const cfg = (await h.exposed.roles.get()) as { roles: { name: string }[]; edges: { from: string; to: string }[] };
  await h.exposed.roles.set({ ...cfg, roles: cfg.roles.filter((r) => r.name !== 'worker'), edges: cfg.edges.filter((e) => e.to !== 'worker') });
  await assert.rejects(h.run('worker.done', { submit: true, message: 'm' }, inA('W')), refused);
  assert.deepEqual([git(h.repo, 'rev-parse', 'main'), git(a, 'rev-parse', 'HEAD')], [main0, head0]);
  assert.equal(fs.existsSync(a), true);
  // 역할이 없어도 sync 는 되고, 지우기는 slcode 에 맡긴다
  assert.match(String(await h.run('worker.sync', {}, inA('none'))), /already up to date/);
  await assert.rejects(h.run('worker.done', { close: true }, inA('none')), /session none has no worktree/);
  // 역할을 다시 정하면 합쳐진다
  await h.exposed.roles.set(cfg);
  await h.run('orchestrate.enter', { role: 'worker' }, inA('W'));
  assert.match(String(await h.run('worker.done', { submit: true, message: 'm' }, inA('W'))), /\(squash\)/);
});

test('제출: 이 브랜치가 맡은 ticket 의 Ticket trailer 를 합친 커밋에 붙이고 출력에 알린다', async () => {
  const h = await harness();
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/t', prompt: ['x'] }, h.asSession('L'));
  const d = `${h.repo}.worktrees/feat-t`;
  git(d, 'config', 'user.name', 't');
  git(d, 'config', 'user.email', 't@t');
  fs.writeFileSync(`${d}/t.txt`, 'x\n');
  git(d, 'add', 't.txt');
  git(d, 'commit', '-qm', 'wip');
  const dbFile = `${fs.realpathSync(fs.mkdtempSync('/tmp/orch-trailer-'))}/tickets.db`;
  const db = await tickets.openStore(dbFile);
  const id = tickets.createTicket(db, { title: 't' });
  tickets.updateTicket(db, id, { add: { assignee: ['feat/t'] } });
  db.close();
  const at = { cwd: d, tmux: '%1', env: { SLCODE_SESSION_ID: 'W', TICKET_PATH: dbFile } };
  await h.run('orchestrate.enter', { role: 'worker' }, at);
  assert.match(String(await h.run('worker.done', { submit: true, message: 'feat: t' }, at)), new RegExp(`\\(squash\\)\nTicket trailer: ${id}`));
  assert.equal(git(h.repo, 'log', '-1', '--format=%B', 'main'), `feat: t\n\nTicket: ${id}`);
});

test('완료 보고: 합치고 slcode 로 지운 뒤 띄운 세션에 알리고 이 세션을 닫는다, 메시지 동사는 없다', async () => {
  const h = await harness();
  assert.equal(h.handlers.has('orchestrate.message') || h.handlers.has('worker.message'), false);
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, h.asSession('L'));
  const a = `${h.repo}.worktrees/feat-a`;
  const at = { ...h.asSession('sid1'), cwd: a };
  await h.run('orchestrate.enter', { role: 'worker' }, at);
  fs.writeFileSync(`${a}/a.txt`, 'a\n');
  git(a, 'add', 'a.txt');
  git(a, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
  // 이 세션 밖(일반 터미널)에서는 지우지 못한다
  await assert.rejects(h.run('worker.done', { close: true }, { ...at, env: {} }), /only the slcode session of this workspace can remove it\. Nothing was changed/);
  assert.equal(h.cleans.length, 0);
  assert.match(String(await h.run('worker.done', { submit: true, close: true, message: 'feat: a\n\nbody' }, at)), /^feat\/a: landed\nmerged into main as \w+ \(squash\)\nreported to L\nthis session closes now$/);
  assert.deepEqual(h.cleans, [{ self: 'sid1', key: undefined }]);
  assert.deepEqual(h.mails, [{ to: 'L', text: '[worker done] feat/a: landed — feat: a', from: 'sid1' }]);
  assert.equal(fs.existsSync(a), false);
  assert.equal(h.store.get('role:sid1'), undefined);
  assert.equal((h.store.get('workers') as Record<string, unknown>).sid1, undefined);
});

test('지우기: slcode 가 잃을 작업을 찾으면 그 키로 --abandon 을 안내하고, 그 키로 버린다', async () => {
  const h = await harness({ loss: { reasons: ['uncommitted changes in /r.worktrees/feat-a', 'commits on feat/a not in main'], key: 'k1234' } });
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, h.asSession('L'));
  const a = `${h.repo}.worktrees/feat-a`;
  const at = { ...h.asSession('sid1'), cwd: a };
  await assert.rejects(h.run('worker.done', { close: true }, at), /^Error: not removed: uncommitted changes in \/r\.worktrees\/feat-a; commits on feat\/a not in main\. Hand it in with --submit, or discard it \(after the user confirms\) with: superlite worker done --abandon k1234$/);
  assert.equal(fs.existsSync(a), true);
  assert.deepEqual(h.mails, []);
  assert.match(String(await h.run('worker.done', { abandon: 'k1234' }, at)), /^feat\/a: abandoned\nreported to L\nthis session closes now$/);
  assert.deepEqual(h.cleans.at(-1), { self: 'sid1', key: 'k1234' });
  assert.equal(fs.existsSync(a), false);
});

test('완료 보고: 띄운 세션이 꺼졌으면 사유를 출력에 남긴다', async () => {
  const h = await harness({ mailFails: true });
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, h.asSession('L'));
  const at = { ...h.asSession('sid1'), cwd: `${h.repo}.worktrees/feat-a` };
  assert.match(String(await h.run('worker.done', { close: true }, at)), /^feat\/a: closed\nnot reported to L: session is gone\nthis session closes now$/);
});

test('합류 방식은 역할 설정을 따른다', async () => {
  const h = await harness();
  const inDir = (cwd: string, sid: string) => ({ ...h.asSession(sid), cwd });
  const work = (d: string, file: string) => {
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'user.email', 't@t');
    fs.writeFileSync(`${d}/${file}`, 'x\n');
    git(d, 'add', file);
    git(d, 'commit', '-qm', file);
  };
  // 기본값: sub-orchestrator 는 merge commit, worker 는 squash. 자리는 모두 <repo>.worktrees/ 한 층이다
  await h.run('orchestrate.new', { role: 'sub-orchestrator', branch: 'dev/minor', prompt: ['x'] }, h.asSession('M'));
  const lead = `${h.repo}.worktrees/dev-minor`;
  await h.run('orchestrate.enter', { role: 'sub-orchestrator' }, inDir(lead, 'sid1'));
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, inDir(lead, 'sid1'));
  const a = `${h.repo}.worktrees/feat-a`;
  work(a, 'a.txt');
  await h.run('orchestrate.enter', { role: 'worker' }, inDir(a, 'sid2'));
  assert.match(String(await h.run('worker.done', { submit: true, message: 'feat: a' }, inDir(a, 'sid2'))), /feat\/a: submitted\nmerged into dev\/minor as \w+ \(squash\)\nreported to sid1$/);
  assert.match(String(await h.run('worker.done', { submit: true, message: 'merge minor' }, inDir(lead, 'sid1'))), /\(no-ff\)\nreported to M$/);
  assert.equal(git(h.repo, 'log', '-1', '--format=%P', 'main').split(' ').length, 2);
  // 탭에서 바꾸면 그 값을 쓴다
  const cfg = (await h.exposed.roles.get()) as { roles: Record<string, unknown>[] };
  cfg.roles[2].merge = 'no-ff';
  await h.exposed.roles.set(cfg);
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/b', prompt: ['x'] }, h.asSession('M'));
  const b = `${h.repo}.worktrees/feat-b`;
  work(b, 'b.txt');
  await h.run('orchestrate.enter', { role: 'worker' }, inDir(b, 'sid3'));
  assert.match(String(await h.run('worker.done', { submit: true, close: true, message: 'feat: b' }, inDir(b, 'sid3'))), /feat\/b: landed\nmerged into main as \w+ \(no-ff\)/);
  assert.equal(fs.existsSync(b), false);
});
