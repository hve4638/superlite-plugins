// slcode 에이전트 플러그인 도구 (사용자 결정 2026-11-03) — slcode repo slcode/slcode-plugin 의 package.json·dist 사본을 다른 superlite 플러그인이
// 쓰게 내준다. 사본이 바뀌면 다시 복사하고 plugin.json version 을 사본 판에 맞춘다. 의존하는 플러그인의 main 은 api.plugins.get('slcode-plugin').run([...]) 으로
// 부른다. superlite 의 node 로 돌아 slcode 설치 여부·판과 무관하고, 사용자 셸 env 라 export 가 PATH 의 claude·codex 를 찾는다.
// bin/slcode-plugin 은 superlite 터미널에서 디버그용으로 치는 명령이다 — node 경로가 머신마다 달라 main 이 쓴다 (plugin bin 은 아직 Linux·macOS 만).
import fs from 'node:fs';

/** @param {import('@superlite/plugin').MainApi} api */
export async function activate(api) {
  const win = (await api.platform()).os === 'windows';
  const q = (s) => (win ? `"${s}"` : `'${s.replaceAll("'", "'\\''")}'`);
  const cli = `${api.folder.path}/dist/cli.js`;
  if (!win) {
    fs.mkdirSync(`${api.folder.path}/bin`, { recursive: true });
    fs.writeFileSync(`${api.folder.path}/bin/slcode-plugin`, `#!/bin/sh\nexec ${q(process.execPath)} ${q(cli)} "$@"\n`, { mode: 0o755 });
  }
  return {
    /** @param {string[]} args @returns {Promise<{code: number, stdout: string, stderr: string}>} */
    run: (args) => api.proc.run([process.execPath, cli, ...args].map(q).join(' ')),
  };
}
