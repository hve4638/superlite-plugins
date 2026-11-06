// 에이전트 연동 플러그인 (ticket superlite-agent-skills, 사용자 확정 2026-10-10) — superlite 와 에이전트 CLI(Claude Code·Codex)를
// 잇는 바탕. 에이전트 쪽에 넣을 것(훅·나중의 스킬)은 slcode 에이전트 플러그인 원본 agent/ 에 두고, 의존하는 superlite 플러그인
// slcode-plugin 으로 설치·export 한다 (ticket sfa-slcode-agent-plugin). 다른 플러그인은 이 에이전트 플러그인에 애드온으로 붙는다 — 여기서는 그들을 모른다.
//
//   agent/slcode-plugin.json + agent/main/hooks/hooks.json  → slcode 플러그인 superlite → claude·codex 에 superlite@slcode
//
// 훅: claude 는 상태 훅 8종 + SessionStart 초기 안내, codex 는 안내만 부른다 (상태 훅은 codex 에서 바로 exit 0 — 형식이 하네스별로
// 훅을 나누지 않아 Codex 신뢰 목록에는 8개가 뜬다, 사용자 결정 2026-10-31 command 훅). 훅 명령은 SUPERLITE_SOCK 이 있을 때만
// superlite 를 부른다 — superlite 밖 세션에는 아무 일도 없다. slcode-plugin 의 상태 폴더는 slcode 와 같아(--dir·$SLCODE_DIR·
// ~/.local/state/slcode) slcode 세션에도 실린다.
//
// 설치 시점: main 이 켜질 때(데몬 시작) 확인 창 없이 (사용자 확정 2026-10-10). 새 방식 플러그인(plugin.json apiVersion 2)이라 main 은
// 세션 머신의 node 에서 머신마다 한 번 돈다. add 는 멱등이라 늘 부르고(같은 원본이면 아무것도 안 함, 런처도 이 node 로 맞춘다),
// export(하네스 CLI 를 부른다)는 storage 의 installed(폴더|판)가 다를 때만. claude·codex 를 하나도 못 찾으면 기록을 남기지 않아
// 데몬 시작마다 다시 보고, 그 경고는 버전마다 한 번만 띄운다 (ticket plugin-proc-user-shell-env, 사용자 결정 2026-10-25).
// 옛 설치(0.3.x 까지의 마켓플레이스 superlite·플러그인 superlite@superlite)는 export 에 성공한 하네스에서 지운다 — 두 판이 함께
// 실리지 않게. 원본이 바뀌면 add 의 리빌드가 export 판도 바꾼다. 팔레트의 Install·Remove(renderer.js)는 expose 'agents' 를 부른다.
//
// 제거: Plugins 뷰에서 이 플러그인을 지우면 그 직전에 uninstall 이 불려 slcode-plugin remove(export 해제 포함)로 그 머신의 에이전트에서도
// 뺀다 (사용자 결정 2026-10-17, 와이어 v47). 설치 기록도 지워서, 다시 설치하면 또 자동으로 깔린다. 팔레트의 Remove 는 기록을 남긴다 —
// 다음 데몬 시작에 되살리지 않는다.

const NAME = 'superlite';
const LEGACY_MARKETPLACE = 'superlite';
const LEGACY_PLUGIN = 'superlite@superlite';
/** 데몬 시작 때 알림이 창을 기다리는 시간 (main 의 folder.fetch 와 같은 60초) */
const WINDOW_WAIT = 60_000;

/** @type {import('@superlite/plugin').MainApi | null} */
let host = null;

/** @param {import('@superlite/plugin').MainApi} api */
export function activate(api) {
  host = api;
  api.expose('agents', { install: () => install(api, false), remove: () => remove(api) });
  // 기다린다 — 이 플러그인에 의존하는 애드온은 activate 가 끝나면 베이스가 있는 것으로 본다. 알림이 창을 기다리는 드문 경우 WINDOW_WAIT 까지 걸린다
  return install(api, true);
}

export async function uninstall() {
  if (host === null) return;
  await remove(host);
  await host.storage.set('installed', null);
  await host.storage.set('missingWarned', null);
}

