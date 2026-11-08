#!/usr/bin/env node
// 판 올리기 (ticket plugins-release-previous) — marketplace.json 의 한 줄을 새 판으로 바꾸며 직전 판을 previous 맨 앞에 옮기고,
// path 줄의 판 커밋에 로컬 태그 <id>-v<version> 을 붙이고, previous 가 가리키는 태그·plugin.json 을 점검한다. 의존성 없음. 도움말: --help
// 목록 줄과 plugin.json 의 대조 규칙은 relay 의 market.rs mismatch 와 같다 (id·version 같음, depends 는 순서 무관·공백 무시)
// depends 의 범위(ticket plugins-release-depends-range): bump 는 새 판이 다른 줄의 범위를 깨면 거부하고, check 는 줄마다 범위가 목록의 판을
// 받는지와 범위를 적은 판의 minSuperlite 를 본다
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const LIST = 'marketplace.json';
// depends 범위를 읽는 첫 superlite (master 통지 2026-11-08 — 바뀌면 master 가 알린다). 그 전 판은 범위를 적은 의존을 찾지 못한다
const RANGE_MIN_SUPERLITE = '0.22.0';

const HELP = `node scripts/release.mjs <명령> [인자]

명령
  bump <id>    marketplace.json 의 <id> 줄을 새 판으로 바꾼다. 올리기 전 줄의 version·minSuperlite·depends 를
               previous 맨 앞에 옮긴다. 작업 트리의 marketplace.json 만 고치고 커밋·태그는 하지 않는다.
               새 판이 목록의 다른 줄 depends 범위를 깨면 거부한다: 의존하는 쪽을 먼저 올린다 (같은 커밋에 넣는다).
               새 depends 에 범위가 있으면 minSuperlite 가 ${RANGE_MIN_SUPERLITE} 이상이어야 한다.
               path 줄: 새 판의 version·depends 는 <path>/plugin.json 에서 읽는다. previous 의 ref 는
                        <id>-v<직전 version> 이고, 그 태그가 로컬에 있어야 한다.
               source 줄: --source <저장소@ref> 와 --version 이 필요하다. previous 의 ref 는 기존 source 의 @ref.
                        depends 는 --depends 를 주지 않으면 그대로 둔다. plugin.json 은 다른 저장소라 대조하지 않는다.
    --min-superlite <판>   새 줄의 minSuperlite (주지 않으면 기존 값을 둔다)
    --source <spec@ref>    source 줄의 새 출처
    --version <판>         source 줄의 새 판
    --depends <a,b>        source 줄의 새 depends (빈 값이면 없앰)

  tag [<id>...]  HEAD 커밋의 marketplace.json 과 plugin.json 이 맞는지 보고 HEAD 에 로컬 태그 <id>-v<version> 을
               붙인다. id 를 빼면 모든 path 줄. 이미 HEAD 를 가리키면 건너뛰고, 다른 커밋을 가리키면 오류.
               push 는 하지 않는다.

  check        작업 트리의 marketplace.json 을 점검한다. path 줄마다 plugin.json 과 목록 줄, 있으면 <id>-v<version>
               태그 시점의 plugin.json, previous 마다 ref(태그나 40자 커밋)가 로컬에 있는지와 그 시점
               plugin.json 의 version·depends 를 본다. source 줄의 previous 는 다른 저장소라 보지 않는다.
               줄마다 depends 항목의 꼴, 범위가 목록에 있는 의존의 version 을 받는지, 범위를 적은 판(previous 포함)의
               minSuperlite 가 ${RANGE_MIN_SUPERLITE} 이상인지도 본다.
               문제가 있으면 종료 코드 1.

판 올리기 순서 (path 줄)
  1. node scripts/release.mjs check          직전 판의 태그가 있는지 확인 (없으면 그 판 커밋에서 tag <id>)
  2. <path>/plugin.json 의 version(·depends)을 올린다
  3. node scripts/release.mjs bump <id>     의존 판이 다른 줄의 범위를 깨면, 의존하는 쪽의 depends·version 을 올려 먼저 bump
  4. plugin.json·marketplace.json 을 함께 커밋한다
  5. node scripts/release.mjs tag <id>
  6. git push 와 git push origin <id>-v<version> 은 사람이 한다
`;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitTry(root, ...args) {
  try {
    return git(root, ...args);
  } catch {
    return null;
  }
}

