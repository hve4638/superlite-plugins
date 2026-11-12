// Orchestration 역할 탭 — 역할 상자와 "시작할 수 있다" 연결선을 그리고, 고른 상자의 설정을 오른쪽에서 고쳐 Save 로 main 에 넘긴다. 저장값은 활성 세션의 머신에 있다.
// sandbox iframe 이라 앱 라이브러리를 못 쓴다 — 상자는 HTML, 선은 SVG 로 직접 그린다. 선 잇기는 상자 오른쪽 점을 끌어 다른 상자에 놓는다. 같은 데이터를 체크 목록으로도 고친다(키보드 입구).
// 편집 중에는 선이 역할 객체를 가리킨다 — 이름을 고쳐도 선이 따라가고, 보내고 견줄 때만 plain 이 이름으로 바꾼다. 순환은 main 이 저장 때 거절한다.
// 입력 중에는 패널을 다시 그리지 않는다 — refresh 는 글자·속성만 고친다. Edit in editor 로 고친 글과 다른 자리의 저장은 포커스가 돌아올 때 읽어 온다.
const BW = 190, BH = 52; // 상자 크기 — .box 와 같다
const STYLE = `
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#79797966)}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,#646464b3)}
.o{--bg:var(--vscode-editor-background,#1f1f1f);--fg:var(--vscode-foreground,#ccc);--desc:var(--vscode-descriptionForeground,#9d9d9d);--hover:var(--vscode-list-hoverBackground,#2a2d2e);--focus:var(--vscode-focusBorder,#0078d4);--line:var(--vscode-panel-border,#2b2b2b);--edge:var(--vscode-input-border,#3c3c3c);--wire:var(--vscode-tree-indentGuidesStroke,#585858);--err:var(--vscode-errorForeground,#f48771)}
.o,.o *{box-sizing:border-box}
.o{height:100vh;display:grid;grid-template-columns:minmax(0,1fr) 400px;grid-template-rows:minmax(0,1fr);font-size:13px;color:var(--fg);background:var(--bg);outline:none}
.o [hidden]{display:none!important}
.o svg.i{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none;display:block}
:where(.o button){font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.o button:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}
.stage{display:flex;flex-direction:column;min-width:0;min-height:0}
.tb{display:flex;align-items:center;gap:4px;padding:8px 12px;border-bottom:1px solid var(--line)}
.tb button{display:flex;align-items:center;gap:5px;height:26px;padding:0 8px;border-radius:4px;font-size:12.5px}.tb button:hover{background:var(--hover)}.tb button[aria-pressed=true]{background:var(--hover)}
.tip{margin-left:auto;font-size:11.5px;color:var(--desc);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding-left:12px}
.sc{flex:1;min-height:0;overflow:auto}
.cv{position:relative;min-width:100%;min-height:100%;background-image:radial-gradient(var(--edge) 1px,transparent 1px);background-size:20px 20px}
.wires{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.wire{fill:none;stroke:var(--wire);stroke-width:1.5;pointer-events:none}.wire.on{stroke:var(--focus);stroke-width:2}.wire.tmp{stroke:var(--focus);stroke-dasharray:4 4}
.hit{fill:none;stroke:transparent;stroke-width:12;cursor:pointer;pointer-events:stroke}
.head{fill:var(--wire)}.head.on{fill:var(--focus)}
.box{position:absolute;width:${BW}px;height:${BH}px;display:block;text-align:left;padding:8px 22px 8px 12px;border:1px solid var(--edge);border-radius:6px;background:var(--vscode-editorWidget-background,#252526);cursor:grab;touch-action:none;user-select:none}
.box:hover{border-color:var(--desc)}.box.sel{border-color:var(--focus);box-shadow:0 0 0 1px var(--focus)}.box.drop{border-color:var(--focus);background:var(--hover)}.box.bad{border-color:var(--err)}.box.lift{cursor:grabbing;opacity:.85}
.bn{display:block;font-size:12.5px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bn.blank{font-weight:400;color:var(--desc)}
.bs{display:block;font-size:11px;line-height:15px;color:var(--desc);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.port{position:absolute;right:-7px;top:50%;width:13px;height:13px;margin-top:-6.5px;border-radius:50%;border:2px solid var(--wire);background:var(--bg);cursor:crosshair;touch-action:none}.port:hover,.box.sel .port{border-color:var(--focus)}.port:hover{background:var(--focus)}
.x{position:absolute;width:20px;height:20px;margin:-10px 0 0 -10px;display:grid;place-items:center;border-radius:50%;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--focus);color:var(--fg)}.x:hover{color:var(--err)}
.bar{display:flex;align-items:center;gap:4px;padding:6px 8px 6px 12px;border-top:1px solid var(--line)}
.msg{flex:1;min-width:0;font-size:11.5px;line-height:15px;color:var(--desc)}.msg.err{color:var(--err)}
.btn{height:24px;padding:0 10px;font-size:12px;border-radius:4px;flex:none}.btn.sec:hover{background:var(--vscode-button-secondaryHoverBackground,#3c3c3c)}.btn.pri{background:var(--vscode-button-background,#0078d4);color:var(--vscode-button-foreground,#fff)}.btn.pri:hover:not(:disabled){background:var(--vscode-button-hoverBackground,#026ec1)}.btn:disabled{opacity:.5;cursor:default}
.pn{border-left:1px solid var(--line);overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;min-height:0}
.lb{display:block;font-size:11.5px;font-weight:600;color:var(--desc);margin-bottom:4px}
.h{font-size:14px;font-weight:600}.sub{font-size:12px;line-height:17px;color:var(--desc)}
.field{display:block;width:100%;font:inherit;font-size:12.5px;line-height:18px;color:var(--vscode-input-foreground,#ccc);background:var(--vscode-input-background,#313131);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:3px 6px;outline:none;resize:vertical}.field::placeholder{color:var(--vscode-input-placeholderForeground,#989898)}.field:focus{border-color:var(--focus)}.field.bad{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);border-color:var(--vscode-inputValidation-errorBorder,#be1100)}
textarea.field{min-height:220px}
.er{margin-top:4px;font-size:11.5px;line-height:15px;color:var(--err)}
.ck{display:flex;align-items:center;gap:6px;line-height:22px;font-size:12.5px;cursor:pointer}.ck input{margin:0;accent-color:var(--focus)}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px}
.row select{font:inherit;font-size:12.5px;color:var(--vscode-input-foreground,#ccc);background:var(--vscode-input-background,#313131);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:1px 2px;outline:none;margin-left:6px}.row select:focus{border-color:var(--focus)}
.row label{display:flex;align-items:center;font-size:12.5px;cursor:pointer}.row input{margin:0 6px 0 0;accent-color:var(--focus)}
.tools{display:flex;gap:2px;flex-wrap:wrap}.tl{display:flex;align-items:center;gap:4px;height:24px;padding:0 6px;border-radius:4px;font-size:12px;color:var(--desc)}.tl:hover{background:var(--hover);color:var(--fg)}.tl.del:hover{color:var(--err)}.tl[aria-pressed=true]{color:var(--fg);background:var(--hover)}
.pvb{border:1px solid var(--edge);border-radius:4px;padding:6px 8px;min-width:0}
.pvh{color:var(--desc);font-size:11.5px;margin-bottom:6px}
.pp{padding:4px 0 4px 8px;border-left:2px solid var(--edge);margin-bottom:6px;font-size:12px;line-height:17px}.pp.au{border-left-color:var(--focus)}.pp.of{opacity:.55}
.pl{display:flex;flex-wrap:wrap;gap:0 6px;font-size:11px;font-weight:600;color:var(--desc)}.pl em{font-style:normal;font-weight:400}
.pt{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:2px}
@media (max-width:760px){.o{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) minmax(0,1fr)}.pn{border-left:0;border-top:1px solid var(--line)}.tip{display:none}}
`;
const ICON = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
  eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.8"/>',
  edit: '<path d="M3 13h2.5L13 5.5 10.5 3 3 10.5z"/>',
  doc: '<path d="M4 2.5h5.5L12 5v8.5H4zM6 8h4M6 10.5h4"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
};
const ROLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/; // main.js checkConfig 와 같은 규칙
const RULE = 'Use lowercase letters, digits and - (no leading -, 32 at most)';
const HINT = 'Applies at next start or compaction';
const COMMON = '_common'; // main.js 와 같은 이름
const MERGE_TIP = 'How this role merges into its parent. Squash makes one commit and rewrites this branch, so sessions started from it can conflict at sync. A merge commit keeps its commits and is safe for roles that start sessions.';

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const icon = (k) => `<svg class="i" viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`;
/** 선의 끝점과 제어점 — 오른쪽에서 나가 왼쪽으로 들어간다. 왼쪽으로 돌아오는 선은 같은 줄의 상자에 가리지 않게 아래로 돌린다 */
const curve = (ax, ay, bx, by) => {
  const back = bx < ax, d = back ? 60 : Math.max(40, (bx - ax) / 2), dy = back && Math.abs(by - ay) < BH ? BH + 24 : 0;
  return [ax, ay, ax + d, ay + dy, bx - d, by + dy, bx, by];
};
const pathOf = (c) => `M${c[0]} ${c[1]}C${c[2]} ${c[3]} ${c[4]} ${c[5]} ${c[6]} ${c[7]}`;
const outOf = (r) => [r.x + BW, r.y + BH / 2];
const inOf = (r) => [r.x - 5, r.y + BH / 2];

