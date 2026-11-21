// 담당자 목록·초대·내보내기 (/biz/members). 초대·내보내기·초대 취소는 대표 담당자(owner)만 (authz.canManageMembers).
// 초대하면 안내 메일(company_invite)을 보낸다. 초대받은 사람이 그 이메일로 기업 담당자 계정에 로그인하면 /biz 에서 수락한다.
// 메일 발송에 실패해도 초대는 유지한다 (대표 담당자에게 직접 알리라고 안내).
import { Hono, type Context } from 'hono';
import { now, type AppEnv } from '../env';
import { canManageMembers } from '../lib/authz';
import { MAX_COMPANY_SEATS, hasSeatLeft, inviteIsHq, inviteMail, parseInvite, removeCheck } from '../lib/company';
import { sendMail } from '../lib/email';
import { render, renderError } from '../render';
import { MembersPage, type MemberView, type PendingInviteView } from '../views/company';
import type { CompanyCtx } from './biz-ctx';
import { requireCompany } from './biz-company';

export const bizMembers = new Hono<AppEnv>();

const OK: Record<string, string> = { invited: 'inv.ok.invited', removed: 'mem.ok.removed', cancelled: 'inv.ok.cancelled' };

async function membersPage(c: Context<AppEnv>, ctx: CompanyCtx, msg: { ok?: string; error?: string }, status: 200 | 400 = 200) {
  const db = c.env.DB;
  const [m, i] = await db.batch([
    db.prepare(
      `SELECT m.user_id, u.email, m.member_role, m.is_hq, m.created_at FROM company_members m JOIN users u ON u.id = m.user_id
       WHERE m.company_id = ? ORDER BY m.member_role = 'owner' DESC, m.created_at`,
    ).bind(ctx.company.id),
    db.prepare('SELECT id, email, is_hq, created_at FROM company_invites WHERE company_id = ? AND accepted_at IS NULL ORDER BY created_at')
      .bind(ctx.company.id),
  ]);
  const members = (m?.results ?? []) as MemberView[];
  const invites = (i?.results ?? []) as PendingInviteView[];
  return render(
    c,
    <MembersPage
      locale={c.var.locale} company={ctx.company} me={ctx.user.id}
      canManage={canManageMembers(ctx.actor, ctx.company.id, ctx.member.member_role)}
      seatLeft={hasSeatLeft(members.length, invites.length)}
      members={members} invites={invites} ok={msg.ok} error={msg.error}
    />,
    'mem.title',
    status,
  );
}

bizMembers.get('/members', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  const ok = OK[c.req.query('ok') ?? ''];
  // 초대는 저장했지만 안내 메일을 못 보낸 경우
  const mail = c.req.query('mail');
  const error = ok !== 'inv.ok.invited' ? undefined
    : mail === 'failed' ? 'inv.err.mail_failed'
    : mail === 'skipped' ? 'inv.err.mail_unverified'
    : undefined;
  return membersPage(c, ctx, { ok, error });
});

