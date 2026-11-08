// 판 올리기 스크립트 (ticket plugins-release-previous) — `node --test test/release.test.ts`.
// 임시 git 저장소에 목록·plugin.json 을 두고 scripts/release.mjs 를 실제로 돌린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const SCRIPT = new URL('../scripts/release.mjs', import.meta.url).pathname;

const LIST = `{
  "name": "t",
  "plugins": [
    { "id": "ext", "version": "1.0.0", "source": "github:o/ext@v1.0.0" },
    { "id": "a", "version": "0.1.0", "path": "a", "minSuperlite": "0.20.0" },
    { "id": "b", "version": "0.2.0", "path": "b", "depends": ["a"] }
  ]
}
`;

function repo() {
  const r = `${fs.realpathSync(fs.mkdtempSync('/tmp/release-'))}/r`;
  fs.mkdirSync(r);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: r, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(`${r}/marketplace.json`, LIST);
  manifest(r, 'a', '0.1.0');
  manifest(r, 'b', '0.2.0', ['a']);
  const commit = (m: string) => {
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', m);
    return git('rev-parse', 'HEAD');
  };
  commit('init');
  const run = (...a: string[]) => spawnSync('node', [SCRIPT, ...a], { cwd: r, encoding: 'utf8' });
  const list = () => JSON.parse(fs.readFileSync(`${r}/marketplace.json`, 'utf8'));
  const line = (id: string) => list().plugins.find((p: { id: string }) => p.id === id);
  return { r, git, commit, run, list, line };
}

function manifest(r: string, id: string, version: string, depends?: string[]) {
  fs.mkdirSync(`${r}/${id}`, { recursive: true });
  fs.writeFileSync(`${r}/${id}/plugin.json`, JSON.stringify({ id, version, apiVersion: 2, ...(depends ? { depends } : {}) }, null, 2));
}

test('--help 는 0 으로 끝난다', () => {
  const { run } = repo();
  const out = run('--help');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /bump <id>/);
});

test('tag: 모든 path 줄의 판 태그를 HEAD 에 붙이고, 다시 돌려도 그대로다', () => {
  const { run, git } = repo();
  const head = git('rev-parse', 'HEAD');
  assert.equal(run('tag').status, 0);
  assert.equal(git('rev-parse', 'a-v0.1.0^{commit}'), head);
  assert.equal(git('rev-parse', 'b-v0.2.0^{commit}'), head);
  assert.equal(git('tag', '-l', 'ext*'), '');
  const again = run('tag');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /이미 HEAD 에 있다/);
});

test('tag: HEAD 의 plugin.json 이 목록과 어긋나면 아무 태그도 붙이지 않는다', () => {
  const { r, run, git, commit } = repo();
  manifest(r, 'b', '0.2.1', ['a']);
  commit('b 만 올림');
  const out = run('tag');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /version\(0\.2\.0\) 과 plugin\.json 의 version\(0\.2\.1\)/);
  assert.equal(git('tag', '-l'), '');
});

test('tag: 같은 이름의 태그가 다른 커밋에 있으면 거부한다', () => {
  const { r, run, commit } = repo();
  run('tag', 'a');
  fs.writeFileSync(`${r}/note`, 'x');
  commit('next');
  const out = run('tag', 'a');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /이미 다른 커밋/);
});

test('tag: source 줄을 지목하면 거부한다', () => {
  const { run } = repo();
  const out = run('tag', 'ext');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /source 줄/);
});

test('bump: path 줄의 직전 판을 previous 맨 앞에 옮기고 새 판은 plugin.json 에서 읽는다', () => {
  const { r, run, line } = repo();
  run('tag');
  manifest(r, 'a', '0.2.0', ['ext']);
  const out = run('bump', 'a', '--min-superlite', '0.21.0');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(line('a'), {
    id: 'a',
    version: '0.2.0',
    path: 'a',
    minSuperlite: '0.21.0',
    depends: ['ext'],
    previous: [{ version: '0.1.0', ref: 'a-v0.1.0', minSuperlite: '0.20.0', depends: [] }],
  });
  // 다른 줄과 파일 꼴은 그대로 (한 줄에 플러그인 하나)
  const text = fs.readFileSync(`${r}/marketplace.json`, 'utf8');
  assert.equal(
    text,
    LIST.replace(
      '{ "id": "a", "version": "0.1.0", "path": "a", "minSuperlite": "0.20.0" }',
      '{ "id": "a", "version": "0.2.0", "path": "a", "minSuperlite": "0.21.0", "depends": ["ext"], "previous": [{ "version": "0.1.0", "ref": "a-v0.1.0", "minSuperlite": "0.20.0", "depends": [] }] }',
    ),
  );
});

