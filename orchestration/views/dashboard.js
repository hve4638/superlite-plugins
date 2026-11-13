// ticket 대시보드 탭 (ticket orchestration-dashboard, 사용자 2026-11-09 후보 B 선택 — 후보들은 ws docs/ticket/orchestration-dashboard/proto).
// milestone(ord 순)마다 가로 띠 하나. 왼쪽 끝의 선행 ticket 에서 직접 붙은 ticket 을 거쳐 오른쪽 끝 milestone 결승선(세로선)으로 선이 흐른다.
// 띠 안에서 ticket 은 한 번만 나오고, 다른 milestone 범위에도 들면 그 띠에 다시 나온다. 계산은 main 의 tickets.plan (milestones.js) 이 한다.
// ticket 이 많아도 읽히게 (사용자 2026-11-09): 끝난(done·dropped) ticket 은 접는다 — 열린 선행 ticket 을 기다리는 것은 선이 끊기지 않게 남긴다.
// 띠는 MAXH 를 넘으면 안에서 스크롤한다. 접기 조작은 그래프 위 고정 줄의 보기 선택 [Focused | All tickets] 이다 (사용자 2026-11-09 후보 E 를
// 기본으로, GPT 와 상의한 대안 — milestone 상태를 말하는 머리 줄에 두면 상태 표시로 읽혀 조작으로 보이지 않았다. 더 다듬을 예정). 저장소는 CLI 가 바꾸므로 포커스가 돌아올 때와 보이는 동안 몇 초마다 다시 읽는다.
// 위쪽 보기 선택 [Home | Graph | Table] — Home(기본, 사용자 2026-11-14)은 milestone 들을 가로 한 줄로 이어 붙인다. 같은 모습을 표로도 본다 (사용자 2026-11-11, 후보 C 를 옮긴 것). 표는 milestone 머리 줄 아래로 직접 붙은 ticket 과
// 선행 ticket 을 나무 선으로 들여 쓰고, 같은 milestone 안에서 다시 나오는 ticket 은 흐리게 한 줄만 둔다. 끝난 ticket 도 접지 않는다.
// 저장소는 이 탭 세션의 워크스페이스 폴더에서 찾는다 — 화면 ctx 에는 그 경로가 없어 proc.run 이 도는 자리(데몬이 워크스페이스 root 로 둔다)를 묻는다.
const W = 210, H = 46, GX = 56, GY = 10, PAD = 14, LW = 170, MAXH = 440, POLL = 5000;
const CLOSED = new Set(['done', 'dropped']);
const STATUS_COLOR = {
  open: 'var(--vscode-descriptionForeground,#9d9d9d)',
  active: 'var(--vscode-charts-blue,#3794ff)',
  hold: 'var(--vscode-charts-yellow,#cca700)',
  done: 'var(--vscode-charts-green,#89d185)',
  dropped: 'var(--vscode-disabledForeground,#6b6b6b)',
};

