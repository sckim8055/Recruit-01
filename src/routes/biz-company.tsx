// 기업 정보 편집과 검증 서류 올리기 (/biz/company/edit, /biz/company/docs).
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { canManageCompany } from '../lib/authz';
import {
  COMPANY_DOC_TYPES, MAX_COMPANY_DOCS, inputFromFields, planCompanyEdit, readCompanyForm, statusAfterDocUpload,
  type CompanyDocType,
} from '../lib/company';
import { checkUpload, isDocType, putVerificationDoc } from '../lib/files';
import { render, renderError } from '../render';
import { CompanyEdit, DocsPage, type DocView } from '../views/company';
import { hasCompany, loadBizCtx, type CompanyCtx } from './biz-ctx';

export const bizCompany = new Hono<AppEnv>();

/** 소속 기업이 있고 그 기업을 관리할 수 있는 담당자만 통과. 아니면 응답을 돌려준다. */
export async function requireCompany(c: Context<AppEnv>): Promise<CompanyCtx | Response> {
  const ctx = await loadBizCtx(c);
  if (ctx.user.role !== 'company') return renderError(c, 403);
  if (!hasCompany(ctx)) return c.redirect('/biz');
  if (!canManageCompany(ctx.actor, ctx.company.id)) return renderError(c, 403);
  return ctx;
}

// ── 기업 정보 편집

bizCompany.get('/company/edit', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  return render(c, <CompanyEdit locale={c.var.locale} company={ctx.company} input={inputFromFields(ctx.company)} errors={[]} />, 'co.edit.title');
});

bizCompany.post('/company/edit', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const co = ctx.company;
  const l = c.var.locale;
  const input = readCompanyForm(await c.req.parseBody(), true);
  const plan = planCompanyEdit(co, input);
  if (!plan.ok) return render(c, <CompanyEdit locale={l} company={co} input={input} errors={plan.errors} />, 'co.edit.title', 400);
  const v = plan.value;
  const db = c.env.DB;
  // 읽은 뒤 상태가 바뀌었으면(예: 그사이 관리자가 승인) 반영하지 않는다 — WHERE verify_status = 읽은 상태.
  const update = plan.locked
    // 검증된 기업: 신원 항목은 SQL 에서도 건드리지 않는다.
    ? db.prepare(
        `UPDATE companies SET hq_name = ?, entry_stage = ?, industry = ?, website = ?, profile_ko = ?
         WHERE id = ? AND verify_status = 'verified'`,
      ).bind(v.hq_name, v.entry_stage, v.industry, v.website, v.profile_ko, co.id)
    : db.prepare(
        `UPDATE companies SET name_ko = ?, name_zh = ?, biz_no = ?, entity_type = ?, hq_name = ?, entry_stage = ?,
           industry = ?, website = ?, profile_ko = ?, verify_status = ?, reject_reason = ?
         WHERE id = ? AND verify_status = ?`,
      ).bind(
        v.name_ko, v.name_zh, v.biz_no, v.entity_type, v.hq_name, v.entry_stage, v.industry, v.website, v.profile_ko,
        plan.nextStatus, plan.clearRejectReason ? null : co.reject_reason, co.id, co.verify_status,
      );
  const stmts = [update];
  // 사업자 형태를 바꾸면 대표 담당자의 본사 소속 여부도 등록 때와 같은 규칙으로 맞춘다 (검증 전에만 가능).
  if (plan.entityChanged) {
    stmts.push(db.prepare(
      `UPDATE company_members SET is_hq = ? WHERE company_id = ? AND member_role = 'owner'
         AND EXISTS (SELECT 1 FROM companies WHERE id = ? AND entity_type = ?)`,
    ).bind(v.entity_type === 'cn_hq' ? 1 : 0, co.id, co.id, v.entity_type));
  }
  const res = await db.batch(stmts);
  if (res[0]?.meta.changes !== 1) {
    return render(c, <CompanyEdit locale={l} company={co} input={input} errors={[]} error="co.err.stale" />, 'co.edit.title', 400);
  }
  return c.redirect('/biz?ok=saved');
});

// ── 검증 서류

async function listDocs(db: D1Database, companyId: string): Promise<DocView[]> {
  const r = await db.prepare(
    "SELECT id, doc_type, review_status, created_at FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? ORDER BY created_at DESC",
  ).bind(companyId).all<DocView>();
  return r.results;
}

const isCompanyDocType = (v: unknown): v is CompanyDocType =>
  isDocType(v) && (COMPANY_DOC_TYPES as readonly string[]).includes(v);

bizCompany.get('/company/docs', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const docs = await listDocs(c.env.DB, ctx.company.id);
  const ok = c.req.query('ok') === 'uploaded' ? 'doc.ok.uploaded' : undefined;
  return render(c, <DocsPage locale={c.var.locale} company={ctx.company} docs={docs} canUpload={docs.length < MAX_COMPANY_DOCS} ok={ok} />, 'doc.title');
});

bizCompany.post('/company/docs', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const co = ctx.company;
  const db = c.env.DB;
  const docs = await listDocs(db, co.id);
  const fail = (key: string) =>
    render(c, <DocsPage locale={c.var.locale} company={co} docs={docs} canUpload={docs.length < MAX_COMPANY_DOCS} error={key} />, 'doc.title', 400);

  if (docs.length >= MAX_COMPANY_DOCS) return fail('doc.err.too_many');
  const f = await c.req.parseBody();
  if (!isCompanyDocType(f.doc_type)) return fail('doc.err.doc_type');
  const up = await checkUpload(f.file);
  if (!up.ok) return fail(`doc.err.${up.why}`);
  await putVerificationDoc(c.env, 'company', co.id, f.doc_type, up);
  // 반려된 기업이 서류를 새로 올리면 다시 검증 대기로.
  if (statusAfterDocUpload(co.verify_status) !== co.verify_status) {
    await db.prepare("UPDATE companies SET verify_status = 'pending', reject_reason = NULL WHERE id = ? AND verify_status = 'rejected'")
      .bind(co.id).run();
  }
  return c.redirect('/biz/company/docs?ok=uploaded');
});
