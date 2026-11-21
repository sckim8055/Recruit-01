// 기업 → 지원자 메일 (T-09b 핵심): 보낼 수 있는 사람, 횟수·상태 조건, 메일 내용, 발송 뒤에만 기록, 메시지 번역.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/lib/authz';
import { interviewMail, readMessage, rejectMail, sendInterviewRequest, sendRejection, INTERVIEW_MAIL_MAX } from '../src/lib/applicant-mail';
import { b64url, importEncKey } from '../src/lib/crypto';
import { t } from '../src/lib/i18n';
import { messageRequest, parseMessageTranslation, translateMessage, MESSAGE_MAX } from '../src/lib/localize/message';
import { EngineError, type LocalizeEngine } from '../src/lib/localize/types';
import { sealResume, type ResumeBody } from '../src/lib/resume';
import { getApplicationWithJob } from '../src/db/applicants';
import type { Env } from '../src/env';
import { hasSqlite, migratedDb } from './sqlite-d1';

const KEY = b64url(new Uint8Array(32).fill(7)).replace(/-/g, '+').replace(/_/g, '/');
const mk = (p: Partial<Actor>): Actor => ({ id: 'm1', role: 'company', companyIds: [], hqCompanyIds: [], agencyIds: [], ...p });
const body: ResumeBody = {
  v: 1, name: '홍길동', chinese_level: 'business', years: 5, headline: '한 줄 소개', contact_email: 'hong@example.test',
  phone: '010-0000-0000', desired_role: null, experience_text: '경력', file: null,
};
afterEach(() => vi.unstubAllGlobals());

describe('메시지 폼', () => {
  it('비어 있거나 2000자를 넘으면 거부, 줄바꿈은 유지', () => {
    expect(readMessage(' 你好\r\n明天见 ')).toEqual({ ok: true, text: '你好\n明天见' });
    expect(readMessage('  ')).toEqual({ ok: false, why: 'required' });
    expect(readMessage(undefined)).toEqual({ ok: false, why: 'required' });
    expect(readMessage('x'.repeat(MESSAGE_MAX + 1))).toEqual({ ok: false, why: 'too_long' });
  });
});

describe('메일 글', () => {
  const p = { companyName: '가짜전자', jobTitle: '영업 매니저', original: '您好，请于11月25日14:00来面试。\n地点：首尔江南区', translationKo: '안녕하세요, 11월 25일 14:00에 면접에 와 주세요.\n장소: 서울 강남구' };
  it('면접 요청: 번역과 원문이 함께 들어가고, 원문은 한 글자도 바뀌지 않는다', () => {
    const m = interviewMail(p, t);
    expect(m.subject).toContain('가짜전자');
    expect(m.subject).toContain('영업 매니저');
    expect(m.text).toContain(p.original);
    expect(m.text).toContain(p.translationKo);
    expect(m.text).toContain('자동 번역');
    expect(m.text.indexOf(p.translationKo)).toBeLessThan(m.text.indexOf(p.original));
    expect(m.text).toContain('관여하지 않습니다');
    expect(m.text).not.toMatch(/\{\w+\}/);
  });
  it('번역이 없거나 원문과 같으면 원문만 들어간다', () => {
    for (const translationKo of [null, '', p.original]) {
      const m = interviewMail({ ...p, translationKo }, t);
      expect(m.text).toContain(p.original);
      expect(m.text).not.toContain('자동 번역');
      expect(m.text.split(p.original)).toHaveLength(2);
    }
  });
  it('불합격 통보는 정해진 글이며 금지 표현이 없다', () => {
    const m = rejectMail({ companyName: '가짜전자', jobTitle: '영업\n매니저' }, t);
    expect(m.subject).toContain('영업 매니저');
    expect(m.text).toContain('가짜전자');
    expect(m.text).not.toMatch(/\{\w+\}/);
    for (const s of ['취업상담', '취업추천', '취업지원', '취업알선']) expect(m.subject + m.text + interviewMail(p, t).text).not.toContain(s);
  });
});