const STYLE = `
.d{font-size:13px;color:var(--vscode-foreground,#ccc);height:100%;overflow:auto;box-sizing:border-box;padding-bottom:12px}
.d *{box-sizing:border-box}
.d::-webkit-scrollbar,.d ::-webkit-scrollbar{width:10px;height:10px}
.d::-webkit-scrollbar-track,.d ::-webkit-scrollbar-track,.d::-webkit-scrollbar-corner,.d ::-webkit-scrollbar-corner{background:transparent}
.d::-webkit-scrollbar-thumb,.d ::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(121,121,121,.4))}
.d::-webkit-scrollbar-thumb:hover,.d ::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.7))}
.d::-webkit-scrollbar-thumb:active,.d ::-webkit-scrollbar-thumb:active{background:var(--vscode-scrollbarSlider-activeBackground,rgba(191,191,191,.4))}
.msg{padding:16px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.tag{display:inline-block;font-size:10.5px;line-height:15px;padding:0 5px;border-radius:3px;white-space:nowrap}
.tag.lane{background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff)}
.tag.out{border:1px dashed var(--vscode-charts-orange,#d18616);color:var(--vscode-charts-orange,#d18616)}
.tag.early{border:1px solid var(--vscode-charts-purple,#b180d7);color:var(--vscode-charts-purple,#b180d7)}
.tag.ready{background:var(--vscode-charts-green,#89d185);color:#1e1e1e;font-weight:600}
.tag.next{border:1px solid var(--vscode-focusBorder,#0078d4);color:var(--vscode-focusBorder,#3794ff)}
.tag.rel{color:var(--vscode-descriptionForeground,#9d9d9d);border:1px solid var(--vscode-widget-border,#454545)}
.who{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);font-family:var(--vscode-editor-font-family,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st-dropped .ttl{text-decoration:line-through;opacity:.6}
.st-done .ttl{opacity:.75}
.bar{height:4px;border-radius:2px;background:var(--vscode-widget-border,#3c3c3c);overflow:hidden}
.bar>i{display:block;height:100%;background:var(--vscode-charts-green,#89d185)}
.band{margin:12px 12px 0;border:1px solid var(--vscode-widget-border,#3c3c3c);border-radius:6px;background:var(--vscode-sideBar-background,#252526)}
.band.ready{border-color:var(--vscode-charts-green,#89d185)}
.band.released{opacity:.7}
.bh{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--vscode-widget-border,#3c3c3c);font-size:11.5px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.bh b{color:var(--vscode-foreground,#ccc)}
.band.released .bh{border-bottom:0;cursor:pointer}
.bh .bar{width:120px}
.bh .g{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.strip{display:flex;gap:12px;align-items:center;height:32px;padding:8px ${PAD}px 0;font-size:11.5px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.seg{display:inline-flex;border:1px solid var(--vscode-widget-border,#454545);border-radius:4px;overflow:hidden}
.seg button{font:inherit;font-size:11.5px;height:24px;border:0;padding:0 12px;min-width:84px;cursor:pointer;background:none;color:var(--vscode-descriptionForeground,#9d9d9d)}
.seg button+button{border-left:1px solid var(--vscode-widget-border,#454545)}
.seg button:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.seg button.on{background:var(--vscode-inputOption-activeBackground,rgba(36,137,219,.51));color:var(--vscode-inputOption-activeForeground,#fff);box-shadow:inset 0 0 0 1px var(--vscode-inputOption-activeBorder,#007acc)}
.seg button:focus-visible{outline:1px solid var(--vscode-focusBorder,#0078d4);outline-offset:-1px}
.canvas{position:relative;overflow:auto;max-height:${MAXH}px}
.edges{position:absolute;left:0;top:0;pointer-events:none}
.nd{position:absolute;width:${W}px;height:${H}px;padding:4px 7px;border-radius:4px;background:var(--vscode-editor-background,#1e1e1e);border:1px solid var(--vscode-widget-border,#3c3c3c)}
.nd.st-active{border-color:color-mix(in srgb,var(--vscode-widget-border,#3c3c3c),var(--vscode-foreground,#ccc) 22%)}
.nd.out{border-style:dashed;border-color:var(--vscode-charts-orange,#d18616)}
.nd.early{border-color:var(--vscode-charts-purple,#b180d7)}
.nd .r1{display:flex;gap:6px;align-items:center}
.nd .ttl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nd .r2{display:flex;gap:6px;align-items:center;margin-top:3px;padding-left:14px}
.nd .lanes{flex:none;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:var(--vscode-descriptionForeground,#8b8b8b)}
.nd .br{flex:1;min-width:0;display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--vscode-foreground,#ccc);opacity:.8}
.nd .br svg{flex:none}
.nd .br span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fin{position:absolute;width:0;border-left:2px solid var(--vscode-focusBorder,#0078d4)}
.fin.ready{border-left-color:var(--vscode-charts-green,#89d185)}
.fin.released{border-left-color:var(--vscode-widget-border,#555)}
.fn{position:absolute;width:${LW - 14}px;transform:translateY(-50%);display:flex;flex-direction:column;gap:4px}
.fn .n{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fn .c{display:flex;gap:6px;align-items:center;font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.fn .bar{width:60px}
.home{position:relative;margin:12px 12px 0;overflow-x:auto;cursor:grab;border:1px solid var(--vscode-widget-border,#3c3c3c);border-radius:6px;background:var(--vscode-sideBar-background,#252526)}
.loose{display:flex;flex-wrap:wrap;gap:8px;padding:10px}
.loose .nd{position:static}
.top{padding:10px 12px 0}
.id{font-family:var(--vscode-editor-font-family,monospace);font-size:10.5px;color:var(--vscode-descriptionForeground,#8b8b8b)}
.tb{width:100%;border-collapse:collapse;min-width:760px;margin-top:4px}
.tb td,.tb th{padding:3px 10px;text-align:left;white-space:nowrap;font-weight:normal}
.tb th{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);position:sticky;top:0;background:var(--vscode-editor-background,#1e1e1e);border-bottom:1px solid var(--vscode-widget-border,#3c3c3c)}
.mrow td{padding-top:14px;padding-bottom:5px;border-bottom:1px solid var(--vscode-widget-border,#3c3c3c)}
.mrow.released{cursor:pointer;opacity:.7}
.mrow .in{display:flex;gap:8px;align-items:center}
.mrow .n{font-weight:600}
.mrow .g{color:var(--vscode-descriptionForeground,#9d9d9d);font-size:11.5px;overflow:hidden;text-overflow:ellipsis}
.mrow .bar{width:90px}
.mrow .c{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d)}
.trow:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}
.tree{font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-tree-indentGuidesStroke,#585858);white-space:pre}
.cell{display:flex;gap:6px;align-items:center;max-width:420px}
.cell .ttl{overflow:hidden;text-overflow:ellipsis}
.trow.again{opacity:.45}
.trow.out .ttl{border-bottom:1px dashed var(--vscode-charts-orange,#d18616)}
.sts{font-size:11.5px}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dot = (status) => `<span class="dot" style="background:${STATUS_COLOR[status] ?? '#888'}" title="${esc(status)}"></span>`;
const pct = (m) => (m.scope.length ? Math.round((m.done / m.scope.length) * 100) : 0);

/** ticket 꼬리표 — 계획 밖(done 때 다음 milestone 에 자동으로 붙음), 앞당김(다음 milestone 보다 뒤의 작업). lane 은 표의 칸에 쓴다 */
const lane = (t) => (t.lane ? `<span class="tag lane">${esc(t.lane)}</span>` : '');
const marks = (t) => [
  t.out ? '<span class="tag out" title="Joined the next milestone when done">unplanned</span>' : '',
  t.early ? '<span class="tag early" title="Done before an earlier milestone was released">ahead</span>' : '',
].join('');

const msTags = (m) => m.status === 'released'
  ? '<span class="tag rel">released</span>'
  : `${m.releasable ? '<span class="tag ready">releasable</span>' : ''}${m.next ? '<span class="tag next">next</span>' : ''}`;

/** 보일 ticket — 열린 것과, 보이는 선행 ticket 을 가진 끝난 것(선이 끊기지 않게). full 이면 전부 */
function visible(model, m, full) {
  if (full) return new Set(m.scope);
  const memo = new Map();
  const show = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false); // 순환은 거기서 멈춘다
    const t = model.tickets[id];
    const v = !CLOSED.has(t.status) || t.depends.some((d) => m.scope.includes(d) && show(d));
    memo.set(id, v);
    return v;
  };
  return new Set(m.scope.filter(show));
}

/** 띠 안의 자리 — 층은 milestone 에서 가장 먼 길이다: 직접=1, 선행=그것을 기다리는 ticket 의 층+1. 층 안의 순서는 기다리는 ticket 들의 평균 높이 */
function layout(model, m, shown) {
  const depth = new Map(m.direct.filter((id) => shown.has(id)).map((id) => [id, 1]));
  for (let round = 0, changed = true; changed && round <= m.scope.length; round++) {
    changed = false;
    for (const [id, d] of [...depth]) {
      for (const p of model.tickets[id].depends) {
        if (!shown.has(p) || (depth.get(p) ?? 0) >= d + 1) continue;
        depth.set(p, d + 1);
        changed = true;
      }
    }
  }
  const max = depth.size ? Math.max(...depth.values()) : 0; // 다 접혔으면 milestone 마디만 왼쪽에
  const pos = new Map();
  const layers = [];
  for (let d = 1; d <= max; d++) {
    const ids = [...depth].filter(([, v]) => v === d).map(([id]) => id);
    const waitY = (id) => {
      const ys = [...pos].filter(([k]) => model.tickets[k].depends.includes(id)).map(([, p]) => p.y);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    };
    if (d > 1) ids.sort((a, b) => waitY(a) - waitY(b));
    ids.forEach((id, i) => pos.set(id, { x: PAD + (max - d) * (W + GX), y: PAD + i * (H + GY) }));
    layers.push(ids.length);
  }
  const height = PAD * 2 + Math.max(1, ...layers) * (H + GY) - GY;
  const msPos = { x: PAD + max * (W + GX), y: Math.min(height, MAXH) / 2 }; // 선이 모이는 자리 — 스크롤하는 띠에서도 처음 화면 안에
  return { pos, msPos, width: msPos.x + LW + PAD, height };
}

const curve = (x1, y1, x2, y2) => `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
const line = (d, closed) => `<path d="${d}" fill="none" stroke="${closed ? 'var(--vscode-widget-border,#555)' : 'var(--vscode-charts-blue,#3794ff)'}" stroke-width="1.5"/>`;

