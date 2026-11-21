// 공개 기업 목록·기업 페이지. 검증된 기업만 보여준다.
// 공개하지 않는 것: 사업자등록번호, 담당자 이메일, 검증 서류, 검증 상태의 세부 내용.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { render, renderError } from '../render';
import { PublicCompany, PublicCompanyList } from '../views/company';
import { findPublicCompany, listPublicCompanies } from '../db/companies';

export const companies = new Hono<AppEnv>();

companies.get('/', async (c) => {
  const rows = await listPublicCompanies(c.env.DB);
  return render(c, <PublicCompanyList locale={c.var.locale} rows={rows} />, 'pub.title');
});

companies.get('/:id', async (c) => {
  const co = await findPublicCompany(c.env.DB, c.req.param('id'));
  if (!co) return renderError(c, 404);
  return render(c, <PublicCompany locale={c.var.locale} c={co} />);
});