describe.skipIf(!hasSqlite)('메일 보내기', () => {
  const setup = async () => {
    const { raw, d1 } = migratedDb();
    const sealed = await sealResume(await importEncKey(KEY), body);
    raw.exec(`INSERT INTO users (id, email, role, status, created_at) VALUES
      ('s1','s1@example.test','seeker','active',0), ('m1','m1@example.test','company','active',0), ('m2','m2@example.test','company','active',0),
      ('x1','x1@example.test','company','active',0), ('adm','adm@example.test','admin','active',0)`);
    raw.exec("INSERT INTO companies (id, name_ko, entity_type, verify_status, created_at) VALUES ('c1','가짜전자','kr_entity','verified',0)");
    raw.exec("INSERT INTO jobs (id, company_id, created_by, job_family, title_ko, body_ko, localize_status, status, created_at, updated_at) VALUES ('j1','c1','m1','office','영업 매니저','본문','approved','published',0,0)");
    raw.prepare("INSERT INTO applications (id, job_id, seeker_id, resume_snapshot, cross_border_consent_at, status, status_changed_at, created_at) VALUES ('a1','j1','s1',?,NULL,'viewed',10,10)").run(sealed);
    const sent: Array<Record<string, unknown>> = [];
    let mailStatus = 200;
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (mailStatus === -1) throw new TypeError('network down');
      sent.push(JSON.parse(String(init!.body)));
      return new Response('{}', { status: mailStatus });
    }));
    const env = { ENC_KEY: KEY, DB: d1, APP_ENV: 'test', RESEND_API_KEY: 'k', MAIL_FROM: 'Recruit <no-reply@x.test>' } as unknown as Env;
    const load = async () => (await getApplicationWithJob(d1, 'a1'))!;
    const events = () => raw.prepare('SELECT event, actor_id FROM application_events ORDER BY at, id').all().map((r) => ({ ...r }));
    return { raw, env, load, events, sent, failMail: () => { mailStatus = 500; }, breakNetwork: () => { mailStatus = -1; } };
  };
  const local = mk({ id: 'm1', companyIds: ['c1'] });
  const msg = { companyName: '가짜전자', original: '请于11月25日来面试', translationKo: '11월 25일에 면접에 와 주세요', replyTo: 'm1@example.test' };

  it('면접 요청: 지원서의 연락 이메일로 가고, 답장 주소는 담당자, 상태는 면접 요청으로', async () => {
    const { env, load, events, sent } = await setup();
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: true, status: 'interview' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ['hong@example.test'], reply_to: 'm1@example.test' });
    expect(String(sent[0]!.text)).toContain(msg.original);
    expect(String(sent[0]!.text)).toContain(msg.translationKo);
    // 메일에 지원서 내용(이름·전화·소개)은 들어가지 않는다
    for (const s of ['홍길동', '010-0000-0000', '한 줄 소개']) expect(JSON.stringify(sent[0])).not.toContain(s);
    expect(events()).toEqual([{ event: 'interview_mail', actor_id: 'm1' }]);
    expect((await load()).status).toBe('interview');
  });
  it(`면접 요청은 한 지원에 ${INTERVIEW_MAIL_MAX}번까지`, async () => {
    const { env, load, events, sent } = await setup();
    for (let i = 0; i < INTERVIEW_MAIL_MAX; i++) expect((await sendInterviewRequest(env, local, await load(), msg, t)).ok).toBe(true);
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'limit' });
    expect([sent.length, events().length]).toEqual([INTERVIEW_MAIL_MAX, INTERVIEW_MAIL_MAX]);
  });
  it('관리자·다른 기업·구직자·동의 없는 본사 담당자는 보낼 수 없고, 메일도 기록도 없다', async () => {
    const { env, load, events, sent } = await setup();
    for (const a of [mk({ id: 'adm', role: 'admin' }), mk({ id: 'x1', companyIds: ['c2'] }), mk({ id: 's1', role: 'seeker' }), mk({ id: 'm2', companyIds: ['c1'], hqCompanyIds: ['c1'] })]) {
      expect(await sendInterviewRequest(env, a, await load(), msg, t)).toEqual({ ok: false, why: 'forbidden' });
      expect(await sendRejection(env, a, await load(), msg, t)).toEqual({ ok: false, why: 'forbidden' });
    }
    expect([sent.length, events().length, (await load()).status]).toEqual([0, 0, 'viewed']);
  });
  it('취소·불합격·종료된 지원에는 보낼 수 없다', async () => {
    const { env, load, sent, raw } = await setup();
    for (const s of ['rejected', 'closed']) {
      raw.exec(`UPDATE applications SET status = '${s}' WHERE id = 'a1'`);
      expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'not_open' });
      expect(await sendRejection(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'not_open' });
    }
    raw.exec("UPDATE applications SET status = 'withdrawn', resume_snapshot = '' WHERE id = 'a1'");
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'forbidden' });
    expect(sent).toHaveLength(0);
  });
  it('메일이 나가지 않으면 기록도 상태 변화도 없다', async () => {
    const { env, load, events, failMail } = await setup();
    failMail();
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'mail_failed' });
    expect(await sendRejection(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'mail_failed' });
    expect([events().length, (await load()).status]).toEqual([0, 'viewed']);
  });
  it('메일 서버에 연결하지 못해도 예외가 아니라 "보내지 못함" 이고, 발송 기록에는 남는다', async () => {
    const { env, load, events, breakNetwork, raw } = await setup();
    breakNetwork();
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'mail_failed' });
    expect([events().length, (await load()).status]).toEqual([0, 'viewed']);
    expect({ ...raw.prepare('SELECT template, result FROM email_log').get()! }).toEqual({ template: 'interview_request', result: 'error_network' });
  });
  it('열 수 없는 지원서에는 보내지 않는다', async () => {
    const { env, load, sent, raw } = await setup();
    raw.exec("UPDATE applications SET resume_snapshot = 'v1.AAAA.BBBB' WHERE id = 'a1'");
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'unreadable' });
    expect(sent).toHaveLength(0);
  });
  it('불합격 통보: 한 번만, 보낸 뒤에는 면접 요청도 보낼 수 없다', async () => {
    const { env, load, events, sent } = await setup();
    expect(await sendRejection(env, local, await load(), msg, t)).toEqual({ ok: true, status: 'rejected' });
    expect(sent[0]).toMatchObject({ to: ['hong@example.test'], reply_to: 'm1@example.test' });
    expect(String(sent[0]!.text)).not.toContain('홍길동');
    expect(await sendRejection(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'not_open' });
    expect(await sendInterviewRequest(env, local, await load(), msg, t)).toEqual({ ok: false, why: 'not_open' });
    expect([sent.length, events()]).toEqual([1, [{ event: 'reject_mail', actor_id: 'm1' }]]);
  });
  it('메일을 보내는 사이 지원이 취소됐으면 기록되지 않았다고 알린다', async () => {
    const { env, load, events, raw } = await setup();
    const stale = await load();
    raw.exec("UPDATE applications SET status = 'withdrawn' WHERE id = 'a1'");
    expect(await sendInterviewRequest(env, local, stale, msg, t)).toEqual({ ok: false, why: 'changed' });
    expect(events()).toEqual([]);
  });
});