/** quiet(main 이 켜질 때)는 이미 한 자리면 건너뛰고, 결과는 실패만 알린다 */
async function install(api, quiet) {
  const sp = api.plugins.get('slcode-plugin');
  let dir;
  try {
    dir = await api.folder.deploy('agent');
  } catch (e) {
    if (!quiet) api.notify('error', `Superlite for Agents: ${e.message ?? e}`);
    return;
  }
  const run = (cmd) => api.proc.run(cmd);
  const manifest = JSON.parse((await api.folder.read('plugin.json')) ?? '{}');
  const mark = `${dir}|${manifest.version}`;
  // 같은 자리면 add 도 건너뛴다(팔레트 Remove 를 되살리지 않게) — list 만 불러 훅 런처를 이 node 로 맞춘다 (superlite 의 node 가 바뀐 경우)
  if (quiet && (await api.storage.get('installed')) === mark) return void (await sp.run(['list', '--json']));

  const tell = quiet ? (sev, msg) => notifyWhenWindow(api, sev, msg) : async (sev, msg) => api.notify(sev, msg);
  const added = await failure(sp.run(['add', dir]));
  if (added) return void (await tell('error', `Superlite for Agents: install failed — ${added}`));
  const done = [];
  const failed = [];
  for (const [bin, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    if (!(await present(run, bin))) continue;
    const r = await failure(sp.run(['export', NAME, '--to', bin, '--json']));
    if (r) failed.push(`${bin}: ${r}`);
    else {
      done.push(label);
      await removeLegacy(run, bin);
    }
  }
  if (failed.length > 0) await tell('error', `Superlite for Agents: install failed — ${failed.join('; ')}`);
  else if (done.length > 0) await api.storage.set('installed', mark);
  else if (quiet && (await api.storage.get('missingWarned')) !== manifest.version) {
    const sent = await tell('warning', 'Superlite for Agents: neither claude nor codex was found on this machine. After installing one, run "Superlite for Agents: Install Agent Integration" or restart the superlite daemon.');
    if (sent) await api.storage.set('missingWarned', manifest.version);
  }
  if (!quiet && failed.length === 0) {
    api.notify('info', done.length > 0 ? `Superlite for Agents: installed for ${done.join(', ')}` : 'Superlite for Agents: neither claude nor codex was found on this machine');
  }
  if ((await api.platform()).os !== 'windows' && done.includes('Claude Code')) await warnLegacy(api, run);
}

/** 0.3.x 까지 하네스 CLI 로 직접 깐 것 — 없으면 하네스가 거부하는데, 그 실패는 무시한다 */
async function removeLegacy(run, bin) {
  await run(bin === 'claude' ? `claude plugin uninstall ${LEGACY_PLUGIN}` : `codex plugin remove ${LEGACY_PLUGIN}`);
  await run(`${bin} plugin marketplace remove ${LEGACY_MARKETPLACE}`);
}

async function remove(api) {
  const run = (cmd) => api.proc.run(cmd);
  const r = await failure(api.plugins.get('slcode-plugin').run(['remove', NAME, '--cascade']));
  for (const bin of ['claude', 'codex']) if (await present(run, bin)) await removeLegacy(run, bin);
  if (r) api.notify('error', `Superlite for Agents: remove failed — ${r}`);
  else api.notify('info', 'Superlite for Agents: removed from Claude Code and Codex on this machine');
}

/** agent-hooks-status 시절 settings.json 에 병합한 훅이 남아 있으면 — 상태 사건이 두 번 간다 */
async function warnLegacy(api, run) {
  const r = await run(`grep -qs 'superlite agent-event' "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"`);
  if (r.code === 0) api.notify('warning', 'Superlite for Agents: old superlite hooks remain in ~/.claude/settings.json. Run "Agent: Remove Legacy Claude Code Hooks" to remove them.');
}

/** 데몬은 창이 붙을 때 함께 떠서 main 이 켜지는 순간에는 창이 아직 없다 — 그때의 notify 는 버려진다 (no window is connected).
 *  창이 붙을 때까지 WINDOW_WAIT 동안 기다렸다 알린다. 못 알렸으면 false */
async function notifyWhenWindow(api, severity, message) {
  for (const until = Date.now() + WINDOW_WAIT; ; ) {
    if (await api.window.main()) {
      api.notify(severity, message);
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function present(run, bin) {
  return (await run(`${bin} --version`)).code === 0;
}

/** proc.run 결과가 성공이면 null, 실패면 사유 한 줄 */
async function failure(pending) {
  const r = await pending;
  if (r.code === 0) return null;
  const lines = `${r.stderr}\n${r.stdout}`.split('\n').filter((l) => l.trim() && !l.startsWith('WARNING'));
  return lines.slice(-1)[0]?.trim() ?? `exit ${r.code}`;
}
