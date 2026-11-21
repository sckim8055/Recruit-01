// 로그인 사용자의 소속(기업·헤드헌터 업체)을 읽어 authz.Actor 를 만든다.
// 판단은 하지 않는다 — 권한 판단은 authz.ts 의 함수가 이 Actor 로 한다.
import type { Env, Role, SessionUser } from '../env';
import type { Actor } from './authz';
import { listAgencyMembershipsOfUser, listCompanyMembershipsOfUser } from '../db/companies';

export interface CompanyMemberRow { company_id: string; is_hq: number }
export interface AgencyMemberRow { agency_id: string }

/** 역할별로 읽어야 하는 소속 테이블. 해당 없는 테이블은 읽지 않는다 (D1 읽기 절약). */
export function membershipsFor(role: Role): { company: boolean; agency: boolean } {
  return { company: role === 'company', agency: role === 'headhunter' };
}

/** DB 행을 Actor 로 바꾼다. 순수 함수 — 역할에 해당하지 않는 행은 버린다. */
export function actorFromRows(
  user: Pick<SessionUser, 'id' | 'role'>,
  companyRows: CompanyMemberRow[],
  agencyRows: AgencyMemberRow[],
): Actor {
  const m = membershipsFor(user.role);
  const companies = m.company ? companyRows : [];
  const agencies = m.agency ? agencyRows : [];
  return {
    id: user.id,
    role: user.role,
    companyIds: companies.map((r) => r.company_id),
    hqCompanyIds: companies.filter((r) => Number(r.is_hq) === 1).map((r) => r.company_id),
    agencyIds: agencies.map((r) => r.agency_id),
  };
}

export async function loadActor(env: Env, user: SessionUser): Promise<Actor> {
  const m = membershipsFor(user.role);
  const companyRows = m.company
    ? await listCompanyMembershipsOfUser(env.DB, user.id)
    : [];
  const agencyRows = m.agency
    ? await listAgencyMembershipsOfUser(env.DB, user.id)
    : [];
  return actorFromRows(user, companyRows, agencyRows);
}