describe('메시지 번역', () => {
  const engine = (id: string, out: string | Error): LocalizeEngine => ({ id, available: () => true, complete: vi.fn(async () => { if (out instanceof Error) throw out; return out; }) });
  it('엔진에는 메시지 글만 보낸다', () => {
    const r = messageRequest('请于11月25日来面试');
    expect(r.user).toContain('请于11月25日来面试');
    expect(r.system).toContain('원문 그대로');
    expect(r.system).toContain('JSON');
  });
  it('번역을 꺼내고, 지나치게 긴 출력·형식이 다른 출력은 버린다', () => {
    expect(parseMessageTranslation('{"ko":"안녕하세요"}', '你好')).toBe('안녕하세요');
    expect(parseMessageTranslation('```json\n{"ko":"안녕하세요"}\n```', '你好')).toBe('안녕하세요');
    expect(parseMessageTranslation('안녕하세요', '你好')).toBeNull();
    expect(parseMessageTranslation(JSON.stringify({ ko: 'x'.repeat(300) }), '你好')).toBeNull();
    expect(parseMessageTranslation('{"ko":""}', '你好')).toBeNull();
  });
  it('첫 엔진이 실패하면 다음 엔진, 모두 실패하면 실패 (예외 없음)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await translateMessage({}, '你好', [engine('a', new EngineError('http', 503)), engine('b', '{"ko":"안녕하세요"}')])).toEqual({ ok: true, ko: '안녕하세요', engine: 'b' });
    expect(await translateMessage({}, '你好', [engine('a', 'not json'), engine('b', new Error('x'))])).toEqual({ ok: false, why: 'all_failed' });
    expect(await translateMessage({}, '你好', [])).toEqual({ ok: false, why: 'no_engine' });
    // 콘솔에는 엔진 id 와 오류 종류만 (메시지 글 없음)
    expect(spy.mock.calls.flat().join(' ')).not.toContain('你好');
    spy.mockRestore();
  });
});
