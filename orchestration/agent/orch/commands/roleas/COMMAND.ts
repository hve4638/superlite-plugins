// 사용자가 이 세션의 역할을 정한다 — 처음 역할을 직접 지정하는 입구. 안내는 다음 턴에 붙고, 압축·resume 뒤에는 세션 시작 훅이 다시 넣는다
import { readFileSync } from 'node:fs';
import { slcode } from 'slcode/api';

slcode.command({
  description: 'Set the orchestration role of this session',
  argumentHint: '<role>',
  // 저장 때 main 이 고치는 파일을 칠 때마다 읽는다 — 이미 열린 세션의 후보도 바로 바뀐다. 경로는 세션 시작 훅이 적는다
  complete: (c) => (c.index > 0 || !c.state.rolesFile ? [] : readFileSync(String(c.state.rolesFile), 'utf8').split('\n').filter((r) => r.startsWith(c.value))),
  run: async (cmd) => {
    const r = await cmd.exec('superlite', ['orchestrate', 'enter', '--role', cmd.args], { env: { SLCODE_SESSION_ID: cmd.session.id } });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    const { roles, rolesFile, guide } = JSON.parse(r.stdout);
    cmd.state.rolesFile = rolesFile;
    if (!guide) throw new Error(`role must be one of: ${roles.join(', ')}`);
    cmd.state.role = cmd.args;
    cmd.context(guide);
    cmd.message(`Role: ${cmd.args}`, { icon: 'flag' });
  },
});
