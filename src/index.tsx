// 진입점. 화면(SSR)과 API 를 하나의 Worker 로 제공한다. 정적 파일은 public/ 에서 자동 제공된다.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Env } from './env';
import { loadUser, sameOrigin } from './lib/auth';
import { detectLocale } from './lib/i18n';
import { renderError } from './render';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { biz } from './routes/biz';
import { companies } from './routes/companies';
import { homePage, jobs } from './routes/jobs';
import { resumes } from './routes/resumes';
import { applications, apply } from './routes/applications';
import { missingConsents, needsConsentCheck, requiredConsents, safeNext } from './lib/consent';
import { listRequiredConsents } from './db/consents';
import { loadRetention } from './lib/retention-setting';
import { PUBLIC_FILES } from './lib/static-files';
import { render } from './render';
import { account } from './routes/account';
import { legal } from './routes/legal';
import { NO_STORE } from './routes/guards';
import { ConsentRequired } from './views/account';
import { homeCache } from './routes/jobs';
import { devForcedStep, runMaintenance } from './lib/maintenance';
import { MAINTENANCE_RETRY_AFTER, maintenanceBlocks } from './lib/pause';
import { MaintenancePage } from './views/pages';
import { isOneClickUnsubscribe, isUnsubscribePath } from './lib/alerts';
import { alerts, unsubscribe } from './routes/alerts';

const app = new Hono<AppEnv>();

// Referrer-Policy 는 same-origin 으로 둔다. 기본값(no-referrer)이면 브라우저가 같은 사이트의 폼 전송에도
// Origin 을 "null" 로 보내서 아래 sameOrigin 검사(CSRF 방어)가 모든 폼을 막는다. same-origin 은 바깥 사이트로는 여전히 아무것도 보내지 않는다.
app.use('*', secureHeaders({ referrerPolicy: 'same-origin' }));
// 출처 검사(CSRF 방어). 빠지는 요청은 하나뿐이다: 조건 알림 메일의 RFC 8058 한 번 클릭 해지 `POST /alerts/u/<토큰>` (T-10) —
// 메일 프로그램이 쿠키·Origin 없이 보내므로 출처를 확인할 수 없고, 토큰이 권한이다(그 알림 하나를 멈추는 일만 한다). lib/alerts.isOneClickUnsubscribe.
app.use('*', (c, next) => (isOneClickUnsubscribe(c.req.method, c.req.path) ? next() : sameOrigin(c, next)));
app.use('*', loadUser);
app.use('*', async (c, next) => {
  c.set('locale', detectLocale(c));
  await next();
});

// 점검 모드 (T-13, lib/pause.ts): MAINTENANCE = "on" 이면 관리자·로그인·/api/health 말고 모두 503 점검 안내.
// 동의 확인·라우트(공개 화면 캐시 포함)보다 먼저 돌아서 캐시된 화면도 나가지 않고 D1 도 읽지 않는다 (세션 읽기는 위 loadUser 에서 이미 함).
app.use('*', async (c, next) => {
  if (!maintenanceBlocks(c.env.MAINTENANCE, c.var.user?.role ?? null, c.req.path)) return next();
  c.header('Cache-Control', NO_STORE);
  c.header('Retry-After', String(MAINTENANCE_RETRY_AFTER));
  return render(c, <MaintenancePage locale={c.var.locale} />, 'maint.title', 503);
});

// 이용약관·개인정보 동의 확인 (T-11). 로그인한 회원(관리자 제외)이 지금 판에 동의하지 않았으면 서비스 화면을 열 수 없다.
// - 비로그인 요청은 여기서 아무것도 읽지 않는다 (캐시되는 공개 화면이 D1 을 읽지 않게). 로그인한 요청은 요청마다 작은 읽기 두 번을 동시에
//   (consents 의 idx_consents_user + 보관 기간 설정 site_settings 'retention' 기본 키 한 행 — 개인정보처리방침의 지금 판이 그 설정의 rev 로 정해진다, T-12c).
//   따로 캐시하지 않는다.
// - 예외 주소(문서·동의 화면·로그인·로그아웃·언어·계정/탈퇴, lib/consent.consentExempt)와 public/ 의 정적 파일은 확인하지 않는다.
// - GET·HEAD → /consent?next=<원래 경로+검색 조건> (safeNext 가 받는 경로일 때만), 그 밖의 메서드 → 403 (아무것도 처리하지 않는다).
app.use('*', async (c, next) => {
  const u = c.var.user;
  const path = c.req.path;
  // 조건 알림의 해지 링크(/alerts/u/…, T-10)는 동의를 다시 하지 않은 회원도 열 수 있어야 한다 (메일을 끌 수 있게).
  if (!u || PUBLIC_FILES.has(path) || !needsConsentCheck(u.role, path) || isUnsubscribePath(path)) return next();
  const [rows, retention] = await Promise.all([listRequiredConsents(c.env.DB, u.id), loadRetention(c.env.DB)]);
  if (!missingConsents(rows, requiredConsents(retention)).length) return next();
  c.header('Cache-Control', NO_STORE);
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    const url = new URL(c.req.url);
    const orig = url.pathname + url.search;
    return c.redirect(safeNext(orig) === orig ? `/consent?next=${encodeURIComponent(orig)}` : '/consent');
  }
  return render(c, <ConsentRequired locale={c.var.locale} />, 'consent.gate.title', 403);
});

// 홈·공고 화면은 로그인하지 않은 요청을 60초 캐시한다 (lib/page-cache.ts).
// ?bye=1 (탈퇴 직후 안내)은 캐시를 거치지 않는다 (routes/jobs.homeCache).
app.get('/', homeCache, homePage);
app.get('/api/health', (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.route('/my/resumes', resumes);
app.route('/my/applications', applications);
app.route('/my/alerts', alerts);
app.route('/alerts/u', unsubscribe);
app.route('/', auth);
app.route('/', legal);
app.route('/', account);
app.route('/biz', biz);
app.route('/admin', admin);
app.route('/companies', companies);
// 지원(/jobs/:id/apply)은 공개 공고 화면보다 먼저 붙인다. page-cache 를 거치지 않는다 (routes/applications.tsx).
app.route('/jobs', apply);
app.route('/jobs', jobs);


app.notFound((c) => renderError(c, 404));
app.onError((err, c) => {
  // 개인정보가 로그에 남지 않도록 메시지만 남긴다.
  console.error('error:', err instanceof Error ? err.message : 'unknown');
  return c.text('Internal Server Error', 500);
});

export default {
  fetch: app.fetch,
  // 예약 작업 (T-12, 매시 정각 — wrangler.jsonc "0 * * * *"). 한 번에 한 단계만 한다 (lib/maintenance.SCHEDULE, docs/ARCHITECTURE.md 14절).
  // 단계를 골라 실행하는 것(cron 문자열 "maint:<단계>")은 APP_ENV 가 dev 일 때만 받는다 — 배포 환경의 cron 문자열은 wrangler.jsonc 에 적은 것뿐이다.
  // 정리 작업을 실행하는 HTTP 경로는 없다.
  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    const force = env.APP_ENV === 'dev' ? devForcedStep(ev.cron) : undefined;
    ctx.waitUntil(runMaintenance(env, Math.floor(ev.scheduledTime / 1000), { force }));
  },
} satisfies ExportedHandler<Env>;
