// 대시보드가 그릴 모습 (ticket orchestration-dashboard, 설계 ws docs/report/ticket-structure-draft.md 5절). 입력은 tickets.js 의 snapshot 이다.
// 범위와 릴리스 가능 판정은 저장소(milestoneScope·listMilestones)가 정한 값을 그대로 쓰고, 여기서는 화면에만 쓰는 판정을 더한다:
//
//   다음 milestone = open 중 ord 가 가장 낮은 것
//   앞당긴 작업(early) = done 인데, 그 ticket 을 범위에 둔 open milestone 이 모두 다음 milestone 보다 뒤인 것. 진행 중인 것은 그 milestone 의 일일 뿐이고,
//     끝내 브랜치가 합쳐졌을 때 앞서 들어간 것이 된다 (사용자 2026-11-14)
//   계획 밖(out) = done 때 다음 milestone 에 자동으로 붙은 것 (milestone_ticket.auto)
//   loose = 어느 milestone 범위에도 없는 열린 ticket (done 때 다음 milestone 에 붙는다)

import { isFinished } from './tickets.js';

/** @param {ReturnType<typeof import('./tickets.js').snapshot>} snap */
export function plan(snap) {
  const tickets = new Map(snap.tickets.map((t) => [t.id, { ...t, out: false, early: false }]));
  const next = snap.milestones.find((m) => m.status === 'open') ?? null; // listMilestones 는 ord 순이다
  const milestones = snap.milestones.map((m) => {
    const links = snap.links.filter((l) => l.milestone === m.id);
    for (const l of links) if (l.auto) tickets.get(l.ticket).out = true;
    return { ...m, direct: links.map((l) => l.ticket), scope: m.scope.map((t) => t.id), next: m === next };
  });

  const inScope = new Set(milestones.flatMap((m) => m.scope));
  for (const t of tickets.values()) {
    if (next === null || t.status !== 'done') continue;
    const holders = milestones.filter((m) => m.status === 'open' && m.scope.includes(t.id));
    t.early = holders.length > 0 && holders.every((m) => m.ord > next.ord);
  }

  return {
    milestones,
    tickets: Object.fromEntries(tickets),
    loose: [...tickets.values()].filter((t) => !inScope.has(t.id) && !isFinished(t.status)).map((t) => t.id),
  };
}
