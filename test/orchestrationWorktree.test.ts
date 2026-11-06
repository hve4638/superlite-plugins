// orchestration 의 워크트리 관리 (orchestration/worktree.js) — 실제 git 으로 임시 저장소에서 돌린다. `node --test test/orchestrationWorktree.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { create, locate, remove, submit, sync } from '../orchestration/worktree.js';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir: string, file: string, text: string) => fs.writeFileSync(path.join(dir, file), text);
function commit(dir: string, file: string, text: string, msg = `edit ${file}`) {
  write(dir, file, text);
  git(dir, 'add', file);
  git(dir, 'commit', '-qm', msg);
}
function repo() {
  const r = path.join(fs.realpathSync(fs.mkdtempSync('/tmp/orch-wt-')), 'r');
  fs.mkdirSync(r);
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.name', 't');
  git(r, 'config', 'user.email', 't@t');
  commit(r, 'a.txt', 'a\n');
  return r;
}
const child = async (from: string, branch: string, separate = false) => create(await locate(from), branch, separate);
const oid = (cwd: string, rev: string) => git(cwd, 'rev-parse', rev);

test('자리: 저장소 옆 .worktrees 에 .gitignore 와 함께 만들고, 부모 브랜치를 기록한다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  assert.equal(d, `${r}.worktrees/feat-x`);
  assert.equal(fs.readFileSync(`${r}.worktrees/.gitignore`, 'utf8'), '*\n');
  assert.equal((await locate(d)).parent, 'main');
  assert.equal(git(r, 'status', '--porcelain'), '');
  write(`${r}.worktrees`, '.gitignore', 'kept\n');
  await child(r, 'feat/y');
  assert.equal(fs.readFileSync(`${r}.worktrees/.gitignore`, 'utf8'), 'kept\n');
});

test('자리: 분리 역할은 자기 폴더에, 그 자식은 같은 폴더에, 이름이 겹치면 거절한다', async () => {
  const r = repo();
  const lead = await child(r, 'dev/minor', true);
  assert.equal(lead, `${r}.worktrees/minor/dev-minor`);
  assert.equal(await child(lead, 'feat/x'), `${r}.worktrees/minor/feat-x`);
  assert.equal((await locate(`${r}.worktrees/minor/feat-x`)).parent, 'dev/minor');
  await assert.rejects(child(r, 'fix/minor', true), /folder already exists/);
  await assert.rejects(child(r, 'feat/z-dup'.replace('z-dup', 'x')), /cannot create workspace/);
});

test('sync: 부모를 받아 오고, 충돌은 아무것도 바꾸지 않고 거절한다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  assert.match(await sync(await locate(d)), /already up to date/);
  commit(r, 'b.txt', 'b\n');
  assert.match(await sync(await locate(d)), /synced feat\/x with main/);
  assert.equal(fs.readFileSync(`${d}/b.txt`, 'utf8'), 'b\n');
  commit(r, 'a.txt', 'main\n');
  commit(d, 'a.txt', 'mine\n');
  const before = oid(d, 'HEAD');
  await assert.rejects(sync(await locate(d)), /would conflict in: a\.txt.*git merge main/);
  assert.equal(oid(d, 'HEAD'), before);
  assert.equal(git(d, 'status', '--porcelain'), '');
  await assert.rejects(sync(await locate(r)), /no recorded parent/);
});

test('submit squash: 부모에 커밋 하나, 브랜치는 부모와 같아지고, 자리는 남는다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  commit(d, 'b.txt', '1\n');
  commit(d, 'b.txt', '2\n');
  commit(r, 'c.txt', 'c\n'); // 부모가 먼저 움직여도 합쳐진다
  const base = oid(r, 'main');
  const out = await submit(await locate(d), 'squash', 'feat: x\n\n<reason>\n"why"\n</reason>', false);
  assert.match(out, /merged into main as [0-9a-f]{8} \(squash\)/);
  assert.equal(oid(r, 'main^'), base);
  assert.equal(git(r, 'log', '-1', '--format=%P', 'main').split(' ').length, 1);
  assert.equal(git(r, 'log', '-1', '--format=%B', 'main'), 'feat: x\n\n<reason>\n"why"\n</reason>');
  assert.equal(fs.readFileSync(`${r}/b.txt`, 'utf8'), '2\n');
  assert.equal(oid(d, 'HEAD'), oid(r, 'main'));
  assert.ok(fs.existsSync(d));
  assert.equal(fs.readFileSync(`${d}/c.txt`, 'utf8'), 'c\n');
  await assert.rejects(submit(await locate(d), 'squash', 'again', false), /nothing to hand in/);
});

