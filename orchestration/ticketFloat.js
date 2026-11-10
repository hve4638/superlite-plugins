// 워커 카드의 ticket 알약 (ticket orchestration-ticket-floating, 화면 C 사용자 확정 2026-11-09) — 카드의 브랜치가 맡은 ticket 을 그 카드 오른쪽 위
// 떠 있는 창(api.floats, code-superlight dev/major 800d862)에 보인다. 화면은 views/tickets.js, 창을 여는 것은 renderer.js 의 expose 'floats'.
//
// 여는 때: superlite ticket 동사를 친 셸의 카드(ctx.tmux — slcode 카드 안의 셸이면 superlite 가 그 카드로 찾는다)에, 그 셸의 브랜치가 끝나지 않은
// ticket 을 맡았으면. orchestrate new 는 오케스트레이터의 셸에서 돌아 워커 카드를 모르므로, 워커가 자기 셸에서 ticket 을 만질 때 붙인다.
// 붙인 창은 superlite 가 card 상태에 기억해 다시 붙인다. 맡은 것이 없어지면 화면이 아무것도 그리지 않아(크기 0) 보이지 않으므로 닫지 않는다.
// 갱신: ticket 동사가 끝날 때마다 창 전부에 알리고(renderer → views.post), 화면이 자기 state 로 다시 읽는다. ticket edit 의 편집기 저장은 동사를
// 거치지 않아 다음 동사 때 보인다.
// state: { store: DB 절대 경로, branch } — 동사 때 찾은 저장소를 적는다 (TICKET_PATH 는 그 셸에만 있다).

import fs from 'node:fs';
import * as store from './tickets.js';
import { branchOf } from './ticketVerbs.js';

const IFACE = 'orchestration/floats';

/** 그 브랜치가 맡은 끝나지 않은 ticket — 화면이 그릴 모양. 저장소 파일이 없으면 빈 목록 (읽기만 하는 쪽이 DB 를 만들지 않는다) */
export async function assigned({ store: file, branch }) {
  if (typeof file !== 'string' || typeof branch !== 'string' || !fs.existsSync(file)) return [];
  const db = await store.openStore(file);
  try {
    return store.listTickets(db, { assignee: branch }).map((row) => {
      const t = store.getTicket(db, row.id);
      return { id: t.id, title: t.title, status: t.status, priority: t.priority, todo: t.todo, log: t.log.map((l) => ({ at: l.at, text: l.text })) };
    });
  } finally {
    db.close();
  }
}

/** 그 셸의 저장소 경로 — 없으면 null (저장소가 없는 곳의 `superlite ticket` 도 이 길을 지난다) */
function storeOf(ctx) {
  try {
    return store.findStore(ctx.cwd, ctx.env).file;
  } catch {
    return null;
  }
}

/** ticket 동사 하나가 끝난 뒤 — 이 셸의 카드에 알약을 붙이고 열린 알약 전부에 다시 읽으라고 알린다. 실패는 동사를 막지 않고 로그만 */
export async function afterTicketVerb(api, ctx) {
  try {
    const branch = await branchOf(ctx.cwd);
    const file = storeOf(ctx);
    if (ctx.tmux && branch !== null && file !== null) {
      const state = { store: file, branch };
      if ((await assigned(state)).length > 0) await (await api.window.main({ tmux: ctx.tmux }))?.call(IFACE, 'open', ctx.tmux, state);
    }
    for (const w of await api.window.all(IFACE)) await w.call(IFACE, 'changed').catch(() => {});
  } catch (e) {
    console.error(`orchestration: ticket float: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** handleTicketVerbs 에 넘길 api — 동사마다 끝난 뒤 afterTicketVerb 를 부른다. 동사 쪽(ticketVerbs.js)은 화면을 모른다 */
export function withTicketFloat(api) {
  return {
    ...api,
    verbs: {
      ...api.verbs,
      handle: (name, run) => api.verbs.handle(name, async (a, ctx) => {
        const out = await run(a, ctx);
        await afterTicketVerb(api, ctx);
        return out;
      }),
    },
  };
}

/** 화면이 부르는 main 함수 — renderer·화면의 ctx.main.call('ticketFloat', 'assigned', state) */
export function exposeTicketFloat(api) {
  api.expose('ticketFloat', { assigned });
}
