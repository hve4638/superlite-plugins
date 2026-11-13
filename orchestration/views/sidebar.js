// Orchestration 사이드바 — 역할 목록과 탭 열기만 (역할 탭, ticket 대시보드 탭). 편집은 탭(views/roles.js)에서 한다. 탭에서 저장하면 renderer.js 가 전해 주고, 포커스가 돌아와도 다시 읽는다.
// 모양 (사용자 2026-11-14 후보 B 확정 — 후보는 ws docs/ticket/orchestration-dashboard/proto/sidebar.html): 역할은 왼쪽 세로 선(rail) 위의 점으로 늘어서고 — 아무도 시작하지 않는 역할은 찬 점,
// 연이은 두 줄 사이에 시작 관계가 있을 때만 선을 잇는다 — 탭 열기는 목록 모양 링크로, 대시보드는 맨 위(사용자 2026-11-14), 역할 편집은 바닥에 둔다. 패널 제목은 호스트가 그린다.
const STYLE = `
.o{height:100vh;display:flex;flex-direction:column;font-size:13px;color:var(--vscode-sideBar-foreground,var(--vscode-foreground,#ccc))}
.o *{box-sizing:border-box}
:where(.o button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.o button:focus-visible{outline:1px solid var(--vscode-focusBorder,#0078d4);outline-offset:-1px}
.o svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round;flex:none}
.lst{flex:1;min-height:0;overflow:auto;padding:4px 0}
.lst::-webkit-scrollbar{width:10px}
.lst::-webkit-scrollbar-track{background:transparent}
.lst::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(121,121,121,.4))}
.lst::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.7))}
.r{display:flex;align-items:stretch;width:100%;height:40px;padding:0 12px 0 16px}
.r:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.rail{position:relative;flex:none;width:16px;margin-right:10px}
.rail i{position:absolute;left:50%;top:50%;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;border:1.5px solid var(--vscode-descriptionForeground,#9d9d9d);background:var(--vscode-sideBar-background,#252526)}
.rail i.root{border-color:var(--vscode-charts-blue,#3794ff);background:var(--vscode-charts-blue,#3794ff)}
.rail b{position:absolute;left:50%;width:0;border-left:1px solid var(--vscode-tree-indentGuidesStroke,#585858)}
.rail b.up{top:0;height:50%}.rail b.dn{top:50%;bottom:0}
.tx{min-width:0;display:flex;flex-direction:column;justify-content:center}
.nm{font-size:12.5px;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st{font-size:11px;line-height:15px;color:var(--vscode-descriptionForeground,#9d9d9d);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.msg{padding:8px 20px;font-size:12px;line-height:16px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.foot,.head{flex:none;padding:6px 0;border:0 solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border,#2b2b2b))}
.foot{border-top-width:1px}.head{border-bottom-width:1px}
.lnk{display:flex;align-items:center;gap:8px;width:100%;height:26px;padding:0 20px;font-size:12.5px}
.lnk:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.lnk svg{color:var(--vscode-descriptionForeground,#9d9d9d)}
.lnk .k{margin-left:auto;color:var(--vscode-disabledForeground,#6b6b6b)}
`;
const ICON = {
  edit: '<svg viewBox="0 0 16 16"><path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z"/></svg>',
  board: '<svg viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6.5h12M6.5 6.5V14"/></svg>',
  chevron: '<svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4"/></svg>',
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  el.appendChild(style);
  const root = document.createElement('div');
  root.className = 'o';
  root.innerHTML = `<div class="head"><button class="lnk" data-view="dashboard">${ICON.board}Tickets dashboard<span class="k">${ICON.chevron}</span></button></div>
<div class="lst"></div><div class="foot"><button class="lnk" data-view="roles">${ICON.edit}Edit roles<span class="k">${ICON.chevron}</span></button></div>`;
  el.appendChild(root);
  const lst = root.querySelector('.lst');

  const draw = async () => {
    try {
      const c = await ctx.main.call('roles', 'get');
      const linked = (a, b) => !!a && !!b && c.edges.some((e) => e.from === a.name && e.to === b.name);
      lst.innerHTML = c.roles.map((r, i) => {
        const starts = c.edges.filter((e) => e.from === r.name).map((e) => e.to);
        const isRoot = !c.edges.some((e) => e.to === r.name);
        const rail = `${linked(c.roles[i - 1], r) ? '<b class="up"></b>' : ''}${linked(r, c.roles[i + 1]) ? '<b class="dn"></b>' : ''}<i class="${isRoot ? 'root' : ''}"></i>`;
        return `<button class="r" data-view="roles" title="Open in the role editor"><span class="rail">${rail}</span><span class="tx"><span class="nm">${esc(r.name)}</span><span class="st">${starts.length ? `starts ${esc(starts.join(', '))}` : 'starts no role'}</span></span></button>`;
      }).join('') || '<div class="msg">No roles yet.</div>';
    } catch (e) {
      lst.innerHTML = `<div class="msg">Orchestration is not running on this machine: ${esc(String(e?.message ?? e))}</div>`;
    }
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) void ctx.views.open(b.dataset.view, undefined, { reveal: true });
  });
  window.addEventListener('focus', () => void draw());
  ctx.onMessage(() => void draw());
  await draw();
}