const BRANCH = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="5.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2.5 3-7 3.8"/></svg>';

/** 그래프 카드 (사용자 2026-11-14 후보 D): lane 은 제목 줄 오른쪽 작은 글, 아래 줄은 담당 브랜치와 꼬리표. 담당이 없으면 브랜치 자리를 비운다.
 *  진행 중(active)은 테두리를 조금 밝게 */
function node(t, p) {
  const at = p ? ` style="left:${p.x}px;top:${p.y}px"` : '';
  const tip = [`${t.id} ${t.title}`, ...t.assignees].join('\n');
  const who = t.assignees.length ? `${BRANCH}<span>${esc(t.assignees.join(', '))}</span>` : '';
  return `<div class="nd st-${esc(t.status)}${t.out ? ' out' : ''}${t.early ? ' early' : ''}"${at} title="${esc(tip)}">
<div class="r1">${dot(t.status)}<span class="ttl">${esc(t.title)}</span>${t.lane ? `<span class="lanes" title="lane">${esc(t.lane)}</span>` : ''}</div>
<div class="r2"><span class="br">${who}</span>${marks(t)}</div></div>`;
}

function band(model, m, open, full) {
  const released = m.status === 'released';
  const shown = visible(model, m, full);
  const hidden = m.scope.filter((id) => !shown.has(id));
  const outOf = (ids) => ids.filter((id) => model.tickets[id].out).length; // 계획 밖은 done 때 붙어 늘 접히므로 그 수를 따로 보인다
  const head = `<div class="bh"><b>${esc(m.title)}</b>${msTags(m)}<span class="g">${esc(m.goal)}</span><div class="bar"><i style="width:${pct(m)}%"></i></div>${m.done}/${m.scope.length}</div>`;
  if (released && !open) return `<div class="band released" data-ms="${esc(m.id)}">${head}</div>`;
  const seg = segment(model, m, shown, 0, 0, null, `<div class="n">${esc(m.title)}</div>`);
  // 보기 선택 — 접을 것이 있을 때만. 펼쳐 둔 띠는 끝난 것이 다 들어가 있어도 Focused 로 돌아갈 길을 남긴다
  const strip = (full ? m.done : hidden.length) === 0 ? ''
    : `<div class="strip"><span class="seg"><button data-full="0" class="${full ? '' : 'on'}" aria-pressed="${!full}">Focused</button><button data-full="1" class="${full ? 'on' : ''}" aria-pressed="${full}">All tickets</button></span><span>${full ? '' : `${hidden.length} finished hidden${outOf(hidden) ? ` (${outOf(hidden)} unplanned)` : ''}`}</span></div>`;
  return `<div class="band${m.releasable ? ' ready' : ''}${released ? ' released' : ''}" data-ms="${esc(m.id)}">${head}
${strip}<div class="canvas" data-scroll="${esc(m.id)}" style="height:${seg.height}px"><div style="position:relative;width:${seg.width}px;height:${seg.height}px">
<svg class="edges" width="${seg.width}" height="${seg.height}">${seg.paths}</svg>${seg.nodes}${seg.fin}
</div></div></div>`;
}