/** major.minor.patch — relay 의 numbers 와 같이 patch 뒤 글자는 버린다. 꼴이 아니면 null */
function numbers(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? m.slice(1, 4).map(Number) : null;
}

function higher(a, b) {
  const x = numbers(a);
  const y = numbers(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// ---- depends 범위 — code-superlight front/src/model/pluginVersion.ts 의 parseDep·satisfies 사본 (npm semver 범위의 부분집합).
// 항목은 "id" 또는 "id<범위>", 범위는 공백으로 이은 ^ ~ >= > <= < = 비교식(연산자 없는 판은 = 이고 id 와 띄운다)이 모두 맞아야 한다

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v ?? '').trim());
  return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null;
}

/** semver 2.0 우선순위 — 음수면 a 가 낮다 */
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i] - b.nums[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 범위 → 비교식들. 꼴이 아니면 null (빈 범위는 []) */
function comparators(range) {
  const out = [];
  for (const tok of range.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(tok);
    const v = m ? semver(m[2]) : null;
    if (m === null || v === null) return null;
    const op = m[1] ?? '=';
    if (op === '^' || op === '~') {
      const [a, b, c] = v.nums;
      const hi = op === '~' ? [a, b + 1, 0] : a > 0 ? [a + 1, 0, 0] : b > 0 ? [0, b + 1, 0] : [0, 0, c + 1];
      out.push({ op: '>=', v }, { op: '<', v: { nums: hi, pre: ['0'] } });
    } else out.push({ op, v });
  }
  return out;
}

/** depends 항목 → id·범위(빈 값 = 아무 판). 꼴이 아니면 null */
function parseDep(s) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$/.exec(String(s));
  if (m === null) return null;
  const rest = m[2].trim();
  if (rest !== '' && /^[0-9v]/.test(rest) && !/^\s/.test(m[2])) return null;
  if (comparators(rest) === null) return null;
  return { id: m[1], range: rest.split(/\s+/).filter(Boolean).join(' ') };
}

/** 판이 범위에 맞는가 — 판을 읽지 못하면 맞지 않는다 */
function satisfies(version, range) {
  const cs = comparators(range);
  const v = semver(version);
  if (cs === null || v === null) return false;
  if (v.pre.length > 0 && !cs.some((c) => c.v.pre.length > 0 && c.v.nums.every((n, i) => n === v.nums[i]))) return false;
  return cs.every(({ op, v: w }) => {
    const d = compare(v, w);
    return op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : op === '>=' ? d >= 0 : d === 0;
  });
}

/** 목록의 다른 줄 중 depends 범위가 <id> 의 판 version 을 받지 않는 항목들 ("줄id 의 depends 항목") */
function breaks(list, id, version) {
  const out = [];
  for (const p of list.plugins) {
    if (p.id === id) continue;
    for (const d of p.depends ?? []) {
      const dep = parseDep(d);
      if (dep?.id === id && dep.range && !satisfies(version, dep.range)) out.push(`${p.id} 의 "${d}"`);
    }
  }
  return out;
}

/** depends 에 범위가 있는데 minSuperlite 가 RANGE_MIN_SUPERLITE 보다 낮거나 없으면 사유 */
function rangeTooOld(label, depends, min) {
  if (!(depends ?? []).some((d) => parseDep(d)?.range)) return null;
  if (numbers(min) && !higher(RANGE_MIN_SUPERLITE, min)) return null;
  return `${label}: depends 에 범위가 있으니 minSuperlite 가 ${RANGE_MIN_SUPERLITE} 이상이어야 한다 (지금 ${min ?? '없음'})`;
}

