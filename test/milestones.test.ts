// 대시보드가 그릴 모습 (ticket orchestration-dashboard) — 실제 저장소(tickets.js)에 쓰고 snapshot → plan 을 본다. `node --test test/milestones.test.ts`.
// 범위·릴리스 가능 판정 자체는 orchestrationTickets.test.ts 가 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../orchestration/tickets.js';
import { plan } from '../orchestration/milestones.js';

const fresh = async () => store.openStore(path.join(fs.realpathSync(fs.mkdtempSync('/tmp/orch-dash-')), '.superlite', 'tickets.db'));

test('snapshot: ticket 마다 assignees·depends 를 붙이고 본문은 뺀다. milestone 은 ord 순, 범위·진행과 함께', async () => {
  const db = await fresh();
  const a = store.createTicket(db, { title: 'a', lane: 'plugin', todo: 'long body' });
  const b = store.createTicket(db, { title: 'b', depends: [a] });
  store.updateTicket(db, b, { add: { assignee: ['feat/b'] } });
  const m2 = store.createMilestone(db, { title: 'two', order: 2 });
  const m1 = store.createMilestone(db, { title: 'one', order: 1 });
  store.addToMilestone(db, m1, [b]);
  const s = store.snapshot(db);
  const tb = s.tickets.find((t) => t.id === b)!;
  assert.deepEqual([tb.assignees, tb.depends], [['feat/b'], [a]]);
  assert.equal('todo' in s.tickets.find((t) => t.id === a)!, false);
  assert.deepEqual(s.milestones.map((m) => m.id), [m1, m2]);
  assert.deepEqual(s.milestones[0].scope.map((t) => t.id).sort(), [a, b].sort());
  assert.deepEqual(s.links.map((l) => ({ ...l })), [{ milestone: m1, ticket: b, auto: 0 }]);
  db.close();
});

test('plan: 직접 붙은 ticket, 범위, 릴리스 가능은 저장소 값 그대로. 범위 밖 열린 ticket 은 loose', async () => {
  const db = await fresh();
  const a = store.createTicket(db, { title: 'a' });
  const b = store.createTicket(db, { title: 'b', depends: [a] });
  const x = store.createTicket(db, { title: 'x' });
  const gone = store.createTicket(db, { title: 'gone' });
  store.updateTicket(db, gone, { fields: { status: 'dropped' } });
  const m = store.createMilestone(db, { title: 'm', order: 1 });
  store.addToMilestone(db, m, [b]);
  let p = plan(store.snapshot(db));
  assert.deepEqual(p.milestones[0].direct, [b]);
  assert.deepEqual(p.milestones[0].scope.sort(), [a, b].sort());
  assert.equal(p.milestones[0].releasable, false);
  assert.deepEqual(p.loose, [x], 'dropped 는 loose 가 아니다');
  for (const id of [a, b]) store.updateTicket(db, id, { fields: { status: 'done' } });
  p = plan(store.snapshot(db));
  assert.equal(p.milestones[0].releasable, true);
  assert.equal(p.milestones[0].done, 2);
  db.close();
});

test('plan: 다음 milestone 은 open 중 ord 최저, 그보다 뒤의 작업을 먼저 끝내면 앞당김 (진행 중인 것은 아니다)', async () => {
  const db = await fresh();
  const [now, later, both, idle, going] = ['now', 'later', 'both', 'idle', 'going'].map((title) => store.createTicket(db, { title }));
  store.updateTicket(db, later, { add: { depends: [both] } });
  for (const id of [now, later, both]) store.updateTicket(db, id, { fields: { status: 'done' } });
  store.updateTicket(db, going, { fields: { status: 'active' } });
  const old = store.createMilestone(db, { title: 'old', order: 1 });
  const m2 = store.createMilestone(db, { title: 'm2', order: 2 });
  const m3 = store.createMilestone(db, { title: 'm3', order: 3 });
  store.addToMilestone(db, m2, [now, both]);
  store.addToMilestone(db, m3, [later, idle, going]);
  const done = store.createTicket(db, { title: 'done' });
  store.addToMilestone(db, old, [done]);
  store.updateTicket(db, done, { fields: { status: 'done' } });
  store.releaseMilestone(db, old);
  const p = plan(store.snapshot(db));
  assert.deepEqual(p.milestones.map((m) => m.next), [false, true, false]);
  assert.equal(p.tickets[now].early, false);
  assert.equal(p.tickets[later].early, true);
  assert.equal(p.tickets[both].early, false, '다음 milestone 범위에도 든다');
  assert.equal(p.tickets[idle].early, false, '아직 손대지 않았다');
  assert.equal(p.tickets[going].early, false, '진행 중인 것은 그 milestone 의 일이다');
  db.close();
});

test('plan: done 때 다음 milestone 에 자동으로 붙은 ticket 은 계획 밖', async () => {
  const db = await fresh();
  const planned = store.createTicket(db, { title: 'planned' });
  const fix = store.createTicket(db, { title: 'fix' });
  const m = store.createMilestone(db, { title: 'm', order: 1 });
  store.addToMilestone(db, m, [planned]);
  assert.equal(store.updateTicket(db, fix, { fields: { status: 'done' } }).attached, m);
  const p = plan(store.snapshot(db));
  assert.equal(p.tickets[planned].out, false);
  assert.equal(p.tickets[fix].out, true);
  assert.deepEqual(p.milestones[0].direct, [planned, fix]);
  db.close();
});