/** milestone 하나의 그림 — 보이는 ticket 카드와 선, 오른쪽 끝의 결승선(사용자 2026-11-14 후보 D)과 그 옆 label. 선은 결승선 가운데로 모인다.
 *  x0·y0 은 Home 에서 이어 붙일 자리, rowH 는 Home 의 줄 높이(결승선을 그 높이로 긋는다. null 이면 이 그림의 높이) */
function segment(model, m, shown, x0, y0, rowH, label) {
  const { pos, msPos, width, height } = layout(model, m, shown);
  const at = (p) => ({ x: x0 + p.x, y: y0 + p.y });
  const paths = [];
  for (const [id, p0] of pos) {
    const p = at(p0);
    for (const d of model.tickets[id].depends) {
      const q = pos.get(d) && at(pos.get(d));
      if (q) paths.push(line(curve(q.x + W, q.y + H / 2, p.x, p.y + H / 2), CLOSED.has(model.tickets[d].status)));
    }
  }
  const end = at(msPos);
  for (const id of m.direct) {
    const p = pos.get(id) && at(pos.get(id));
    if (p) paths.push(line(curve(p.x + W, p.y + H / 2, end.x, end.y), CLOSED.has(model.tickets[id].status)));
  }
  const nodes = [...pos].map(([id, p]) => node(model.tickets[id], at(p))).join('');
  const top = rowH === null ? y0 + PAD : PAD;
  const tall = (rowH ?? height) - PAD * 2;
  const kind = m.status === 'released' ? ' released' : m.releasable ? ' ready' : '';
  const fin = `<div class="fin${kind}" style="left:${end.x}px;top:${top}px;height:${tall}px"></div><div class="fn" style="left:${end.x + 12}px;top:${end.y}px">${label}</div>`;
  return { paths: paths.join(''), nodes, fin, width, height };
}

