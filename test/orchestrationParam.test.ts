// orchestration 의 slcode.new --param·애드온 등록 (ticket orchestration-slcode-param·orchestration-sfa-addon) — `node --test test/orchestrationParam.test.ts`.
// 실제 slcode 없이 가짜 api 로 main.js 를 돌린다. slcode.new 인자 해석은 main 끼리 verbs.run 이 거치는 데몬 pluginhost.mjs 의 parseArgs 를
// 사본(pluginhost-args.mjs)으로 쓴다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { activate, uninstall } from '../orchestration/main.js';
import { parseArgs } from './pluginhost-args.mjs';

// slcode plugin.json 의 slcode.new 인자 (0.5.5)
const opt = (name: string) => ({ name, kind: 'option' });
const slcodeNew = {
  name: 'slcode.new',
  args: [...['cwd', 'vendor', 'title', 'mode', 'model', 'effort', 'profile', 'env', 'param', 'prompt'].map(opt), { name: 'focus', kind: 'flag' }],
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

async function harness({ failWith = null as string | null, addFails = false, mailFails = false } = {}) {
  const repo = tempRepo();
  const handlers = new Map<string, (a: Record<string, unknown>, ctx: unknown) => Promise<unknown>>();
  const calls: Call[] = [];
  const cli: string[][] = [];
  const mails: { to: string; text: string; from?: string }[] = [];
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
      run: async (name: string, argv: string[]) => {
        assert.equal(name, 'slcode.new');
        calls.push(parseArgs(slcodeNew, argv));
        if (failWith !== null) throw new Error(failWith);
        return `sid${nextSession++}`;
      },
    },
    plugins: {
      get: (id: string) => id === 'slcode-plugin'
        ? { run: async (args: string[]) => { cli.push(args); return addFails ? { code: 1, stdout: '', stderr: 'error: needs superlite' } : { code: 0, stdout: '', stderr: '' }; } }
        : id === 'slcode'
          ? { mail: async (m: { to: string; text: string; from?: string }) => { if (mailFails) throw new Error('session is gone'); mails.push(m); }, close: async () => {} }
          : undefined,
    },
  };
  await activate(api as never);
  const ctx = { cwd: repo, tmux: '%1', env: {} };
  const asSession = (sid: string) => ({ ...ctx, env: { SLCODE_SESSION_ID: sid } });
  return { repo, asSession, calls, cli, mails, store, exposed, run: (verb: string, a: Record<string, unknown>, c: unknown = ctx) => handlers.get(verb)!(a, c) };
}

const DEFAULT_NAMES = ['master-orchestrator', 'sub-orchestrator', 'worker'];
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('켤 때 애드온을 싣고, uninstall 은 애드온을 지운다', async () => {
  const h = await harness();
  assert.deepEqual(h.cli, [['add', '/plugin/agent']]);
  await uninstall();
  assert.deepEqual(h.cli.at(-1), ['remove', 'orchestration']);
});

test('--param 으로 역할을 넘기고 첫 프롬프트는 지시문만', async () => {
  const h = await harness();
  assert.match(String(await h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['do', 'it'] })), new RegExp(`^sid1 feat/x ${h.repo}\\.worktrees/feat-x`));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].param, 'ORCH_ROLE=worker');
  assert.equal(h.calls[0].mode, 'bypassPermissions');
  assert.equal(h.calls[0].prompt, 'do it');
  assert.equal((h.store.get('workers') as Record<string, { session: string }>)[`${h.repo}.worktrees/feat-x`].session, 'sid1');
});

test('애드온을 실을 수 없으면 워크트리를 만들기 전에 거부한다 (켤 때는 동사가 산다)', async () => {
  const h = await harness({ addFails: true });
  await assert.rejects(h.run('orchestrate.new', { role: 'sub-orchestrator', branch: 'feat/x', prompt: ['x'] }), /orchestration addon: error: needs superlite/);
  assert.equal(h.calls.length, 0);
});

test('slcode 실패는 워크트리 자리와 함께 알린다', async () => {
  const h = await harness({ failWith: 'no superlite window has this terminal open' });
  await assert.rejects(h.run('orchestrate.new', { role: 'worker', branch: 'feat/x', prompt: ['x'] }), /workspace created \(.*\.worktrees\/feat-x\) but the slcode session failed: no superlite window/);
  assert.equal(h.calls.length, 1);
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
  assert.match(top, /superlite orchestrate message <branch>/);
  // 기본 지침은 역할 설명만 담고, 동사 사용법은 그래프 위치대로 붙는다
  assert.match(top, /milestone 을 수립/);
  assert.match(worker, /ticket 하나를 수행한다/);
  // 처음에는 공통 지침도 기본값이다 — 역할 지침보다 앞에 온다
  assert.match(worker, /Your role is worker[^\n]*\n- ticket 문서는 `ruleof ticket`[\s\S]*ticket 하나를 수행한다/);
  assert.doesNotMatch(`${top}${worker}`, /wtree|SendMessage|\/roleas/);
  assert.equal((await enter({ role: 'toString' }, 's3')).guide, '');
  assert.equal(h.store.get('role:s3'), undefined);
});

