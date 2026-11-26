// 관리자: 회원의 2단계 인증 초기화 (/admin/users/2fa-reset, T-16). /admin 아래이므로 requireRole('admin')(= TOTP 세션)을 이미 통과했다.
// 인증 앱과 복구 코드를 모두 잃은 회원이 운영자에게 연락했을 때만 쓴다. 두 단계: 이메일 + 사유(10자 이상) → 확인 화면 → 실행.
// 실행하면 그 회원의 비밀키·복구 코드·대기·세션이 지워지고 admin_actions 에 기록(관리자·대상·사유·시각)이 남으며, 회원에게 알림 메일이 간다.
// 관리자 계정은 대상이 아니다 (README 의 DB 명령). 판단은 lib/twofa.checkReset · resetMember 만 쓴다.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { checkReset, resetMember, resetReason } from '../lib/twofa';
import { render } from '../render';
import { AdminResetConfirm, AdminResetForm } from '../views/twofa';

export const adminUsers = new Hono<AppEnv>();

const email = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

adminUsers.get('/users/2fa-reset', (c) =>
  render(c, <AdminResetForm locale={c.var.locale} done={c.req.query('ok') === '1'} />, 'tfr.title'));

adminUsers.post('/users/2fa-reset', async (c) => {
  const f = await c.req.parseBody();
  const r = await checkReset(c.env, f.email, f.reason);
  if (!r.ok) return render(c, <AdminResetForm locale={c.var.locale} email={email(f.email)} reason={resetReason(f.reason)} error={r.why} />, 'tfr.title', 400);
  return render(c, <AdminResetConfirm locale={c.var.locale} email={r.target.email} role={r.target.role} reason={resetReason(f.reason)} />, 'tfr.confirm.title');
});

adminUsers.post('/users/2fa-reset/confirm', async (c) => {
  const f = await c.req.parseBody();
  const r = await resetMember(c.env, c.var.user!, f.email, f.reason);
  if (!r.ok) return render(c, <AdminResetForm locale={c.var.locale} email={email(f.email)} reason={resetReason(f.reason)} error={r.why} />, 'tfr.title', 400);
  return c.redirect('/admin/users/2fa-reset?ok=1', 303);
});
