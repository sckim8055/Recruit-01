// /biz 화면 공통: 로그인 사용자의 Actor 와 소속 기업을 읽는다.
// 기업 id 는 폼·주소에서 받지 않고 항상 여기서(로그인 사용자의 소속에서) 정한다. 권한 판단은 authz.ts 로 한다.
import type { Context } from 'hono';
import type { AppEnv, SessionUser } from '../env';
import { loadActor } from '../lib/actor';
import { canManageCompany, type Actor } from '../lib/authz';
import type { CompanyFields, VerifyStatus } from '../lib/company';

export interface MemberRow { company_id: string; member_role: 'owner' | 'member'; is_hq: number }

export interface CompanyRow extends CompanyFields {
  id: string;
  verify_status: VerifyStatus;
  verified_at: number | null;
  reject_reason: string | null;
  created_at: number;
}

export const COMPANY_COLS =
  'id, name_ko, name_zh, entity_type, biz_no, hq_name, entry_stage, industry, website, profile_ko, verify_status, verified_at, reject_reason, created_at';

export interface BizCtx {
  user: SessionUser;
  actor: Actor;
  member: MemberRow | null;
  company: CompanyRow | null;
}

/** 1차(v1)에서는 담당자 한 명이 기업 하나에만 소속된다. */
export async function loadBizCtx(c: Context<AppEnv>): Promise<BizCtx> {
  const user = c.var.user!;
  const actor = await loadActor(c.env, user);
  if (user.role !== 'company') return { user, actor, member: null, company: null };
  const member = await c.env.DB.prepare(
    'SELECT company_id, member_role, is_hq FROM company_members WHERE user_id = ? ORDER BY created_at LIMIT 1',
  ).bind(user.id).first<MemberRow>();
  if (!member || !canManageCompany(actor, member.company_id)) return { user, actor, member: null, company: null };
  const company = await c.env.DB.prepare(`SELECT ${COMPANY_COLS} FROM companies WHERE id = ?`)
    .bind(member.company_id).first<CompanyRow>();
  return { user, actor, member: company ? member : null, company };
}

export type CompanyCtx = BizCtx & { member: MemberRow; company: CompanyRow };
export const hasCompany = (x: BizCtx): x is CompanyCtx => x.company !== null && x.member !== null;

/** 등록된 기업 서류 종류 (반려된 서류는 승인 조건에 넣지 않는다). */
export async function companyDocTypes(c: Context<AppEnv>, companyId: string): Promise<string[]> {
  const r = await c.env.DB.prepare(
    "SELECT doc_type FROM verification_docs WHERE owner_type = 'company' AND owner_id = ? AND review_status != 'rejected'",
  ).bind(companyId).all<{ doc_type: string }>();
  return r.results.map((x) => x.doc_type);
}