test('enter: worker 명령은 실제 부모 기록이 있는 세션에만 안내한다', async () => {
  const h = await harness();
  const enter = async (role: string, cwd: string) => JSON.parse(String(await h.run('orchestrate.enter', { role }, { ...h.asSession('s'), cwd }))).guide as string;
  assert.doesNotMatch(await enter('worker', h.repo), /superlite worker/);
  await h.run('orchestrate.new', { role: 'master-orchestrator', branch: 'feat/m', prompt: ['x'] });
  const m = await enter('master-orchestrator', `${h.repo}.worktrees/feat-m`);
  assert.match(m, /superlite worker done/);
  assert.match(m, /superlite worker message -- <message>/);
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
  assert.deepEqual(await get(), { common: '', roles: [{ name: 'boss', merge: 'squash', separate: false, x: 12, y: 34, guide: 'Lead.' }], edges: [] });
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
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] });
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
  // 역할이 없어도 sync 는 되고, 잃을 것이 있는 지우기는 기존 사유로 거절한다
  assert.match(String(await h.run('worker.sync', {}, inA('none'))), /already up to date/);
  await assert.rejects(h.run('worker.done', { close: true }, inA('none')), /commits not in main/);
  // 역할을 다시 정하면 합쳐진다
  await h.exposed.roles.set(cfg);
  await h.run('orchestrate.enter', { role: 'worker' }, inA('W'));
  assert.match(String(await h.run('worker.done', { submit: true, message: 'm' }, inA('W'))), /\(squash\)/);
});

test('메시지: 부모와 직접 띄운 자식 사이에만 오간다', async () => {
  const h = await harness();
  const lead = { ...h.asSession('L') };
  await h.run('orchestrate.new', { role: 'sub-orchestrator', branch: 'dev/a', prompt: ['x'] }, lead);
  const a = `${h.repo}.worktrees/a/dev-a`;
  // 자식 → 부모
  assert.equal(await h.run('worker.message', { text: ['need', 'a', 'decision'] }, { ...h.asSession('sid1'), cwd: a }), 'sent to L');
  assert.deepEqual(h.mails.at(-1), { to: 'L', text: '[from dev/a] need a decision', from: 'sid1' });
  // 부모 → 직접 띄운 자식
  assert.equal(await h.run('orchestrate.message', { branch: 'dev/a', text: ['go'] }, lead), 'sent to sid1');
  assert.deepEqual(h.mails.at(-1), { to: 'sid1', text: '[from main] go', from: 'L' });
  // 손자에게는 못 보낸다
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/b', prompt: ['x'] }, { ...h.asSession('sid1'), cwd: a });
  await assert.rejects(h.run('orchestrate.message', { branch: 'feat/b', text: ['x'] }, lead), /did not start feat\/b \(it started: dev\/a\)/);
  await assert.rejects(h.run('orchestrate.message', { branch: 'dev/a', text: ['x'] }, h.asSession('other')), /did not start dev\/a \(it started: nothing\)/);
  await assert.rejects(h.run('orchestrate.message', { branch: 'dev/a', text: ['x'] }), /only a slcode session/);
  // orchestrate new 로 맺지 않았으면 worker message 는 보낼 곳이 없다
  await assert.rejects(h.run('worker.message', { text: ['x'] }, h.asSession('L')), /not started by another slcode session/);
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/c', prompt: ['x'] });
  await assert.rejects(h.run('worker.message', { text: ['x'] }, { ...h.asSession('sid3'), cwd: `${h.repo}.worktrees/feat-c` }), /not started by another slcode session/);
  await assert.rejects(h.run('orchestrate.message', { branch: 'dev/a', text: [' '] }, lead), /message is empty/);
});

test('메시지: 받을 세션이 꺼졌으면 사유를 돌려준다', async () => {
  const h = await harness({ mailFails: true });
  const lead = h.asSession('L');
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, lead);
  await assert.rejects(h.run('orchestrate.message', { branch: 'feat/a', text: ['x'] }, lead), /session is gone/);
});

test('합류 방식과 폴더 분리는 역할 설정을 따른다', async () => {
  const h = await harness();
  const inDir = (cwd: string, sid: string) => ({ ...h.asSession(sid), cwd });
  const work = (d: string, file: string) => {
    git(d, 'config', 'user.name', 't');
    git(d, 'config', 'user.email', 't@t');
    fs.writeFileSync(`${d}/${file}`, 'x\n');
    git(d, 'add', file);
    git(d, 'commit', '-qm', file);
  };
  // 기본값: sub-orchestrator 는 자기 폴더에 merge commit, worker 는 같은 폴더에 squash
  await h.run('orchestrate.new', { role: 'sub-orchestrator', branch: 'dev/minor', prompt: ['x'] });
  const lead = `${h.repo}.worktrees/minor/dev-minor`;
  await h.run('orchestrate.enter', { role: 'sub-orchestrator' }, inDir(lead, 'L'));
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/a', prompt: ['x'] }, inDir(lead, 'L'));
  const a = `${h.repo}.worktrees/minor/feat-a`;
  work(a, 'a.txt');
  await h.run('orchestrate.enter', { role: 'worker' }, inDir(a, 'W'));
  assert.match(String(await h.run('worker.done', { submit: true, message: 'feat: a' }, inDir(a, 'W'))), /feat\/a: submitted\nmerged into dev\/minor as \w+ \(squash\)/);
  assert.match(String(await h.run('worker.done', { submit: true, message: 'merge minor' }, inDir(lead, 'L'))), /\(no-ff\)/);
  assert.equal(git(h.repo, 'log', '-1', '--format=%P', 'main').split(' ').length, 2);
  // 탭에서 바꾸면 그 값을 쓴다
  const cfg = (await h.exposed.roles.get()) as { roles: Record<string, unknown>[] };
  cfg.roles[2].merge = 'no-ff';
  cfg.roles[2].separate = true;
  await h.exposed.roles.set(cfg);
  await h.run('orchestrate.new', { role: 'worker', branch: 'feat/b', prompt: ['x'] });
  const b = `${h.repo}.worktrees/b/feat-b`;
  work(b, 'b.txt');
  assert.match(String(await h.run('worker.done', { submit: true, close: true, message: 'feat: b' }, inDir(b, 'W'))), /feat\/b: landed\nmerged into main as \w+ \(no-ff\)/);
  assert.equal(fs.existsSync(b), false);
});