/** 목록 줄(id·version·depends)과 plugin.json 이 어긋난 사유, 맞으면 null */
function mismatch(id, version, depends, manifest) {
  let m;
  try {
    m = JSON.parse(manifest);
  } catch {
    return `${id}: plugin.json 을 읽지 못했다`;
  }
  if (m.id !== id) return `목록의 id(${id}) 와 plugin.json 의 id(${m.id ?? ''}) 가 다르다`;
  if (m.version !== version) return `${id}: 목록의 version(${version}) 과 plugin.json 의 version(${m.version ?? ''}) 이 다르다`;
  // 목록은 plugin.json 의 depends 를 그대로 옮겨 적는다 — 공백만 무시하고 범위까지 대조한다 (market.rs 의 norm)
  const norm = (d) => d.replace(/\s+/g, '');
  const had = (Array.isArray(m.depends) ? m.depends : []).filter((d) => typeof d === 'string').map(norm).sort();
  const want = (depends ?? []).map(norm).sort();
  if (had.join('\0') !== want.join('\0')) return `${id}: 목록의 depends(${want.join(', ')}) 와 plugin.json 의 depends(${had.join(', ')}) 가 다르다`;
  return null;
}

/** source 의 @ref — 없으면 null */
function refOf(source) {
  const at = String(source).lastIndexOf('@');
  return at > 0 && at < source.length - 1 ? source.slice(at + 1) : null;
}

