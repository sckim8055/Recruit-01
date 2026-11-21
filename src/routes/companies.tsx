// 공개 기업 목록·기업 페이지. 검증된 기업만 보여준다.
// 공개하지 않는 것: 사업자등록번호, 담당자 이메일, 검증 서류, 검증 상태의 세부 내용.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { render, renderError } from '../render';
import { PublicCompany, PublicCompanyList, type PublicCompanyRow, type PublicCompanyView } from '../views/company';

export const companies = new Hono<AppEnv>();

companies.get('/', async (c) => {
  const r = await c.env.DB.prepare(
    "SELECT id, name_ko, name_zh, industry, entry_stage FROM companies WHERE verify_status = 'verified' ORDER BY name_ko LIMIT 500",
  ).all<PublicCompanyRow>();
  return render(c, <PublicCompanyList locale={c.var.locale} rows={r.results} />, 'pub.title');
});

companies.get('/:id', async (c) => {
  const co = await c.env.DB.prepare(
    `SELECT name_ko, name_zh, hq_name, entry_stage, industry, website, profile_ko
     FROM companies WHERE id = ? AND verify_status = 'verified'`,
  ).bind(c.req.param('id')).first<PublicCompanyView>();
  if (!co) return renderError(c, 404);
  return render(c, <PublicCompany locale={c.var.locale} c={co} />);
});
