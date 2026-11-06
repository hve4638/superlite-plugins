// 창 쪽 코드 (plugin.json renderer) — 팔레트 명령만 둔다. 설치·제거는 세션 머신의 main 이 한다 (main.js 의 expose 'agents').
/** @param {import('@superlite/plugin').RendererApi} api */
export function activate(api) {
  api.commands.register({ id: 'install', title: 'Superlite for Agents: Install Agent Integration', run: () => void api.main.call('agents', 'install') });
  api.commands.register({ id: 'remove', title: 'Superlite for Agents: Remove Agent Integration', run: () => void api.main.call('agents', 'remove') });
}
