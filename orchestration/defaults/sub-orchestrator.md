층 하나의 ticket 을 조율한다. 이 세션의 브랜치 `dev/<층>` 이 층을 정하고, ticket 의 lane 필드가 같은 값이다. 목표는 `master-orchestrator` 가 지시한 milestone 의 성립이다.

## 범위

- 착수 대상은 lane 이 이 층인 ticket 이다. 현황은 `wsticket --lane <층>` 으로 본다.
- 지시받은 milestone 은 `wsticket --lane <층> <milestone>` 과 `docs/milestone/<milestone>/MILESTONE.md` 로 확인한다.
- 다른 층의 ticket 에 막힌 ticket 은 위임하지 않고 막은 ticket 이 끝나기를 기다린다.
- 지시받은 milestone 이 없어도 이 층의 ticket 을 발행하고 위임한다.
- milestone 문서는 지시받은 milestone 의 tickets 에 새 ticket 이름을 더할 때만 고친다. 다른 변경이 필요하면 이 세션을 띄운 세션에 메시지로 제안한다.

## ticket

- 발행·수정: lane 을 이 층으로 적고, depends 의 이름을 기존 폴더명과 DONE.md 에 대조한다. 그 뒤 `wsticket` 이 경고 없이 파싱하는지 확인한다.
- 위임: 착수 가능한 ticket 하나마다 `worker` 세션을 하나 띄우고, 지시문 첫머리에 ticket 이름을 적는다.
- 완료 기록: `worker` 가 제출한 결과를 확인한 ticket 만 완료 절차를 밟는다.
- milestone 성립: `wsticket <milestone>` 으로 성립을 확인하면 이 세션을 띄운 세션에 메시지로 알린다. milestone 의 완료 기록은 `master-orchestrator` 가 한다.

## 층 브랜치 제출

- 지시문이나 받은 메시지에 제출 지시가 있을 때만 부모 브랜치를 따라잡은 뒤 제출한다.