/** Home (사용자 2026-11-14) — milestone 을 ord 순으로 왼쪽에서 오른쪽으로 이어 붙인 한 줄, 가로로 스크롤한다. 끝난 ticket 은 접는다(Focused).
 *  띠의 머리 줄이 없으므로 결승선 옆 label 에 상태·진행을 적는다. 처음 열면 다음 milestone 이 왼쪽 끝에 오게 스크롤한다 */
function home(model) {
  const segs = model.milestones.map((m) => ({ m, shown: visible(model, m, false) }));
  for (const g of segs) g.size = layout(model, g.m, g.shown);
  const rowH = Math.max(...segs.map((g) => g.size.height));
  let x = 0;
  let next = 0;
  const parts = segs.map(({ m, shown, size }) => {
    if (m.next) next = x;
    const hidden = m.scope.length - shown.size;
    const label = `<div class="n" title="${esc(m.goal)}">${esc(m.title)}</div><div class="c">${msTags(m)}</div><div class="c"><div class="bar"><i style="width:${pct(m)}%"></i></div>${m.done}/${m.scope.length}</div>${hidden ? `<div class="c">${hidden} finished hidden</div>` : ''}`;
    const g = segment(model, m, shown, x, (rowH - size.height) / 2, rowH, label);
    x += g.width;
    return g;
  });
  return `<div class="home" data-scroll="home" data-left="${next}"><div style="position:relative;width:${x}px;height:${rowH}px">
<svg class="edges" width="${x}" height="${rowH}">${parts.map((g) => g.paths).join('')}</svg>${parts.map((g) => g.nodes + g.fin).join('')}</div></div>`;
}

