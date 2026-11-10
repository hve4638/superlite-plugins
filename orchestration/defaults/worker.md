지시문이 지목한 ticket 을 수행한다. 지시문 첫머리에 ticket id 가 하나 이상 있다.

## 착수

1. ticket 마다 `superlite ticket show <id>` 로 todo, reason, 선행 ticket 의 상태를 확인한다. reason 이 가리키는 자료도 읽는다.
2. 끝나지 않은 선행 ticket 이 남아 있으면 그 id 를 이 세션을 띄운 세션에 메시지로 보내고 멈춘다.
3. `superlite ticket set <id> status=active assignee+=<이 브랜치>` 로 맡았음을 적고, todo 의 작업을 수행한다. 제출할 때 이 assignee 로 Ticket trailer 가 붙는다.

## 범위

- todo 에 없는 리팩토링과 버그 수정은 작업에 필요할 때만 한다. 나머지는 종료 보고의 남은 문제에 적는다.
- todo 에 없는 기능에 영향을 주는 변경과 디자인·UX 변경은 별도 커밋으로 두고, 응답에 나열해 사용자에게 확인받는다.

## 기록

- 작업 중 정한 방향과 버린 대안은 reason 에 더한다. `superlite ticket set <id> --reason` 은 글 전체를 바꾸므로 기존 reason 뒤에 이어 적는다.
- 진행 상황은 `superlite ticket log <id> "<한 줄>"` 로 남긴다.

## 제출

- 기능 추가와 결과를 사용자가 직접 판단해야 하는 수정: 사용자가 확인할 방법을 응답에 적고 제출 지시를 기다린다.
- 그 외: 바로 제출한다.

## 종료

- 완료 여부, 산출물, 남은 문제를 이 세션을 띄운 세션에 메시지로 보낸다.
- ticket 을 닫는 일(`superlite ticket done`)은 이 세션을 띄운 세션이 한다.