export async function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = STYLE;
  el.appendChild(style);
  const root = document.createElement('div');
  root.className = 'o';
  root.tabIndex = -1;
  el.appendChild(root);

  /** main 의 값(선은 이름) → 편집 값(선은 객체) */
  const hydrate = (c) => {
    const by = new Map(c.roles.map((r) => [r.name, r]));
    return { common: c.common, roles: c.roles, edges: c.edges.map((e) => ({ from: by.get(e.from), to: by.get(e.to) })) };
  };
  /** 편집 값 → 보내는 값. 키 순서를 고정해 견준다 */
  const plain = (c) => ({
    common: c.common,
    roles: c.roles.map(({ name, merge, x, y, guide }) => ({ name, merge, x, y, guide })),
    edges: c.edges.map((e) => ({ from: e.from.name, to: e.to.name })),
  });
  const canon = (c) => JSON.stringify(plain(c));

  let cfg;
  try {
    cfg = hydrate(await ctx.main.call('roles', 'get'));
  } catch (e) {
    root.textContent = `Orchestration is not running on this machine: ${e?.message ?? e}`;
    return;
  }
  let saved = JSON.stringify(plain(cfg));
  let sel = null; // 고른 역할 — null 이면 패널이 공통 지침을 보인다
  let selEdge = null;
  let fresh = null; // 방금 추가해 아직 안 친 역할 — 도착하자마자 빨갛게 하지 않는다
  let note = false, failure = '', saving = false;
  let showPv = false, pvHtml = '', pvSeq = 0;

  root.innerHTML = `<div class="stage"><div class="tb"><button class="add">${icon('plus')}Add role</button><button class="cm" aria-pressed="true">${icon('doc')}Common guide</button><span class="tip">Drag a role's dot onto another role: it can start that role</span></div>
<div class="sc"><div class="cv"><svg class="wires" aria-hidden="true"></svg><div class="boxes" role="list" aria-label="Roles"></div><button class="x" hidden title="Remove this line (Delete)" aria-label="Remove this line">${icon('x')}</button></div></div>
<div class="bar"><div class="msg" role="status"></div><button class="btn sec discard">Discard</button><button class="btn pri save" title="Save (Ctrl+S)">Save</button></div></div><aside class="pn"></aside>`;
  const $ = (s) => root.querySelector(s);
  const canvas = $('.cv'), wires = $('.wires'), boxes = $('.boxes'), panel = $('.pn'), delX = $('.x');
  const bar = $('.bar'), msg = $('.msg'), saveBtn = $('.save'), discardBtn = $('.discard');

  /** 그 역할 이름의 문제 — 없으면 빈 글. 중복은 main 처럼 뒤에 나온 쪽에 붙인다 */
  const errOf = (r) => {
    const n = r.name.trim();
    if (!ROLE_RE.test(n)) return RULE;
    return cfg.roles.find((x) => x.name.trim() === n) !== r ? 'Another role already has this name' : '';
  };

  const drawWires = () => {
    const w = cfg.edges.map((e) => {
      const on = e === selEdge, c = curve(...outOf(e.from), ...inOf(e.to));
      const [bx, by] = inOf(e.to);
      return `<path class="wire${on ? ' on' : ''}" d="${pathOf(c)}"/><path class="head${on ? ' on' : ''}" d="M${bx - 1} ${by - 4.5}L${bx + 6} ${by}L${bx - 1} ${by + 4.5}z"/><path class="hit" data-e="${cfg.edges.indexOf(e)}" d="${pathOf(c)}"/>`;
    });
    wires.innerHTML = `${w.join('')}<path class="wire tmp" hidden/>`;
    delX.hidden = selEdge === null;
    if (selEdge !== null) {
      const c = curve(...outOf(selEdge.from), ...inOf(selEdge.to));
      delX.style.left = `${(c[0] + 3 * c[2] + 3 * c[4] + c[6]) / 8}px`;
      delX.style.top = `${(c[1] + 3 * c[3] + 3 * c[5] + c[7]) / 8}px`;
    }
  };
  const sizeCanvas = () => {
    canvas.style.width = `${Math.max(...cfg.roles.map((r) => r.x), 0) + BW + 160}px`;
    canvas.style.height = `${Math.max(...cfg.roles.map((r) => r.y), 0) + BH + 160}px`;
  };
  const boxSub = (r) => (r.merge === 'no-ff' ? 'Merge commit' : 'Squash');
  const drawBoxes = () => {
    boxes.innerHTML = cfg.roles.map((r, i) => `<div class="box${r === sel ? ' sel' : ''}" role="listitem" tabindex="0" data-i="${i}" style="left:${r.x}px;top:${r.y}px"><span class="bn${r.name ? '' : ' blank'}">${esc(r.name || 'unnamed')}</span><span class="bs">${boxSub(r)}</span><span class="port" title="Drag onto a role this one can start"></span></div>`).join('');
    sizeCanvas();
  };

  const startedBy = (r) => {
    const from = cfg.edges.filter((e) => e.to === r).map((e) => e.from.name || 'unnamed');
    return from.length ? `Started by ${esc(from.join(', '))}` : `No role starts this one. You start it with /superlite:roleas ${esc(r.name)}`;
  };
  const panelHtml = (r) => {
    if (r === null) return `<div><div class="h">Common guide</div><div class="sub">Sent to every role. Select a role to edit it.</div></div><textarea class="field" data-k="common" placeholder="Instructions for every role" aria-label="Common guide"></textarea><div class="tools"><button class="tl" data-act="file" title="Edit in editor">${icon('edit')}Edit in editor</button></div>`;
    const others = cfg.roles.filter((o) => o !== r);
    const starts = others.length === 0 ? '<div class="sub">Add another role to connect this one.</div>' : others.map((o) => `<label class="ck"><input type="checkbox" data-start="${cfg.roles.indexOf(o)}"${cfg.edges.some((e) => e.from === r && e.to === o) ? ' checked' : ''}>${esc(o.name || 'unnamed')}</label>`).join('');
    return `<div><label class="lb" for="rn">Name</label><input id="rn" class="field" data-k="name" value="${esc(r.name)}" placeholder="name" spellcheck="false"><div class="er" hidden></div></div>
<div><div class="lb">Can start</div>${starts}<div class="sub sb" style="margin-top:4px">${startedBy(r)}</div></div>
<div class="row"><label title="${esc(MERGE_TIP)}">Merge<select data-k="merge" aria-label="How this role merges into its parent"><option value="squash"${r.merge === 'no-ff' ? '' : ' selected'}>Squash</option><option value="no-ff"${r.merge === 'no-ff' ? ' selected' : ''}>Merge commit</option></select></label></div>
<div><label class="lb" for="rg">Guide</label><textarea id="rg" class="field" data-k="guide" placeholder="Guide for this role"></textarea></div>
<div class="tools"><button class="tl" data-act="preview" aria-pressed="${showPv}" title="Show what this role receives">${icon('eye')}Preview</button><button class="tl" data-act="file" title="Edit in editor">${icon('edit')}Edit in editor</button><button class="tl del" data-act="del" title="Delete role">${icon('trash')}Delete</button></div>${showPv ? `<div class="pvb" aria-label="Preview of the injected guide">${pvHtml}</div>` : ''}`;
  };
  /** 패널을 다시 그리고 포커스·캐럿을 같은 칸으로 되돌린다 */
  const drawPanel = () => {
    const a = document.activeElement, key = panel.contains(a) ? a.dataset.k : undefined, s = a?.selectionStart, e = a?.selectionEnd;
    panel.innerHTML = panelHtml(sel);
    const ta = panel.querySelector('textarea');
    ta.value = sel === null ? cfg.common : sel.guide; // 글 머리의 줄바꿈을 파서가 먹지 않게 HTML 에 넣지 않는다
    $('.cm').setAttribute('aria-pressed', String(sel === null));
    const n = key && panel.querySelector(`[data-k="${key}"]`);
    if (n) {
      n.focus();
      if (typeof s === 'number' && n.setSelectionRange) n.setSelectionRange(s, e);
    }
  };

  /** 안내 조립은 main 한 곳이다 — 저장 전 값을 보내 받아 그린다. 늦게 온 옛 답은 버린다 */
  const drawPreview = async () => {
    const i = cfg.roles.indexOf(sel);
    if (!showPv || i < 0) return;
    const seq = ++pvSeq;
    const parts = await ctx.main.call('roles', 'preview', plain(cfg), i);
    if (seq !== pvSeq) return;
    pvHtml = `<div class="pvh">Injected in this order at session start, resume and after compaction</div>${parts.map((p, n) => `<div class="pp${p.auto ? ' au' : ''}${p.text ? '' : ' of'}"><div class="pl">${n + 1}. ${p.label}<em>${p.text ? (p.auto ? 'added automatically' : 'you write this') : `not sent: ${p.off}`}</em></div>${p.text ? `<div class="pt">${esc(p.text)}</div>` : ''}</div>`).join('')}`;
    const box = panel.querySelector('.pvb');
    if (box) box.innerHTML = pvHtml;
  };

  /** 다시 그리지 않고 오류·저장 줄만 맞춘다 — 입력 중에 불린다 */
  const refresh = () => {
    let invalid = cfg.roles.length === 0;
    cfg.roles.forEach((r, i) => {
      const e = errOf(r), row = boxes.children[i];
      if (e) invalid = true;
      row?.classList.toggle('bad', !!e && r !== fresh);
      if (r !== sel) return;
      const er = panel.querySelector('.er'), f = panel.querySelector('[data-k=name]');
      if (er) { er.textContent = e; er.hidden = !e || r === fresh; }
      f?.classList.toggle('bad', !!e && r !== fresh);
      f?.setAttribute('aria-invalid', String(!!e));
    });
    const dirty = canon(cfg) !== saved;
    bar.hidden = !dirty && !note && !failure;
    saveBtn.hidden = discardBtn.hidden = !dirty;
    saveBtn.disabled = invalid;
    msg.textContent = failure || (dirty ? (cfg.roles.length === 0 ? 'Add at least one role to save' : invalid ? 'Fix the role names to save' : HINT) : `Saved. ${HINT}.`);
    msg.classList.toggle('err', !!failure || (dirty && invalid));
    void drawPreview();
  };
  const edited = () => { note = false; failure = ''; refresh(); };
  const drawAll = () => { drawBoxes(); drawWires(); drawPanel(); refresh(); };
  const select = (r) => { sel = r; selEdge = null; drawAll(); };

  const setEdge = (from, to, on) => {
    const at = cfg.edges.findIndex((e) => e.from === from && e.to === to);
    if (on && at < 0) cfg.edges.push({ from, to });
    if (!on && at >= 0) {
      if (cfg.edges[at] === selEdge) selEdge = null;
      cfg.edges.splice(at, 1);
    }
  };
  const dropEdge = (e) => {
    setEdge(e.from, e.to, false);
    drawWires();
    drawPanel();
    edited();
  };

  // 상자 끌기·점 끌기 — 3px 안에서 놓으면 고르기
  boxes.addEventListener('pointerdown', (e) => {
    const box = e.target.closest('.box');
    if (!box || e.button !== 0) return;
    const r = cfg.roles[Number(box.dataset.i)], port = e.target.closest('.port');
    const src = port ?? box;
    src.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, ox = r.x, oy = r.y;
    let moved = false, target = null;
    const tmp = wires.querySelector('.tmp');
    const over = (ev) => {
      if (port) {
        const b = canvas.getBoundingClientRect();
        tmp.removeAttribute('hidden'); // SVG 요소에는 .hidden 속성이 없다
        tmp.setAttribute('d', pathOf(curve(...outOf(r), ev.clientX - b.left, ev.clientY - b.top)));
        const hit = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.box') ?? null;
        const t = hit && hit !== box ? hit : null;
        if (t !== target) {
          target?.classList.remove('drop');
          t?.classList.add('drop');
          target = t;
        }
        return;
      }
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
      moved = true;
      box.classList.add('lift');
      r.x = Math.max(8, ox + ev.clientX - sx);
      r.y = Math.max(8, oy + ev.clientY - sy);
      box.style.left = `${r.x}px`;
      box.style.top = `${r.y}px`;
      drawWires();
    };
    const end = (ev) => {
      src.removeEventListener('pointermove', over); src.removeEventListener('pointerup', end); src.removeEventListener('pointercancel', end);
      if (port) {
        tmp.setAttribute('hidden', '');
        target?.classList.remove('drop');
        if (ev.type === 'pointerup' && target) {
          setEdge(r, cfg.roles[Number(target.dataset.i)], true);
          selEdge = null;
          note = false; failure = '';
          drawAll();
        }
      } else if (moved) {
        box.classList.remove('lift');
        sizeCanvas();
        edited();
      } else if (ev.type === 'pointerup') {
        select(r);
      }
    };
    src.addEventListener('pointermove', over); src.addEventListener('pointerup', end); src.addEventListener('pointercancel', end);
  });
  boxes.addEventListener('keydown', (e) => {
    const box = e.target.closest('.box');
    if (box && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(cfg.roles[Number(box.dataset.i)]);
    }
  });
  wires.addEventListener('pointerdown', (e) => {
    const i = e.target.dataset?.e;
    if (i === undefined) return;
    e.stopPropagation();
    selEdge = cfg.edges[Number(i)];
    drawWires();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target === canvas || e.target === wires || e.target === boxes) {
      if (selEdge !== null || sel !== null) select(null);
    }
  });
  delX.addEventListener('click', () => dropEdge(selEdge));

  $('.cm').addEventListener('click', () => select(null));
  $('.add').addEventListener('click', () => {
    const r = { name: '', merge: 'squash', x: 40, y: cfg.roles.length ? Math.max(...cfg.roles.map((o) => o.y)) + BH + 24 : 60, guide: '' };
    note = false; failure = '';
    cfg.roles.push(r);
    fresh = r;
    select(r);
    panel.querySelector('[data-k=name]').focus();
    boxes.lastElementChild.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (k === 'common') cfg.common = e.target.value;
    else if (k !== undefined) {
      sel[k] = e.target.value;
      const row = boxes.children[cfg.roles.indexOf(sel)];
      if (k === 'name') {
        fresh = null;
        row.querySelector('.bn').textContent = sel.name || 'unnamed';
        row.querySelector('.bn').classList.toggle('blank', !sel.name);
      } else if (k !== 'guide') row.querySelector('.bs').textContent = boxSub(sel);
    } else if (e.target.dataset.start !== undefined) {
      setEdge(sel, cfg.roles[Number(e.target.dataset.start)], e.target.checked);
      drawWires();
    }
    edited();
  });

  // 포커스가 돌아오면 다시 읽는다 — 편집기 탭·다른 자리에서 저장했을 수 있다. 고치던 게 있으면 그대로인 지침만 새 글로 바꾼다
  let synced = Promise.resolve();
  const sync = async () => {
    const res = await ctx.main.call('roles', 'get');
    const now = JSON.stringify(plain(hydrate(res))); // 저장을 거친 값은 키가 정렬되어 돌아온다 — plain 이 순서를 고정한다
    if (now === saved) return;
    const base = JSON.parse(saved), clean = canon(cfg) === saved;
    if (clean) {
      const name = sel?.name;
      cfg = hydrate(res);
      sel = cfg.roles.find((r) => r.name === name) ?? null;
      selEdge = null;
    } else {
      if (cfg.common === base.common) cfg.common = res.common;
      for (const t of cfg.roles) {
        const b = base.roles.find((x) => x.name === t.name), r = res.roles.find((x) => x.name === t.name);
        if (b && r && t.guide === b.guide) t.guide = r.guide;
      }
    }
    saved = now;
    drawAll();
  };
  window.addEventListener('focus', () => { synced = sync().catch(() => {}); });

  /** 지금 글을 파일에 적고 편집기 탭으로 연다 — 파일에 적었으니 그 글은 저장된 값이다 */
  const openFile = async (name, text) => {
    const s = JSON.parse(saved), b = s.roles.find((x) => x.name === name);
    if (name !== COMMON && !b) {
      failure = 'Save this role first';
      return refresh();
    }
    try {
      const file = await ctx.main.call('roles', 'file', name, text);
      if (b) b.guide = text;
      else s.common = text;
      saved = JSON.stringify(s);
      failure = '';
      await ctx.verbs.run('open', [file]);
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    refresh();
  };

  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'preview') {
      showPv = !showPv;
      drawPanel();
      refresh();
    } else if (act === 'file') {
      void openFile(sel ? sel.name.trim() : COMMON, sel ? sel.guide : cfg.common);
    } else if (act === 'del') {
      cfg.edges = cfg.edges.filter((x) => x.from !== sel && x.to !== sel);
      cfg.roles.splice(cfg.roles.indexOf(sel), 1);
      if (fresh === sel) fresh = null;
      note = false; failure = '';
      select(null);
    }
  });

  const save = async () => {
    await synced;
    if (saving || saveBtn.disabled || canon(cfg) === saved) return;
    saving = true;
    const sent = canon(cfg);
    try {
      const res = await ctx.main.call('roles', 'set', JSON.parse(sent));
      saved = JSON.stringify(plain(hydrate(res)));
      // 저장을 기다리는 사이에 고쳤으면 그 고침을 살려 두고 dirty 로 남긴다
      if (canon(cfg) === sent) {
        note = true; failure = '';
        if (saved !== sent) {
          res.roles.forEach((r, i) => Object.assign(cfg.roles[i], r));
          cfg.common = res.common;
          drawAll();
        }
      }
      void ctx.post('saved');
    } catch (err) {
      failure = String(err?.message ?? err);
    }
    saving = false;
    refresh();
  };
  saveBtn.addEventListener('click', save);
  discardBtn.addEventListener('click', () => {
    note = false; failure = '';
    root.focus();
    const name = sel?.name;
    cfg = hydrate(JSON.parse(saved));
    sel = cfg.roles.find((r) => r.name === name) ?? null;
    selEdge = null; fresh = null;
    drawAll();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!e.isComposing) void save();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selEdge !== null && !panel.contains(document.activeElement)) {
      e.preventDefault();
      dropEdge(selEdge);
    }
  });

  drawAll();
}
