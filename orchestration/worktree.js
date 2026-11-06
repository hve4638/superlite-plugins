// 위임·동기화·합류에 필요한 워크트리 관리 (사용자 2026-11-04: wtree 대신 필요한 기능만 내장). 규칙 파일·정책 판정은 없다 — 역할은 main.js 가 본다.
//
// 자리: <저장소>.worktrees/ (저장소 옆, 사용자 결정 — 안에 두면 Node 해석·상위 설정이 본체를 읽는다). 그 안의 .gitignore(*)가 상위 폴더 저장소의 추적을 막는다.
// 폴더 분리 역할은 <루트>/<브랜치 끝 이름>/<브랜치>, 그 밖의 역할은 자기를 띄운 세션과 같은 폴더.
// 부모 브랜치: git config branch.<브랜치>.superliteparent — 브랜치를 지우면 git 이 함께 지운다.
// 합류: merge-tree 로 충돌을 메모리에서 미리 본 뒤 커밋을 만들고 부모를 fast-forward 한다. 그 사이 부모가 움직이면 ff 가 실패하므로 잠금이 필요 없다.
// squash 는 wtree 와 같다 (사용자 2026-11-05): 갈라진 지점으로 reset --soft → git commit → 부모 위로 rebase. 커밋 훅·서명이 돈다. no-ff 는 wtree 처럼 commit-tree 로 부모 둘짜리 커밋을 만든다.
// 끝나면 어느 쪽이든 브랜치와 부모가 같은 커밋이다 — no-ff 는 조상 관계를 유지해서 이 브랜치의 자식이 sync 해도 안전하고,
// squash 는 브랜치를 옮겨 쓰므로 자식이 있는 브랜치에는 충돌·되돌림 위험이 있다 (이 저장소 사고 2026-09-12·09-30). 그래서 기본값은 자식을 띄우는 역할만 no-ff.
// 유실 판단은 "부모에 합쳐도 트리가 그대로인가" 하나 — 조상·squash·변경 없음을 모두 덮는다 (wtree reflected_in_parent 의 마지막 시험). git 2.38 이상이 필요하다.
// git 은 셸 없이 직접 부른다 — api.proc 는 Windows 에서 cmd /C 라 인용이 깨지고 여러 줄 메시지를 못 넘긴다. ponytail: no-ff 의 커밋 훅·서명은 commit-tree 라 돌지 않는다 (wtree 도 같다). wtree 와 달리 변경이 있으면 stash 하지 않고 거절한다.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function git(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const c = spawn('git', args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    c.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    c.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    c.on('error', (e) => reject(new Error(`cannot run git in ${cwd}: ${e.message}`)));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) c.stdin.end(input);
  });
}

async function must(cwd, args, what) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`${what}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

const rootOf = (main) => path.normalize(`${main}.worktrees`);
const folderOf = (branch) => branch.replaceAll('/', '-');

/** cwd 가 있는 워크트리 — top·branch·부모 브랜치와, 저장소의 워크트리 목록(맨 앞이 본체) */
export async function locate(cwd) {
  const top = await must(cwd, ['rev-parse', '--show-toplevel'], 'this must run inside a git repository');
  const branch = await must(top, ['rev-parse', '--abbrev-ref', 'HEAD'], 'cannot read the current branch');
  if (branch === 'HEAD') throw new Error('this workspace is not on a branch (detached HEAD)');
  const list = [];
  for (const line of (await must(top, ['worktree', 'list', '--porcelain'], 'cannot list workspaces')).split('\n')) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null });
    else if (line.startsWith('branch refs/heads/')) list.at(-1).branch = line.slice('branch refs/heads/'.length);
  }
  const parent = (await git(top, ['config', '--get', `branch.${branch}.superliteparent`])).stdout.trim() || null;
  return { top, branch, parent, main: list[0].path, list };
}

/** 이 브랜치의 자식으로 새 브랜치와 워크트리를 만들고 그 폴더를 돌려준다 */
export async function create(w, branch, separate) {
  const root = rootOf(w.main);
  let dir;
  if (separate) {
    const own = path.join(root, branch.split('/').pop());
    if (await fs.access(own).then(() => true, () => false)) throw new Error(`folder already exists: ${own}`);
    dir = path.join(own, folderOf(branch));
  } else {
    dir = path.join(w.top === w.main ? root : path.dirname(w.top), folderOf(branch));
  }
  if (dir.startsWith(root + path.sep)) {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, '.gitignore'), '*\n', { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
  }
  await must(w.top, ['worktree', 'add', '-q', '-b', branch, dir], `cannot create workspace ${branch}`);
  await must(w.top, ['config', `branch.${branch}.superliteparent`, w.branch], `cannot record the parent of ${branch}`);
  return dir;
}

function parentOf(w) {
  if (w.parent === null) throw new Error(`${w.branch} has no recorded parent: worker commands work only on branches made by superlite orchestrate new`);
  return w.parent;
}

/** ours 에 theirs 를 합친 트리 — 충돌이면 tree 가 null 이고 files 에 파일 이름들 */
async function mergedTree(cwd, ours, theirs) {
  const r = await git(cwd, ['merge-tree', '--write-tree', ours, theirs]);
  if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed (git 2.38 or later is required): ${r.stderr.trim()}`);
  const [tree, ...rest] = r.stdout.split('\n');
  if (r.code === 0) return { tree: tree.trim(), files: '' };
  const end = rest.indexOf('');
  const files = new Set(rest.slice(0, end < 0 ? rest.length : end).map((l) => l.split('\t')[1]).filter(Boolean));
  return { tree: null, files: [...files].join(', ') };
}

