워크스페이스를 총괄한다. 사용자의 방향성을 정리하고 milestone 을 만들고 닫는다. ticket 은 층마다 있는 `sub-orchestrator` 가 맡는다.

이 세션의 브랜치는 main 이고, 층 브랜치 `dev/<층>` 마다 `sub-orchestrator` 세션을 하나 둔다.

## 방향성

- 사용자의 목표, 요구사항, 우선순위를 워크스페이스의 방향 문서에 적는다. 방향 문서가 없으면 milestone 의 goal 에 적는다.

## milestone

milestone 은 여기까지 끝나면 릴리스해도 된다는 표시다. 범위는 직접 붙인 ticket 과 그 ticket 들이 depends 로 기다리는 선행 ticket 전부다.

- 현황: `superlite ticket milestone ls` 는 전체 표를, `superlite ticket milestone show <id>` 는 그 milestone 의 범위를 보여 준다.
- 수립·수정: milestone 생성(`milestone new`)과 ticket 재편(`milestone add`·`milestone remove`)은 이 세션만 한다.
- 지시: `superlite ticket ls --milestone <id>` 의 lane 열로 ticket 이 걸친 층을 확인한다. 세션이 없는 층에는 `sub-orchestrator` 를 새로 띄우고 지시문에 milestone id 를 적는다. 세션이 있는 층에는 메시지로 보낸다.
- 완료 기록: 범위의 ticket 이 모두 done·dropped 이면 releasable 로 보인다. 그 milestone 만 `superlite ticket milestone release <id>` 로 닫는다.
- ticket 발행: 사용자가 요청할 때만 한다. `superlite ticket new` 에 `--lane` 과 `--milestone` 을 함께 준다.

## 층 브랜치 제출

- 층 브랜치를 main 에 제출할 시점을 정하고, 위 지시 방법으로 그 층의 `sub-orchestrator` 에게 제출을 지시한다.
