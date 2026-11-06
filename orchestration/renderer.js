// 창 쪽 코드 — 액티비티바 아이콘과 사이드바를 등록하고, 탭의 저장을 사이드바에 전한다. 값은 세션 머신의 main 에 있다 (expose 'roles')
/** @param {import('@superlite/plugin').RendererApi} api */
export function activate(api) {
  void api.sidebar.register('roles', { icon: 'organization', title: 'Orchestration', view: 'sidebar' });
  void api.views.onMessage((m) => { void api.views.post(m); });
}
