// 워커 카드의 ticket 알약 (화면 C, ticket orchestration-ticket-floating 사용자 확정 2026-11-09) — 카드 오른쪽 위 떠 있는 창에 든다 (ticketFloat.js).
// 접힘: 알약 한 줄 — active ticket(없으면 맨 앞)의 제목, 마지막 진행 기록, 맡은 수. 누르면 목록으로 펼친다: ticket 마다 한 줄, 누른 ticket 의
// 할 일과 최근 진행 기록 3줄(나머지는 All N 으로). 머리줄의 X·바깥 누름(ctx.onOutside)으로 접는다. 한 번에 한 ticket 만 펼친다.
// 데이터는 main 의 ticketFloat.assigned(ctx.state). ticket 동사가 끝나면 renderer 가 {kind:'tickets'} 를 보내 다시 읽는다.
// 맡은 것이 없으면 아무것도 그리지 않는다 — 창이 내용 크기라 보이지 않는다. 떠 있는 창은 누름이 포커스를 옮기지 않아 글 선택이 되지 않는다.
const STYLE = `
.t{--fg:var(--vscode-foreground,#ccc);--desc:var(--vscode-descriptionForeground,#9d9d9d);--line:var(--vscode-panel-border,#2b2b2b);--edge:var(--vscode-editorWidget-border,var(--vscode-input-border,#3c3c3c));--hover:var(--vscode-list-hoverBackground,#2a2d2e);--bg:var(--vscode-editorWidget-background,#252526);--link:var(--vscode-textLink-foreground,#3794ff);
  --s-open:var(--desc);--s-active:var(--vscode-charts-blue,#3794ff);--s-hold:var(--vscode-charts-yellow,#cca700);font-size:12.5px;line-height:17px;color:var(--fg)}
.t *{box-sizing:border-box}
:where(.t button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;text-align:left}
.dot{width:8px;height:8px;border-radius:50%;flex:none;display:inline-block}
.id{font:11px var(--vscode-editor-font-family,ui-monospace,monospace);color:var(--desc)}
.ttl{font-weight:600}
.pill{display:flex;align-items:center;gap:8px;max-width:420px;padding:5px 10px 5px 9px;border:1px solid var(--edge);border-radius:14px;background:var(--bg)}
.pill:hover{border-color:var(--desc)}
.pill .ttl,.pill .lg{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pill .ttl{flex:0 1 auto;max-width:220px}.pill .lg{flex:0 1 auto;max-width:180px;font-size:11.5px;color:var(--desc)}
.pill .cnt{flex:none;font-size:11px;color:var(--desc);border-left:1px solid var(--edge);padding-left:8px;white-space:nowrap}
.box{width:340px;border:1px solid var(--edge);border-radius:6px;background:var(--bg)}
.hd{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 10px;border-bottom:1px solid var(--line);font-size:11.5px;color:var(--desc)}
.hd b{color:var(--fg);font-weight:600}.hd .br{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.hd .x{margin-left:auto;flex:none;width:20px;height:20px;border-radius:4px;display:grid;place-items:center}.hd .x:hover{background:var(--hover)}
.it{border-bottom:1px solid var(--line)}.it:last-child{border-bottom:0}
.row{display:flex;align-items:flex-start;gap:8px;width:100%;padding:8px 10px}.row:hover{background:var(--hover)}
.row .dot{margin-top:5px}
.rm{flex:1;min-width:0}.rm .ttl{display:block}
.rl{display:flex;gap:6px;align-items:center;margin-top:2px;font-size:11px;color:var(--desc)}
.pri{font-size:10.5px;padding:0 5px;border-radius:3px;border:1px solid var(--edge)}
.pri.high{color:var(--s-hold);border-color:var(--s-hold)}.pri.critical{color:var(--vscode-errorForeground,#f48771);border-color:currentColor}
.last{display:block;margin-top:2px;font-size:11.5px;color:var(--desc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{padding:0 12px 10px 26px}
.lb{font-size:11px;font-weight:600;color:var(--desc);margin:8px 0 4px;text-transform:uppercase;letter-spacing:.03em}
.todo{white-space:pre-wrap;overflow-wrap:anywhere}
.none{color:var(--desc)}
.log{display:grid;grid-template-columns:max-content 1fr;gap:2px 8px}
.log .at{font:11px/17px var(--vscode-editor-font-family,ui-monospace,monospace);color:var(--desc)}
.log span{overflow-wrap:anywhere}
.more{margin-top:4px;font-size:11.5px;color:var(--link)}.more:hover{text-decoration:underline}
`;
const RANK = { active: 0, open: 1, hold: 2 };
const SHOWN = 3; // 펼친 ticket 에 보이는 최근 진행 기록 수
const X = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dot = (s) => `<span class="dot" style="background:var(--s-${esc(s)})" title="${esc(s)}"></span>`;
const pri = (t) => (t.priority === 'normal' || t.priority === 'low' ? '' : `<span class="pri ${esc(t.priority)}">${esc(t.priority)}</span>`);
/** 진행 기록 시각 — 오늘이면 시:분, 아니면 월-일 (저장값은 UTC ISO) */
function when(iso) {
  const d = new Date(iso), now = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export async function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  el.appendChild(style);
  const root = document.createElement('div');
  root.className = 't';
  el.appendChild(root);

  let tickets = [];
  let expanded = false;
  let picked; // 펼친 목록에서 내용을 연 ticket id — undefined 는 아직 고르지 않음, null 은 모두 접음
  let full = false; // 그 ticket 의 진행 기록을 모두 보이는가

  const pill = () => {
    const t = tickets.find((x) => x.status === 'active') ?? tickets[0], last = t.log.at(-1);
    return `<button class="pill" data-do="expand" title="${esc(t.title)}">${dot(t.status)}<span class="ttl">${esc(t.title)}</span>`
      + `${last ? `<span class="lg">${when(last.at)} ${esc(last.text)}</span>` : ''}`
      + `${tickets.length > 1 ? `<span class="cnt">${tickets.length} tickets</span>` : ''}</button>`;
  };
  const item = (t) => {
    const on = picked === t.id, last = t.log.at(-1);
    const rows = on && !full ? t.log.slice(-SHOWN) : t.log;
    return `<div class="it"><button class="row" data-pick="${esc(t.id)}">${dot(t.status)}<span class="rm"><span class="ttl">${esc(t.title)}</span>`
      + `<span class="rl"><span class="id">${esc(t.id)}</span><span>${esc(t.status)}</span>${pri(t)}</span>`
      + `${!on && last ? `<span class="last">${when(last.at)} ${esc(last.text)}</span>` : ''}</span></button>`
      + (on ? `<div class="body"><div class="lb">To do</div>${t.todo.trim() ? `<div class="todo">${esc(t.todo.trim())}</div>` : '<div class="none">Not written yet</div>'}`
        + `<div class="lb">Progress</div>${t.log.length ? `<div class="log">${rows.map((l) => `<span class="at">${when(l.at)}</span><span>${esc(l.text)}</span>`).join('')}</div>` : '<div class="none">No entries yet</div>'}`
        + `${!full && t.log.length > SHOWN ? `<button class="more" data-do="full">All ${t.log.length} entries</button>` : ''}</div>` : '')
      + '</div>';
  };
  const draw = () => {
    if (tickets.length === 0) {
      root.innerHTML = '';
      return;
    }
    root.innerHTML = expanded
      ? `<div class="box"><div class="hd"><b>Tickets</b><span class="br">· ${esc(ctx.state?.branch ?? '')}</span><button class="x" data-do="collapse" title="Collapse">${X}</button></div>${tickets.map(item).join('')}</div>`
      : pill();
  };
  const load = async () => {
    try {
      const got = await ctx.main.call('ticketFloat', 'assigned', ctx.state);
      tickets = [...got].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || a.id.localeCompare(b.id));
    } catch (e) {
      console.error(`ticket float: ${e?.message ?? e}`);
      tickets = [];
    }
    // 처음에는 맨 앞(active)을 열어 둔다. 사용자가 접었으면(null) 그대로, 연 ticket 이 목록에서 빠졌으면 접는다
    if (picked === undefined) picked = tickets[0]?.id ?? undefined;
    else if (picked !== null && !tickets.some((t) => t.id === picked)) picked = null;
    draw();
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.do === 'expand') expanded = true;
    else if (b.dataset.do === 'collapse') expanded = false;
    else if (b.dataset.do === 'full') full = true;
    else if (b.dataset.pick) {
      picked = picked === b.dataset.pick ? null : b.dataset.pick;
      full = false;
    }
    draw();
  });
  ctx.onOutside(() => {
    if (!expanded) return;
    expanded = false;
    draw();
  });
  ctx.onMessage((m) => {
    if (m?.kind === 'tickets') void load();
  });
  await load();
}