export async function sync(w) {
  const p = parentOf(w);
  if ((await git(w.top, ['merge-base', '--is-ancestor', p, 'HEAD'])).code === 0) return `${w.branch} is already up to date with ${p}`;
  const { tree, files } = await mergedTree(w.top, 'HEAD', p);
  if (tree === null) throw new Error(`merging ${p} would conflict in: ${files}. Nothing was changed. To resolve it, run git merge ${p} here, fix the files, and commit`);
  await must(w.top, ['merge', '-q', '--no-edit', p], `merging ${p} failed`);
  return `synced ${w.branch} with ${p}`;
}

async function refuseOpenChildren(w) {
  const r = await git(w.top, ['config', '--get-regexp', '^branch\\..*\\.superliteparent$']);
  const open = r.stdout.split('\n').map((l) => /^branch\.(.+)\.superliteparent (.+)$/.exec(l)).filter((m) => m?.[2] === w.branch).map((m) => m[1]);
  if (open.length > 0) throw new Error(`not removed: branches started from ${w.branch} are still open (${open.join(', ')})`);
}

/** 브랜치를 압축해 base 위로 옮기고 그 커밋을 돌려준다. 실패하면 브랜치를 orig 로 되돌린다. 인덱스와 파일이 orig 그대로일 때는 --soft 로, rebase 뒤에는 --keep 으로 돌아간다 */
async function squashOnto(top, base, orig, message) {
  const fork = await must(top, ['merge-base', base, 'HEAD'], 'cannot find where this branch started');
  await must(top, ['reset', '-q', '--soft', fork], 'cannot squash this branch');
  const made = await git(top, ['commit', '-q', '-m', message]);
  if (made.code !== 0) {
    await git(top, ['reset', '-q', '--soft', orig]);
    throw new Error(`commit failed (hook or signing?). Nothing was merged\n${(made.stderr || made.stdout).trim()}`);
  }
  const rebased = await git(top, ['rebase', '-q', base]);
  if (rebased.code !== 0) {
    await git(top, ['rebase', '--abort']);
    await git(top, ['reset', '-q', '--keep', orig]);
    throw new Error(`rebase failed. Nothing was merged. Retry\n${(rebased.stderr || rebased.stdout).trim()}`);
  }
  return must(top, ['rev-parse', 'HEAD'], 'cannot read HEAD');
}

