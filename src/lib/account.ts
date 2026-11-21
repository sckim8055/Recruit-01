// 회원 탈퇴 (T-11): 탈퇴할 수 있는지 판단 → 파일 키 모으기 → DB 에서 지우기(한 트랜잭션) → R2 파일 지우기.
//
// - 탈퇴는 본인만 한다 (로그인한 본인의 요청). 관리자가 남의 계정을 이 길로 지우지 않는다.
// - 관리자 계정은 화면에서 탈퇴할 수 없다 (운영 계정이 실수로 사라지지 않게. README 의 방법으로 역할을 바꾼 뒤 한다).
// - 다른 담당자가 있는 기업의 대표 담당자는 탈퇴할 수 없다 — 먼저 다른 담당자를 내보내거나 운영자에게 대표 변경을 요청해야 한다.
// - 파일은 DB 가 지워진 뒤에 지운다. 파일 지우기가 실패해도 탈퇴는 끝난 것이다 (남은 파일은 암호문이고, T-12 정리 작업이 치운다).
import { now, type Env, type SessionUser } from '../env';
import { deleteResumeFile } from './resume-files';
import { countOwnedCompaniesWithOthers, eraseUser } from '../db/account';
import { listApplicationFileKeys } from '../db/applications';
import { listResumeFileKeys } from '../db/resumes';

export type DeletionBlock = 'admin' | 'owner_with_members';

export function deletionBlocks(i: { role: string; ownedCompaniesWithOthers: number }): DeletionBlock[] {
  const out: DeletionBlock[] = [];
  if (i.role === 'admin') out.push('admin');
  if (i.ownedCompaniesWithOthers > 0) out.push('owner_with_members');
  return out;
}

/** 탈퇴 확인 문구: 본인 이메일을 그대로 입력해야 한다 (실수로 누르는 것을 막는다). */
export function confirmMatches(input: unknown, email: string): boolean {
  return typeof input === 'string' && input.trim().toLowerCase() === email.toLowerCase();
}

export const deletedMarker = (): string => `deleted-${crypto.randomUUID()}@deleted.invalid`;

export type DeleteResult = { ok: true; filesLeft: number } | { ok: false; blocks: DeletionBlock[] } | { ok: false; blocks: []; why: 'already' };

export async function deletionBlocksFor(env: Env, user: SessionUser): Promise<DeletionBlock[]> {
  return deletionBlocks({ role: user.role, ownedCompaniesWithOthers: user.role === 'company' ? await countOwnedCompaniesWithOthers(env.DB, user.id) : 0 });
}

export async function deleteAccount(env: Env, user: SessionUser): Promise<DeleteResult> {
  const blocks = await deletionBlocksFor(env, user);
  if (blocks.length) return { ok: false, blocks };
  // 지우기 전에 파일 키를 모은다 (지운 뒤에는 어느 파일이 이 회원 것인지 알 수 없다).
  const keys = [...await listResumeFileKeys(env.DB, user.id), ...await listApplicationFileKeys(env.DB, user.id)];
  if (!await eraseUser(env.DB, { id: user.id, email: user.email, marker: deletedMarker(), ts: now() })) return { ok: false, blocks: [], why: 'already' };
  let filesLeft = 0;
  for (const k of keys) {
    try {
      await deleteResumeFile(env, k);
    } catch {
      filesLeft++;
    }
  }
  if (filesLeft) console.error(`account: file cleanup failed count=${filesLeft}`);
  return { ok: true, filesLeft };
}
