// superlite 데몬 pluginhost.mjs 의 verbs 인자 해석 사본 (code-superlight 61b4f8c backend/daemon/src/pluginhost.mjs 46-117행).
// orchestrationParam 테스트가 slcode.new 인자를 해석하는 데 쓴다. 호스트 쪽이 바뀌면 함께 맞춘다.
function argSyntax(a) {
  const inner =
    a.kind === 'positional' ? `<${a.name}${a.variadic ? '...' : ''}>`
    : a.kind === 'option' ? `--${a.name} <${a.value ?? a.name}>`
    : a.kind === 'flag' ? `--${a.name}`
    : `-- <${a.name}...>`;
  return a.required ? inner : `[${inner}]`;
}
const usageLine = (e) => ['superlite', e.name.replaceAll('.', ' '), ...(e.args ?? []).map(argSyntax)].join(' ');

function helpOf(e) {
  const lines = [`Usage: ${usageLine(e)}`];
  if (e.help) lines.push(`  ${e.help}`);
  const documented = (e.args ?? []).filter((a) => a.help);
  if (documented.length > 0) {
    lines.push('');
    const w = Math.max(...documented.map((a) => argSyntax(a).length));
    for (const a of documented) lines.push(`  ${argSyntax(a).padEnd(w)}  ${a.help}`);
  }
  return lines.join('\n');
}

export function parseArgs(entry, argv) {
  const args = entry.args ?? [];
  const dash = argv.indexOf('--');
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const tail = dash === -1 ? null : argv.slice(dash + 1);
  const res = {};
  const usage = (msg) => new Error(`${msg}\n${helpOf(entry)}`);
  const positional = [];
  for (let i = 0; i < head.length; i++) {
    const tok = head[i];
    if (!tok.startsWith('--')) {
      positional.push(tok);
      continue;
    }
    const name = tok.slice(2);
    const def = args.find((a) => a.name === name && (a.kind === 'option' || a.kind === 'flag'));
    if (def === undefined) throw usage(`unknown option --${name}`);
    if (def.kind === 'flag') {
      res[name] = true;
      continue;
    }
    const v = head[i + 1];
    if (v === undefined || v.startsWith('--')) throw usage(`--${name} needs a value`);
    res[name] = v;
    i++;
  }
  for (const a of args) if (a.kind === 'flag' && res[a.name] === undefined) res[a.name] = false;
  let q = positional;
  for (const a of args) {
    if (a.kind !== 'positional') continue;
    if (a.variadic) {
      if (q.length > 0) res[a.name] = q;
      q = [];
    } else if (q.length > 0) {
      res[a.name] = q[0];
      q = q.slice(1);
    }
    if (a.required && res[a.name] === undefined) throw usage(`missing <${a.name}>`);
  }
  const rest = args.find((a) => a.kind === 'rest');
  if (rest !== undefined) {
    const r = tail ?? q;
    if (r.length > 0) res[rest.name] = r;
    else if (rest.required) throw usage(`missing -- <${rest.name}...>`);
    if (tail === null) q = [];
  } else if (tail !== null && tail.length > 0) throw usage('unexpected arguments after --');
  if (q.length > 0) throw usage(`unexpected argument: ${q[0]}`);
  for (const a of args) if (a.kind === 'option' && a.required && res[a.name] === undefined) throw usage(`missing --${a.name}`);
  return res;
}