function inline(v) {
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)}: ${inline(v[k])}`).join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

/** 목록 파일의 꼴 — 플러그인 한 줄에 하나 */
function render(list) {
  const fields = Object.entries(list).map(([k, v]) =>
    k === 'plugins' && Array.isArray(v) && v.length
      ? `  "plugins": [\n${v.map((p) => `    ${inline(p)}`).join(',\n')}\n  ]`
      : `  ${JSON.stringify(k)}: ${inline(v)}`,
  );
  return `{\n${fields.join(',\n')}\n}\n`;
}

const ORDER = ['id', 'version', 'path', 'source', 'description', 'minSuperlite', 'depends', 'previous'];

/** 알려진 칸을 정해진 순서로, 나머지는 원래 순서대로 뒤에 */
function ordered(line) {
  const out = {};
  for (const k of ORDER) if (line[k] !== undefined) out[k] = line[k];
  for (const k of Object.keys(line)) if (!(k in out)) out[k] = line[k];
  return out;
}

function tagCommit(root, name) {
  return gitTry(root, 'rev-parse', '-q', '--verify', `refs/tags/${name}^{commit}`);
}

function bump(root, id, opts) {
  const file = path.join(root, LIST);
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  const i = list.plugins.findIndex((p) => p.id === id);
  if (i < 0) fail(`${LIST} 에 ${id} 줄이 없다`);
  const line = list.plugins[i];
  let next;
  let prevRef;
  if (line.source) {
    if (!opts.source || !opts.version) fail(`${id} 는 source 줄이다 — --source <저장소@ref> 와 --version 이 필요하다`);
    prevRef = refOf(line.source);
    if (!prevRef) fail(`${id}: 지금 source 에 @ref 가 없다 (${line.source})`);
    if (!refOf(opts.source)) fail(`--source 에 @ref 가 없다 (${opts.source})`);
    next = { version: opts.version, depends: opts.depends ?? line.depends ?? [] };
  } else {
    if (opts.source || opts.version || opts.depends) fail(`${id} 는 path 줄이다 — 새 판은 ${line.path}/plugin.json 에서 읽는다 (--source·--version·--depends 는 source 줄 전용)`);
    const manifest = fs.readFileSync(path.join(root, line.path, 'plugin.json'), 'utf8');
    const m = JSON.parse(manifest);
    next = { version: m.version, depends: Array.isArray(m.depends) ? m.depends : [] };
    prevRef = `${id}-v${line.version}`;
  }
  if (!higher(next.version, line.version)) fail(`${id}: 새 판(${next.version}) 이 지금 줄의 판(${line.version}) 보다 높지 않다`);
  if (!line.source && !tagCommit(root, prevRef)) fail(`직전 판의 태그 ${prevRef} 가 로컬에 없다 — 그 판의 커밋에서 tag ${id} 를 먼저 실행하라`);

  // depends 는 늘 적는다 — 빼면 최신 줄의 depends 를 쓰므로, 나중에 최신 줄의 depends 가 바뀌면 이 판의 뜻이 달라진다
  const prev = { version: line.version, ref: prevRef };
  if (line.minSuperlite) prev.minSuperlite = line.minSuperlite;
  prev.depends = line.depends ?? [];

  const updated = { ...line, version: next.version, previous: [prev, ...(line.previous ?? [])] };
  if (line.source) updated.source = opts.source;
  if (next.depends.length) updated.depends = next.depends;
  else delete updated.depends;
  if (opts['min-superlite']) updated.minSuperlite = opts['min-superlite'];
  if (!line.source) {
    const why = mismatch(id, updated.version, updated.depends, fs.readFileSync(path.join(root, line.path, 'plugin.json'), 'utf8'));
    if (why) fail(why);
  }
  const bad = (updated.depends ?? []).find((d) => parseDep(d) === null);
  if (bad !== undefined) fail(`${id}: depends 항목 "${bad}" 의 꼴이 아니다 ("id" 또는 "id<범위>")`);
  const old = rangeTooOld(`${id} ${updated.version}`, updated.depends, updated.minSuperlite);
  if (old) fail(`${old} — --min-superlite ${RANGE_MIN_SUPERLITE} 을 준다`);
  // 의존의 새 판이 다른 플러그인의 범위를 깨면 그 의존의 Update 가 막힌다 — 의존하는 쪽을 먼저 올려 같은 커밋에 넣게 한다
  const broken = breaks(list, id, updated.version);
  if (broken.length) fail(`${id} ${updated.version} 은 ${broken.join(', ')} 범위에 맞지 않는다 — 의존하는 쪽 depends·version 을 올려 먼저 bump 하고 같은 커밋에 넣는다`);
  list.plugins[i] = ordered(updated);
  fs.writeFileSync(file, render(list));
  process.stdout.write(`${id}: ${line.version} → ${next.version} (previous 맨 앞에 ${line.version} @ ${prevRef})\n`);
  if (!line.source) process.stdout.write(`다음: ${line.path}/plugin.json 과 ${LIST} 를 커밋한 뒤 node scripts/release.mjs tag ${id}\n`);
}

function tag(root, ids) {
  const shown = gitTry(root, 'show', `HEAD:${LIST}`);
  if (shown === null) fail(`HEAD 에 ${LIST} 가 없다`);
  const list = JSON.parse(shown);
  const head = git(root, 'rev-parse', 'HEAD');
  const targets = ids.length
    ? ids.map((id) => list.plugins.find((p) => p.id === id) ?? fail(`HEAD 의 ${LIST} 에 ${id} 줄이 없다`))
    : list.plugins.filter((p) => !p.source);
  // 모두 맞는지 먼저 보고 나서 붙인다 — 일부만 붙은 채 멈추지 않게
  const todo = [];
  for (const p of targets) {
    if (p.source) fail(`${p.id} 는 source 줄이다 — 태그는 그 저장소의 것을 쓴다`);
    const manifest = gitTry(root, 'show', `HEAD:${p.path}/plugin.json`);
    if (manifest === null) fail(`${p.id}: HEAD 에 ${p.path}/plugin.json 이 없다`);
    const why = mismatch(p.id, p.version, p.depends, manifest);
    if (why) fail(`HEAD 커밋: ${why}`);
    const name = `${p.id}-v${p.version}`;
    const at = tagCommit(root, name);
    if (at && at !== head) fail(`${name} 가 이미 다른 커밋(${at.slice(0, 7)}) 을 가리킨다`);
    todo.push({ name, exists: at === head });
  }
  for (const t of todo) {
    if (t.exists) {
      process.stdout.write(`${t.name}: 이미 HEAD 에 있다\n`);
      continue;
    }
    git(root, 'tag', t.name, head);
    process.stdout.write(`${t.name}: ${head.slice(0, 7)} 에 붙였다 (push 하지 않음)\n`);
  }
}

function check(root) {
  const list = JSON.parse(fs.readFileSync(path.join(root, LIST), 'utf8'));
  const errors = [];
  const notes = [];
  for (const p of list.plugins) {
    const previous = p.previous ?? [];
    for (const v of previous) if (!v.version || !v.ref) errors.push(`${p.id}: previous 에 version 이나 ref 가 빈 판이 있다`);
    for (const d of p.depends ?? []) {
      const dep = parseDep(d);
      if (dep === null) {
        errors.push(`${p.id}: depends 항목 "${d}" 의 꼴이 아니다 ("id" 또는 "id<범위>")`);
        continue;
      }
      const target = dep.range && list.plugins.find((q) => q.id === dep.id);
      if (target && !satisfies(target.version, dep.range)) errors.push(`${p.id}: depends "${d}" 가 목록의 ${dep.id} ${target.version} 을 받지 않는다`);
    }
    for (const v of [p, ...previous]) {
      const old = rangeTooOld(`${p.id} ${v.version}`, v.depends ?? p.depends, v.minSuperlite);
      if (old) errors.push(old);
    }
    if (p.source) {
      if (!refOf(p.source)) errors.push(`${p.id}: source 에 @ref 가 없다 (${p.source})`);
      if (previous.length) notes.push(`${p.id}: source 줄의 previous 는 다른 저장소라 확인하지 않았다`);
      continue;
    }
    const file = path.join(root, p.path, 'plugin.json');
    if (!fs.existsSync(file)) errors.push(`${p.id}: ${p.path}/plugin.json 이 없다`);
    else {
      const why = mismatch(p.id, p.version, p.depends, fs.readFileSync(file, 'utf8'));
      if (why) errors.push(`작업 트리: ${why}`);
    }
    const name = `${p.id}-v${p.version}`;
    const at = tagCommit(root, name);
    if (!at) notes.push(`${name}: 태그가 아직 없다 (다음 판을 올리기 전에 필요)`);
    else {
      const why = mismatch(p.id, p.version, p.depends, gitTry(root, 'show', `${at}:${p.path}/plugin.json`) ?? '');
      if (why) errors.push(`태그 ${name}: ${why}`);
    }
    for (const v of previous) {
      if (!v.version || !v.ref) continue;
      const tagged = tagCommit(root, v.ref);
      const full = /^[0-9a-f]{40}$/.test(v.ref);
      if (!tagged && !full) {
        errors.push(`${p.id} previous ${v.version}: 로컬에 태그 ${v.ref} 가 없다 (ref 는 태그나 40자 커밋)`);
        continue;
      }
      const commit = tagged ?? gitTry(root, 'rev-parse', '-q', '--verify', `${v.ref}^{commit}`);
      if (!commit) {
        errors.push(`${p.id} previous ${v.version}: 커밋 ${v.ref} 가 로컬에 없다`);
        continue;
      }
      const manifest = gitTry(root, 'show', `${commit}:${p.path}/plugin.json`);
      if (manifest === null) {
        errors.push(`${p.id} previous ${v.version}: ${v.ref} 시점에 ${p.path}/plugin.json 이 없다`);
        continue;
      }
      const why = mismatch(p.id, v.version, v.depends ?? p.depends, manifest);
      if (why) errors.push(`${p.id} previous ${v.ref}: ${why}`);
    }
  }
  for (const n of notes) process.stdout.write(`참고  ${n}\n`);
  for (const e of errors) process.stdout.write(`오류  ${e}\n`);
  if (errors.length) process.exit(1);
  process.stdout.write('이상 없음\n');
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean', short: 'h' },
    source: { type: 'string' },
    version: { type: 'string' },
    depends: { type: 'string' },
    'min-superlite': { type: 'string' },
  },
});
const [cmd, ...rest] = positionals;
if (values.help || !cmd) {
  process.stdout.write(HELP);
  process.exit(values.help ? 0 : 1);
}
const root = gitTry(process.cwd(), 'rev-parse', '--show-toplevel');
if (!root || !fs.existsSync(path.join(root, LIST))) fail(`git 저장소 최상위에 ${LIST} 가 없다`);
const opts = { ...values, depends: values.depends === undefined ? undefined : values.depends.split(',').map((s) => s.trim()).filter(Boolean) };

if (cmd === 'bump') {
  if (rest.length !== 1) fail('bump <id>');
  bump(root, rest[0], opts);
} else if (cmd === 'tag') tag(root, rest);
else if (cmd === 'check') check(root);
else fail(`모르는 명령: ${cmd} (--help)`);