/** 표의 나무 줄 — prefix 는 위 단계의 │·공백, last 는 형제 중 마지막인가. 같은 milestone 에서 이미 나온 ticket 은 한 줄만 두고 더 내려가지 않는다 */
function rows(model, id, prefix, last, depth, seen, out) {
  const again = seen.has(id);
  seen.add(id);
  out.push({ t: model.tickets[id], guide: depth === 0 ? '' : `${prefix}${last ? '└─ ' : '├─ '}`, again });
  if (again) return;
  const kids = model.tickets[id].depends.filter((d) => model.tickets[d]);
  kids.forEach((d, i) => rows(model, d, depth === 0 ? '' : `${prefix}${last ? '   ' : '│  '}`, i === kids.length - 1, depth + 1, seen, out));
}

function trow({ t, guide, again }) {
  return `<tr class="trow st-${esc(t.status)}${again ? ' again' : ''}${t.out ? ' out' : ''}" title="${esc(t.title)}">
<td><div class="cell"><span class="tree">${guide}</span>${dot(t.status)}<span class="ttl">${esc(t.title)}</span>${again ? '<span class="id">(above)</span>' : ''}</div></td>
<td class="sts" style="color:${STATUS_COLOR[t.status]}">${esc(t.status)}</td>
<td>${lane(t)}</td>
<td class="who">${esc(t.assignees.join(', '))}</td>
<td>${marks(t)}</td>
<td class="id">${esc(t.id)}</td></tr>`;
}

function section(model, m, open) {
  const released = m.status === 'released';
  const head = `<tr class="mrow${released ? ' released' : ''}" data-ms="${esc(m.id)}"><td colspan="6"><div class="in">
<span class="n">${esc(m.title)}</span>${msTags(m)}<div class="bar"><i style="width:${pct(m)}%"></i></div><span class="c">${m.done}/${m.scope.length}</span><span class="g">${esc(m.goal)}</span></div></td></tr>`;
  if (released && !open) return head;
  const out = [];
  const seen = new Set();
  for (const id of m.direct) rows(model, id, '', true, 0, seen, out);
  return head + out.map(trow).join('');
}

function table(model, opened) {
  const loose = model.loose.length
    ? `<tr class="mrow"><td colspan="6"><div class="in"><span class="n">Not in a milestone</span></div></td></tr>${model.loose.map((id) => trow({ t: model.tickets[id], guide: '', again: false })).join('')}`
    : '';
  return `<table class="tb"><thead><tr><th>Ticket</th><th>Status</th><th>Lane</th><th>Assignee</th><th></th><th>Id</th></tr></thead>
<tbody>${model.milestones.map((m) => section(model, m, opened.has(m.id))).join('')}${loose}</tbody></table>`;
}

function page(model, view, opened, full) {
  if (model.milestones.length === 0 && model.loose.length === 0) return '<div class="msg">No milestones or tickets yet. Add them with superlite ticket.</div>';
  const pick = `<div class="top"><span class="seg">${[['home', 'Home'], ['graph', 'Graph'], ['table', 'Table']].map(([v, name]) => `<button data-view="${v}" class="${view === v ? 'on' : ''}" aria-pressed="${view === v}">${name}</button>`).join('')}</span></div>`;
  if (view === 'table') return pick + table(model, opened);
  const loose = model.loose.length
    ? `<div class="band"><div class="bh"><b>Not in a milestone</b></div><div class="loose">${model.loose.map((id) => node(model.tickets[id])).join('')}</div></div>`
    : '';
  if (view === 'home') return pick + (model.milestones.length ? home(model) : '') + loose;
  return pick + model.milestones.map((m) => band(model, m, opened.has(m.id), full.has(m.id))).join('') + loose;
}

