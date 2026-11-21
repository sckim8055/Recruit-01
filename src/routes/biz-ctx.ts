// /biz 화면 공통: 로그인 사용자의 Actor 와 소속 기업을 읽는다.
// 기업 id 는 폼·주소에서 받지 않고 항상 여기서(로그인 사용자의 소속에서) 정한다. 권한 판단은 authz.ts 로 한다.
import type { Context } from 'hono';
import type { AppEnv, SessionUser } from '../env';
import { loadActor } from '../lib/actor';
import { canManageCompany, type Actor } from '../lib/authz';
import { findCompany, findFirstMembershipOfUser, listActiveCompanyDocTypes, type CompanyRow, type MemberRow } from '../db/companies';

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
  const member = await findFirstMembershipOfUser(c.env.DB, user.id);
  if (!member || !canManageCompany(actor, member.company_id)) return { user, actor, member: null, company: null };
  const company = await findCompany(c.env.DB, member.company_id);
  return { user, actor, member: company ? member : null, company };
}

export type CompanyCtx = BizCtx & { member: MemberRow; company: CompanyRow };
export const hasCompany = (x: BizCtx): x is CompanyCtx => x.company !== null && x.member !== null;

/** 등록된 기업 서류 종류 (반려된 서류는 승인 조건에 넣지 않는다). */
export async function companyDocTypes(c: Context<AppEnv>, companyId: string): Promise<string[]> {
  return listActiveCompanyDocTypes(c.env.DB, companyId);
}