/** 부모에 합친다. how: 'squash' | 'no-ff'. closing 이면 뒤이어 지우므로 미추적 파일·열린 자식도 합치기 전에 거절한다 */
export async function submit(w, how, message, closing) {
  const p = parentOf(w);
  const dirty = (await must(w.top, closing ? ['status', '--porcelain'] : ['status', '--porcelain', '--untracked-files=no'], 'cannot read the status')).trim();
  if (dirty !== '') throw new Error(`commit or remove these first:\n${dirty}`);
  if (closing) await refuseOpenChildren(w);
  const base = await must(w.top, ['rev-parse', `refs/heads/${p}`], `cannot read ${p}`);
  const { tree, files } = await mergedTree(w.top, base, 'HEAD');
  if (tree === null) throw new Error(`handing in to ${p} would conflict in: ${files}. Nothing was changed. Run superlite worker sync, resolve it, and retry`);
  if (tree === await must(w.top, ['rev-parse', `${base}^{tree}`], `cannot read ${p}`)) throw new Error(`nothing to hand in: ${p} already has this work. To remove this workspace, run superlite worker done --close`);
  const orig = await must(w.top, ['rev-parse', 'HEAD'], 'cannot read HEAD');
  const commit = how === 'no-ff' ? await must(w.top, ['commit-tree', tree, '-p', base, '-p', 'HEAD', '-m', message], 'cannot create the commit') : await squashOnto(w.top, base, orig, message);
  const at = w.list.find((x) => x.branch === p)?.path;
  const moved = at ? await git(at, ['merge', '-q', '--ff-only', commit]) : await git(w.top, ['update-ref', `refs/heads/${p}`, commit, base]);
  if (moved.code !== 0) {
    await git(w.top, ['reset', '-q', '--keep', orig]); // squash 는 브랜치를 이미 옮겼다 — "합치지 않았다" 가 참이 되게 되돌린다
    throw new Error(`could not move ${p}: it has moved, or changes in ${at ?? 'it'} touch the same files. Nothing was merged. Retry when that is cleared\n${moved.stderr.trim()}`);
  }
  if (how === 'no-ff') await must(w.top, ['reset', '-q', '--keep', commit], `merged into ${p} as ${commit.slice(0, 8)}, but could not move ${w.branch} there`);
  return `merged into ${p} as ${commit.slice(0, 8)} (${how})`;
}

/** 지금 상태의 확인 키 — 커밋·변경·미추적 파일이 바뀌면 키도 바뀌어 옛 확인이 듣지 않는다 */
async function stateKey(top) {
  const head = await must(top, ['rev-parse', 'HEAD'], 'cannot read HEAD');
  const diff = (await git(top, ['diff', 'HEAD'])).stdout;
  const others = (await git(top, ['ls-files', '--others', '--exclude-standard'])).stdout;
  const hashes = others === '' ? '' : (await git(top, ['hash-object', '--stdin-paths'], others)).stdout;
  return createHash('sha1').update([head, diff, others, hashes].join('\0')).digest('hex').slice(0, 5);
}

/** 지우면 잃는 것 — 없으면 빈 목록 */
async function risks(w) {
  const out = [];
  if ((await git(w.top, ['status', '--porcelain'])).stdout.trim() !== '') out.push('uncommitted changes');
  const { tree } = await mergedTree(w.top, w.parent, 'HEAD');
  if (tree !== await must(w.top, ['rev-parse', `${w.parent}^{tree}`], `cannot read ${w.parent}`)) out.push(`commits not in ${w.parent}`);
  return out;
}

/** 워크트리와 브랜치를 지운다. 부모 기록이 없는 브랜치는 이 플러그인 것이 아니라 지우지 않는다. key 가 없으면 잃을 것이 있을 때 거절하고, 있으면 지금 상태와 맞을 때 잃을 것까지 버린다 */
export async function remove(w, key) {
  parentOf(w);
  await refuseOpenChildren(w);
  const lost = await risks(w);
  const now = await stateKey(w.top);
  if (key === null && lost.length > 0) throw new Error(`not removed: ${lost.join(', ')}. Hand it in with --submit, or discard it (after the user confirms) with: superlite worker done --abandon ${now}`);
  if (key !== null && key !== now) throw new Error(`not removed: the key does not match the current state (${lost.join(', ') || 'nothing at risk'}). The current key is ${now}: superlite worker done --abandon ${now}`);
  await must(w.main, key === null ? ['worktree', 'remove', w.top] : ['worktree', 'remove', '--force', w.top], `cannot remove workspace ${w.top}`);
  await must(w.main, ['branch', '-D', w.branch], `workspace removed, but could not delete branch ${w.branch}`);
  const up = path.dirname(w.top);
  if (path.dirname(path.normalize(up)) === rootOf(w.main)) await fs.rmdir(up).catch(() => {}); // 분리 폴더 — 남은 것이 있으면 그대로 둔다
}