test('submit squash: wtree 와 같은 순서 — 커밋 훅이 돌고, 갈라진 뒤 sync 한 브랜치도 커밋 하나로 합친다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  const log = `${r}/../hook.log`;
  fs.mkdirSync(`${r}/.git/hooks`, { recursive: true });
  fs.writeFileSync(`${r}/.git/hooks/pre-commit`, `#!/bin/sh\necho pre-commit >> ${log}\n`, { mode: 0o755 });
  commit(d, 'b.txt', '1\n');
  commit(r, 'c.txt', 'c\n');
  await sync(await locate(d));
  commit(d, 'b.txt', '2\n');
  commit(r, 'e.txt', 'e\n');
  fs.rmSync(log);
  const base = oid(r, 'main');
  await submit(await locate(d), 'squash', 'feat: x', false);
  assert.equal(fs.readFileSync(log, 'utf8'), 'pre-commit\n');
  assert.equal(oid(r, 'main^'), base);
  assert.equal(git(r, 'log', '-1', '--format=%s', 'main'), 'feat: x');
  assert.equal(git(r, 'log', '-1', '--format=%P', 'main').split(' ').length, 1);
  assert.deepEqual(['a.txt', 'b.txt', 'c.txt', 'e.txt'].map((n) => fs.existsSync(`${r}/${n}`)), [true, true, true, true]);
  assert.equal(fs.readFileSync(`${r}/b.txt`, 'utf8'), '2\n');
  assert.equal(oid(d, 'HEAD'), oid(r, 'main'));
  assert.equal(git(d, 'status', '--porcelain'), '');
});

test('submit squash 실패: 훅이 거절하면 브랜치·부모·파일이 그대로다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  commit(d, 'b.txt', '1\n');
  commit(d, 'b.txt', '2\n');
  fs.mkdirSync(`${r}/.git/hooks`, { recursive: true });
  fs.writeFileSync(`${r}/.git/hooks/pre-commit`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const [main0, head0] = [oid(r, 'main'), oid(d, 'HEAD')];
  await assert.rejects(submit(await locate(d), 'squash', 'm', false), /commit failed.*Nothing was merged/s);
  assert.deepEqual([oid(r, 'main'), oid(d, 'HEAD')], [main0, head0]);
  assert.equal(git(d, 'status', '--porcelain'), '');
  assert.equal(fs.readFileSync(`${d}/b.txt`, 'utf8'), '2\n');
});

test('submit no-ff: 조상 관계를 유지해 자식의 sync 가 안전하다', async () => {
  const r = repo();
  const lead = await child(r, 'dev/minor', true);
  const w = await child(lead, 'feat/x');
  commit(w, 'w.txt', 'w\n');
  await submit(await locate(w), 'squash', 'feat: w', false);
  const other = await child(lead, 'feat/y');
  commit(other, 'y.txt', 'y\n');
  const headOfLead = oid(lead, 'HEAD');
  assert.match(await submit(await locate(lead), 'no-ff', 'merge lead', false), /\(no-ff\)/);
  assert.equal(git(r, 'log', '-1', '--format=%P', 'main').split(' ')[1], headOfLead);
  assert.equal(git(r, 'merge-base', '--is-ancestor', headOfLead, 'main'), '');
  assert.equal(oid(lead, 'HEAD'), oid(r, 'main'));
  assert.match(await sync(await locate(other)), /synced feat\/y with dev\/minor/);
  assert.equal(fs.readFileSync(`${other}/y.txt`, 'utf8'), 'y\n');
});