bizMembers.post('/members/invite', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  if (!canManageMembers(ctx.actor, ctx.company.id, ctx.member.member_role)) return renderError(c, 403);
  const inv = parseInvite(await c.req.parseBody());
  if (!inv.ok) return membersPage(c, ctx, { error: 'inv.err.email_invalid' }, 400);
  const db = c.env.DB;
  const coId = ctx.company.id;
  const [already, dup] = await db.batch([
    db.prepare('SELECT 1 AS x FROM company_members m JOIN users u ON u.id = m.user_id WHERE m.company_id = ? AND u.email = ?').bind(coId, inv.email),
    db.prepare('SELECT 1 AS x FROM company_invites WHERE company_id = ? AND email = ?').bind(coId, inv.email),
  ]);
  if (already?.results.length) return membersPage(c, ctx, { error: 'inv.err.already_member' }, 400);
  if (dup?.results.length) return membersPage(c, ctx, { error: 'inv.err.duplicate' }, 400);
  let changes = 0;
  try {
    // 한도 검사와 추가를 한 문장으로 (동시에 여러 번 눌러도 한도를 넘지 않게).
    const r = await db.prepare(
      `INSERT INTO company_invites (id, company_id, email, is_hq, invited_by, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM company_members WHERE company_id = ?)
           + (SELECT COUNT(*) FROM company_invites WHERE company_id = ? AND accepted_at IS NULL) < ?`,
    ).bind(
      crypto.randomUUID(), coId, inv.email, inviteIsHq(ctx.company.entity_type, inv.checkedHq), ctx.user.id, now(),
      coId, coId, MAX_COMPANY_SEATS,
    ).run();
    changes = r.meta.changes;
  } catch {
    // (company_id, email) 중복: 같은 순간에 같은 주소를 두 번 초대한 경우
    return membersPage(c, ctx, { error: 'inv.err.duplicate' }, 400);
  }
  if (changes !== 1) return membersPage(c, ctx, { error: 'inv.err.limit' }, 400);
  // 검증 전 기업은 메일을 보내지 않는다: 누구나 기업을 등록할 수 있으므로, 운영자가 확인하지 않은 기업명이 담긴 메일을
  // 임의의 주소로 보내는 통로(스팸·피싱)가 되지 않게 한다. 초대 자체는 저장되고, 받은 사람이 로그인하면 보인다.
  if (ctx.company.verify_status !== 'verified') return c.redirect('/biz/members?ok=invited&mail=skipped');
  // 안내 메일: 기업 이름과 로그인 주소만 들어간다. 실패해도 초대는 그대로 둔다.
  let mailed = false;
  try {
    mailed = await sendMail(c.env, { to: inv.email, template: 'company_invite', ...inviteMail(ctx.company, c.env.APP_ORIGIN) });
  } catch {
    mailed = false;
  }
  return c.redirect(mailed ? '/biz/members?ok=invited' : '/biz/members?ok=invited&mail=failed');
});

bizMembers.post('/members/:userId/remove', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  if (!canManageMembers(ctx.actor, ctx.company.id, ctx.member.member_role)) return renderError(c, 403);
  const target = c.req.param('userId');
  const db = c.env.DB;
  const coId = ctx.company.id;
  const row = await db.prepare('SELECT user_id, member_role FROM company_members WHERE company_id = ? AND user_id = ?')
    .bind(coId, target).first<{ user_id: string; member_role: 'owner' | 'member' }>();
  const chk = removeCheck(ctx.user.id, row);
  if (chk === 'not_member') return renderError(c, 404);
  if (chk !== 'ok') return membersPage(c, ctx, { error: `mem.err.${chk}` }, 400);
  // 같은 사람을 다시 초대할 수 있도록 그 사람의 (수락된) 초대 기록도 지운다.
  await db.batch([
    db.prepare("DELETE FROM company_members WHERE company_id = ? AND user_id = ? AND member_role = 'member'").bind(coId, target),
    db.prepare('DELETE FROM company_invites WHERE company_id = ? AND email = (SELECT email FROM users WHERE id = ?)').bind(coId, target),
  ]);
  return c.redirect('/biz/members?ok=removed');
});

// 수락 전 초대 취소 (잘못 적은 주소가 자리를 계속 차지하지 않게).
bizMembers.post('/invites/:id/cancel', async (c) => {
  const ctx = await requireCompany(c);
  if (ctx instanceof Response) return ctx;
  if (!canManageMembers(ctx.actor, ctx.company.id, ctx.member.member_role)) return renderError(c, 403);
  const r = await c.env.DB.prepare('DELETE FROM company_invites WHERE id = ? AND company_id = ? AND accepted_at IS NULL')
    .bind(c.req.param('id'), ctx.company.id).run();
  if (r.meta.changes !== 1) return renderError(c, 404);
  return c.redirect('/biz/members?ok=cancelled');
});