test('bump: 두 번 올리면 더 최근 판이 previous 앞에 오고, 새 판에 depends 가 없으면 줄에서 지운다', () => {
  const { r, run, line, commit } = repo();
  run('tag', 'b');
  manifest(r, 'b', '0.3.0', ['a']);
  assert.equal(run('bump', 'b').status, 0);
  commit('b 0.3.0');
  assert.equal(run('tag', 'b').status, 0);
  manifest(r, 'b', '0.4.0');
  assert.equal(run('bump', 'b').status, 0);
  const b = line('b');
  assert.equal(b.version, '0.4.0');
  assert.equal(b.depends, undefined);
  assert.deepEqual(b.previous.map((p: { ref: string }) => p.ref), ['b-v0.3.0', 'b-v0.2.0']);
  assert.deepEqual(b.previous[0].depends, ['a']);
});

test('bump: plugin.json 의 판을 올리지 않았거나 직전 판 태그가 없으면 목록을 고치지 않는다', () => {
  const { r, run } = repo();
  const notRaised = run('bump', 'a');
  assert.equal(notRaised.status, 1);
  assert.match(notRaised.stderr, /보다 높지 않다/);
  manifest(r, 'a', '0.1.1');
  const noTag = run('bump', 'a');
  assert.equal(noTag.status, 1);
  assert.match(noTag.stderr, /a-v0\.1\.0 가 로컬에 없다/);
  assert.equal(fs.readFileSync(`${r}/marketplace.json`, 'utf8'), LIST);
});

test('bump: source 줄은 --source·--version 으로 올리고 previous 의 ref 는 기존 @ref 다', () => {
  const { run, line } = repo();
  assert.equal(run('bump', 'ext', '--version', '1.1.0').status, 1);
  assert.equal(run('bump', 'ext', '--source', 'github:o/ext', '--version', '1.1.0').status, 1);
  const out = run('bump', 'ext', '--source', 'github:o/ext@v1.1.0', '--version', '1.1.0', '--depends', 'a');
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(line('ext'), {
    id: 'ext',
    version: '1.1.0',
    source: 'github:o/ext@v1.1.0',
    depends: ['a'],
    previous: [{ version: '1.0.0', ref: 'v1.0.0', depends: [] }],
  });
});

test('bump: path 줄에 --version 을 주면 거부한다', () => {
  const { run } = repo();
  const out = run('bump', 'a', '--version', '9.9.9');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /path 줄/);
});

test('check: 올린 뒤 태그까지 붙이면 이상 없음', () => {
  const { r, run, commit } = repo();
  run('tag');
  manifest(r, 'a', '0.2.0');
  run('bump', 'a');
  commit('a 0.2.0');
  run('tag', 'a');
  const out = run('check');
  assert.equal(out.status, 0, out.stdout);
  assert.match(out.stdout, /이상 없음/);
});

test('check: previous 의 태그가 없거나, 그 시점 plugin.json 과 어긋나거나, 짧은 해시면 오류', () => {
  const { r, run, git } = repo();
  const head = git('rev-parse', 'HEAD');
  const list = JSON.parse(LIST);
  list.plugins[1].previous = [
    { version: '0.0.9', ref: 'a-v0.0.9' },
    { version: '0.0.8', ref: head },
    { version: '0.1.0', ref: head.slice(0, 7) },
  ];
  list.plugins[2].previous = [{ version: '0.2.0', ref: head }];
  fs.writeFileSync(`${r}/marketplace.json`, JSON.stringify(list));
  const out = run('check');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /a previous 0\.0\.9: 로컬에 태그 a-v0\.0\.9 가 없다/);
  assert.match(out.stdout, /version\(0\.0\.8\) 과 plugin\.json 의 version\(0\.1\.0\)/);
  assert.match(out.stdout, new RegExp(`a previous 0\\.1\\.0: 로컬에 태그 ${head.slice(0, 7)} 가 없다`));
  // depends 를 뺀 판은 최신 줄의 depends 로 대조한다 — b 는 맞다
  assert.doesNotMatch(out.stdout, /b previous/);
});

test('check: previous 의 depends 가 그 시점 plugin.json 과 다르면 오류', () => {
  const { r, run } = repo();
  run('tag', 'b');
  const list = JSON.parse(LIST);
  list.plugins[2].previous = [{ version: '0.2.0', ref: 'b-v0.2.0', depends: [] }];
  fs.writeFileSync(`${r}/marketplace.json`, JSON.stringify(list));
  const out = run('check');
  assert.equal(out.status, 1);
  assert.match(out.stdout, /b previous b-v0\.2\.0: b: 목록의 depends\(\) 와 plugin\.json 의 depends\(a\)/);
});
