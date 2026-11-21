// 기업 담당자·헤드헌터 화면. 첫 화면·기업 등록·초대 수락·서류 내려받기는 여기,
// 기업 정보 편집·서류 올리기는 biz-company.tsx, 담당자 관리는 biz-members.tsx, 공고는 biz-jobs.tsx.
// 기업 id 는 폼·주소에서 받지 않는다 — 항상 로그인 사용자의 소속(biz-ctx.ts)에서 정한다.
import { Hono } from 'hono';
import { now, type AppEnv } from '../env';
import { requireRole } from '../lib/auth';
import { inputFromFields, ownerIsHq, readCompanyForm, validateCompany } from '../lib/company';
import { serveVerificationDoc } from '../lib/files';
import { verifyBlocks } from '../lib/rules';
import { render, renderError } from '../render';
import { BizHome, BizStart, Notice } from '../views/company';
import { Placeholder } from '../views/pages';
import { acceptInvite, listPendingInvitesForEmail, registerCompany } from '../db/companies';
import { companyDocTypes, hasCompany, loadBizCtx } from './biz-ctx';
import { bizCompany } from './biz-company';
import { bizJobs } from './biz-jobs';
import { bizMembers } from './biz-members';

export const biz = new Hono<AppEnv>();

// /biz 아래 모든 경로는 기업 담당자·헤드헌터만.
biz.use('*', requireRole('company', 'headhunter'));

const EMPTY_FORM = inputFromFields({
  name_ko: '', name_zh: null, entity_type: 'kr_entity', biz_no: null, hq_name: null,
  entry_stage: null, industry: null, website: null, profile_ko: null,
});

const HOME_OK: Record<string, string> = { registered: 'co.ok.registered', joined: 'inv.ok.joined', saved: 'co.ok.saved' };

biz.get('/', async (c) => {
  const ctx = await loadBizCtx(c);
  const l = c.var.locale;
  if (ctx.user.role !== 'company') return render(c, <Placeholder locale={l} titleKey="biz.title" textKey="biz.soon" />, 'biz.title');
  if (!hasCompany(ctx)) {
    const invites = await listPendingInvitesForEmail(c.env.DB, ctx.user.email);
    return render(c, <BizStart locale={l} invites={invites} input={EMPTY_FORM} errors={[]} />, 'biz.title');
  }
  const co = ctx.company;
  const blocks = verifyBlocks({ entity_type: co.entity_type, biz_no: co.biz_no, docTypes: await companyDocTypes(c, co.id) });
  return render(
    c,
    <BizHome locale={l} company={co} isOwner={ctx.member.member_role === 'owner'} blocks={blocks} ok={HOME_OK[c.req.query('ok') ?? '']} />,
    'biz.title',
  );
});

biz.get('/company', (c) => c.redirect('/biz'));

// 기업 등록: 기업과 대표 담당자(owner)를 한 번에 만든다. 이미 소속이 있으면 거부한다 (1차는 한 사람이 기업 하나).
biz.post('/company', async (c) => {
  const ctx = await loadBizCtx(c);
  const l = c.var.locale;
  if (ctx.user.role !== 'company') return renderError(c, 403);
  if (ctx.member) return render(c, <Notice locale={l} textKey="co.err.already_member" />, 'biz.title', 400);
  const f = await c.req.parseBody();
  const input = readCompanyForm(f, false);
  const r = validateCompany(input);
  if (!r.ok) {
    const invites = await listPendingInvitesForEmail(c.env.DB, ctx.user.email);
    return render(c, <BizStart locale={l} invites={invites} input={input} errors={r.errors} />, 'biz.title', 400);
  }
  const v = r.value;
  const id = crypto.randomUUID();
  const ts = now();
  // 기업과 대표 담당자를 한 트랜잭션에서, 둘 다 "아직 소속이 없을 때만" 만든다 (src/db/companies.ts registerCompany).
  const created = await registerCompany(c.env.DB, {
    id, name_ko: v.name_ko, name_zh: v.name_zh, biz_no: v.biz_no, entity_type: v.entity_type, hq_name: v.hq_name,
    entry_stage: v.entry_stage, industry: v.industry, website: v.website, ts, userId: ctx.user.id, ownerIsHq: ownerIsHq(v.entity_type),
  });
  if (!created) return render(c, <Notice locale={l} textKey="co.err.already_member" />, 'biz.title', 400);
  return c.redirect('/biz?ok=registered');
});

// 초대 수락: 초대받은 이메일로 로그인한 본인만, 아직 소속이 없을 때만.
biz.post('/invites/:id/accept', async (c) => {
  const ctx = await loadBizCtx(c);
  const l = c.var.locale;
  if (ctx.user.role !== 'company') return renderError(c, 403);
  if (ctx.member) return render(c, <Notice locale={l} textKey="co.err.already_member" />, 'biz.title', 400);
  const inviteId = c.req.param('id');
  const email = ctx.user.email.toLowerCase();
  const ts = now();
  const joined = await acceptInvite(c.env.DB, { userId: ctx.user.id, ts, inviteId, email });
  // 없는 초대·남의 초대·이미 수락한 초대를 구분해 알려주지 않는다.
  if (!joined) return renderError(c, 404);
  return c.redirect('/biz?ok=joined');
});

// 검증 서류 내려받기: 권한 확인·열람 기록·전송은 serveVerificationDoc 이 한다.
biz.get('/docs/:id', async (c) => {
  const ctx = await loadBizCtx(c);
  const r = await serveVerificationDoc(c.env, ctx.actor, c.req.param('id'));
  return r ?? renderError(c, 404);
});

biz.route('/', bizCompany);
biz.route('/', bizMembers);
biz.route('/', bizJobs);