test('submit 거절: 변경·충돌·부모 쪽 겹치는 변경은 양쪽을 그대로 둔다, 미추적은 남기는 제출을 막지 않는다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  commit(d, 'a.txt', 'mine\n');
  const [main0, head0] = [oid(r, 'main'), oid(d, 'HEAD')];
  write(d, 'a.txt', 'dirty\n');
  await assert.rejects(submit(await locate(d), 'squash', 'm', false), /commit or remove these first/);
  git(d, 'checkout', '-q', '--', 'a.txt');
  write(r, 'a.txt', 'wip in parent\n'); // 부모 체크아웃의 작업 중 변경
  await assert.rejects(submit(await locate(d), 'squash', 'm', false), /could not move main.*Nothing was merged/s);
  assert.deepEqual([oid(r, 'main'), oid(d, 'HEAD')], [main0, head0]);
  assert.equal(fs.readFileSync(`${r}/a.txt`, 'utf8'), 'wip in parent\n');
  git(r, 'checkout', '-q', '--', 'a.txt');
  commit(r, 'a.txt', 'main\n');
  const main1 = oid(r, 'main');
  await assert.rejects(submit(await locate(d), 'squash', 'm', false), /would conflict in: a\.txt.*worker sync/);
  assert.deepEqual([oid(r, 'main'), oid(d, 'HEAD')], [main1, head0]);
  const e = await child(r, 'feat/e');
  commit(e, 'e.txt', 'e\n');
  write(e, 'note.txt', 'untracked\n');
  await submit(await locate(e), 'squash', 'm', false);
  assert.equal(fs.readFileSync(`${e}/note.txt`, 'utf8'), 'untracked\n');
});

test('제출 뒤 지우기: 미추적 파일·열린 자식은 합치기 전에 거절하고, 깨끗하면 합치고 지운다', async () => {
  const r = repo();
  const lead = await child(r, 'dev/minor', true);
  const w = await child(lead, 'feat/x');
  commit(lead, 'l.txt', 'l\n');
  const before = oid(r, 'main');
  await assert.rejects(submit(await locate(lead), 'no-ff', 'm', true), /still open \(feat\/x\)/);
  assert.equal(oid(r, 'main'), before);
  await remove(await locate(w), null);
  write(lead, 'note.txt', 'n\n');
  await assert.rejects(submit(await locate(lead), 'no-ff', 'm', true), /commit or remove these first/);
  assert.equal(oid(r, 'main'), before);
  fs.rmSync(`${lead}/note.txt`);
  const at = await locate(lead);
  await submit(at, 'no-ff', 'm', true);
  await remove(at, null);
  assert.equal(fs.readFileSync(`${r}/l.txt`, 'utf8'), 'l\n');
  assert.equal(fs.existsSync(`${r}.worktrees/minor`), false, '비어 있는 분리 폴더도 치운다');
  assert.equal(git(r, 'branch', '--list', 'dev/minor'), '');
  assert.equal(git(r, 'config', '--get-regexp', 'superliteparent|^core\\.bare$').includes('superliteparent'), false);
});

test('지우기: 잃을 것이 있으면 키를 주고 거절, 틀린 키·바뀐 상태는 거절, 맞는 키만 버린다', async () => {
  const r = repo();
  const d = await child(r, 'feat/x');
  commit(d, 'b.txt', 'b\n');
  const refused = await remove(await locate(d), null).then(() => '', (e: Error) => e.message);
  assert.match(refused, /not removed: commits not in main.*--abandon [0-9a-f]{5}/);
  const key = /--abandon ([0-9a-f]{5})/.exec(refused)![1];
  write(d, 'note.txt', 'n\n');
  await assert.rejects(remove(await locate(d), key), /does not match the current state \(uncommitted changes, commits not in main\)/);
  fs.rmSync(`${d}/note.txt`);
  await remove(await locate(d), key);
  assert.equal(fs.existsSync(d), false);
  assert.equal(git(r, 'branch', '--list', 'feat/x'), '');
  // squash 로 합친 뒤 부모가 더 움직여도 잃을 것이 없다
  const e = await child(r, 'feat/e');
  commit(e, 'e.txt', 'e\n');
  await submit(await locate(e), 'squash', 'm', false);
  commit(r, 'z.txt', 'z\n');
  await remove(await locate(e), null);
  assert.equal(fs.existsSync(e), false);
});
