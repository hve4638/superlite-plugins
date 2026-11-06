// 세션을 열 때와 압축 뒤에 역할 안내를 넣는다 — 역할은 /superlite:roleas 로 정한 값, 없으면 orchestrate new 가 넘긴 세션 인자. 역할이 없어도 역할 이름 파일의 경로는 받아 둔다(roleas 자동 완성이 읽는다)
import { slcode } from 'slcode/api';

slcode.on('SessionStart', async (hook) => {
  const role = hook.state.role ?? hook.session.params.ORCH_ROLE;
  const r = await hook.exec('superlite', ['orchestrate', 'enter', ...(role ? ['--role', String(role)] : [])], { env: { SLCODE_SESSION_ID: hook.session.id } });
  if (r.code !== 0) {
    if (role) hook.message(`orchestration: no role guide (${r.stderr.trim() || `exit ${r.code}`})`, { tone: 'warn' });
    return;
  }
  const { rolesFile, guide } = JSON.parse(r.stdout);
  hook.state.rolesFile = rolesFile;
  if (guide) hook.context(guide);
  else if (role) hook.message(`orchestration: role ${role} no longer exists`, { tone: 'warn' });
});
slcode.run();