export async function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  el.appendChild(style);
  const root = document.createElement('div');
  root.className = 'd';
  el.appendChild(root);

  // 보기(graph·table), 펼친 released milestone, 끝난 ticket 까지 보이는 띠 — 탭을 옮겨 다시 로드되어도 남게 state 에 둔다
  const saved = /** @type {{ view?: string, opened?: string[], full?: string[] } | null} */ (ctx.state);
  let view = ['graph', 'table'].includes(saved?.view) ? saved.view : 'home';
  const opened = new Set(saved?.opened ?? []);
  const full = new Set(saved?.full ?? []);
  let model = null;
  let folder = null;
  /** 이 세션의 워크스페이스 폴더 — 로그인 셸이 앞에 무언가 찍을 수 있어 마지막 줄을 쓴다 */
  const workspace = async () => {
    const r = await ctx.proc.run((await ctx.platform()).os === 'windows' ? 'cd' : 'pwd');
    const last = r.stdout.trim().split(/\r?\n/).pop();
    if (r.code !== 0 || !last) throw new Error(`cannot find this session's folder: ${r.stderr.trim() || `exit ${r.code}`}`);
    return last.trim();
  };
  // 몇 초마다 다시 읽으므로 바뀐 것이 없으면 그대로 두고, 바뀌었으면 전체와 띠 안의 스크롤 자리를 되살린다
  let painted = '';
  const paint = () => {
    const html = page(model, view, opened, full);
    if (html === painted) return;
    const top = root.scrollTop;
    const inner = new Map([...root.querySelectorAll('[data-scroll]')].map((c) => [c.dataset.scroll, [c.scrollLeft, c.scrollTop]]));
    root.innerHTML = html;
    painted = html;
    root.scrollTop = top;
    for (const c of root.querySelectorAll('[data-scroll]')) [c.scrollLeft, c.scrollTop] = inner.get(c.dataset.scroll) ?? [Number(c.dataset.left ?? 0), 0];
  };
  const load = async () => {
    try {
      folder ??= await workspace();
      model = await ctx.main.call('tickets', 'plan', folder);
      paint();
    } catch (e) {
      model = null;
      painted = '';
      root.innerHTML = `<div class="msg">${esc(e?.message ?? e)}</div>`;
    }
  };

  const flip = (set, id) => (set.has(id) ? set.delete(id) : set.add(id));
  // Home 은 가로로 읽는다 (사용자 2026-11-14): 휠의 세로 굴림을 가로 이동으로 바꾸고, 끌어서 좌우로 옮긴다. 끝에 닿으면 휠은 탭 스크롤로 넘긴다
  root.addEventListener('wheel', (e) => {
    const h = e.target.closest('.home');
    if (!h || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    const max = h.scrollWidth - h.clientWidth;
    if ((e.deltaY < 0 && h.scrollLeft <= 0) || (e.deltaY > 0 && h.scrollLeft >= max)) return;
    e.preventDefault();
    h.scrollLeft += e.deltaY;
  }, { passive: false });
  root.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.home');
    if (!h || e.button !== 0) return;
    const x0 = e.clientX, left = h.scrollLeft;
    h.setPointerCapture(e.pointerId);
    h.style.cursor = 'grabbing';
    const move = (m) => { h.scrollLeft = left - (m.clientX - x0); };
    const up = () => {
      h.style.cursor = '';
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      h.removeEventListener('pointercancel', up);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
    e.preventDefault(); // 끄는 동안 글자가 선택되지 않게
  });
  root.addEventListener('click', (e) => {
    if (model === null) return;
    const pick = e.target.closest('[data-view]');
    const b = e.target.closest('.band');
    const seg = e.target.closest('[data-full]');
    const row = e.target.closest('.mrow.released');
    if (pick) view = pick.dataset.view;
    else if (row) flip(opened, row.dataset.ms);
    else if (!b?.dataset.ms) return;
    else if (seg) {
      if (seg.dataset.full === '1') full.add(b.dataset.ms);
      else full.delete(b.dataset.ms);
    } else if (e.target.closest('.bh') && b.classList.contains('released')) flip(opened, b.dataset.ms);
    else return;
    void ctx.setState({ view, opened: [...opened], full: [...full] });
    paint();
  });
  window.addEventListener('focus', () => void load());
  setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL);
  await load();
}
