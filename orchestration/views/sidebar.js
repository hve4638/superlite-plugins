// Orchestration 사이드바 — 역할 목록과 탭 열기만. 편집은 탭(views/roles.js)에서 한다. 탭에서 저장하면 renderer.js 가 전해 주고, 포커스가 돌아와도 다시 읽는다.
const STYLE = `
.o{font-size:13px;color:var(--vscode-sideBar-foreground,var(--vscode-foreground,#ccc));padding:4px 0}
.o *{box-sizing:border-box}
:where(.o button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.o button:focus-visible{outline:1px solid var(--vscode-focusBorder,#0078d4);outline-offset:-1px}
.row{display:block;width:100%;padding:4px 12px}.row:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.nm{display:block;font-weight:600;font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{display:block;font-size:11.5px;line-height:15px;color:var(--vscode-descriptionForeground,#9d9d9d);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.o .open{display:block;margin:8px 12px;width:calc(100% - 24px);height:26px;border-radius:4px;text-align:center;font-size:12px;background:var(--vscode-button-background,#0078d4);color:var(--vscode-button-foreground,#fff)}
.o .open:hover{background:var(--vscode-button-hoverBackground,#026ec1)}
`;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export async function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  el.appendChild(style);
  const root = document.createElement('div');
  root.className = 'o';
  el.appendChild(root);

  const draw = async () => {
    try {
      const c = await ctx.main.call('roles', 'get');
      const rows = c.roles.map((r) => {
        const starts = c.edges.filter((e) => e.from === r.name).map((e) => e.to);
        return `<button class="row" title="Open in tab"><span class="nm">${esc(r.name)}</span><span class="st">${starts.length ? `Starts ${esc(starts.join(', '))}` : 'Starts no role'}</span></button>`;
      });
      root.innerHTML = `${rows.join('')}<button class="open">Edit roles</button>`;
    } catch (e) {
      root.textContent = `Orchestration is not running on this machine: ${e?.message ?? e}`;
    }
  };
  root.addEventListener('click', (e) => { if (e.target.closest('button')) void ctx.views.open('roles', undefined, { reveal: true }); });
  window.addEventListener('focus', () => void draw());
  ctx.onMessage(() => void draw());
  await draw();
}
