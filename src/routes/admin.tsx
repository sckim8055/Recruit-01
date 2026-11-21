// 관리자 화면. 관리자 세션은 이메일 인증코드 + TOTP 를 모두 통과해야만 생긴다 (src/lib/admin2fa.ts).
// 관리자에게 없는 기능: 공고 내용 수정, 이력서 전달, 추천 발송 (CLAUDE.md 규칙 1).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireRole } from '../lib/auth';
import { render } from '../render';
import { AdminHome } from '../views/pages';

export const admin = new Hono<AppEnv>();

// /admin 아래 모든 경로는 관리자만.
admin.use('*', requireRole('admin'));

// 첫 화면: 처리할 일의 개수. 개수만 읽고 개인정보는 읽지 않는다.
admin.get('/', async (c) => {
  const db = c.env.DB;
  const [co, ag, jr, rp] = await db.batch<{ n: number }>([
    db.prepare("SELECT COUNT(*) AS n FROM companies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM agencies WHERE verify_status = 'pending'"),
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE review_flag IS NOT NULL AND review_cleared_by IS NULL AND status IN ('draft','published')"),
    db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => r?.results[0]?.n ?? 0;
  const counts = { companies: n(co), agencies: n(ag), jobReviews: n(jr), reports: n(rp) };
  return render(c, <AdminHome locale={c.var.locale} counts={counts} />, 'admin.title');
});
