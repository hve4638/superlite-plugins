// slcode team --worktree 가 만드는 자리의 사본 (slcode v0.5.11 src/worktree.ts createWorktree·removeWorktree) — orchestration 테스트가 실제 slcode 없이 쓴다.
// 이 cwd 가 속한 checkout 의 HEAD 에서 브랜치 <이름> 을 <repo>.worktrees/<이름의 / 를 -> 에 꺼내고, 그 checkout 의 브랜치를 branch.<이름>.slcodeparent 에 적는다.
// slcode 쪽 꼴이 바뀌면 함께 맞춘다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** 만든 폴더를 돌려준다 */
export function teamWorktree(cwd: string, branch: string): string {
  const from = git(cwd, 'rev-parse', '--show-toplevel');
  const common = git(from, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const repo = path.basename(common) === '.git' ? path.dirname(common) : from;
  const root = `${repo}.worktrees`;
  const dir = path.join(root, branch.replaceAll('/', '-'));
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, '.gitignore'))) fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  git(from, 'worktree', 'add', '-q', '-b', branch, dir, 'HEAD');
  git(repo, 'config', `branch.${branch}.slcodeparent`, git(from, 'symbolic-ref', '--short', 'HEAD'));
  return dir;
}

/** clean-worktree 가 지우는 것 — worktree 와 브랜치(slcodeparent 도 함께 지워진다) */
export function removeTeamWorktree(dir: string) {
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const repo = path.dirname(common);
  git(repo, 'worktree', 'remove', '--force', dir);
  git(repo, 'branch', '-D', branch);
}
