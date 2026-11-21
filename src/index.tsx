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
import { pageCache } from './lib/page-cache';

const app = new Hono<AppEnv>();

// Referrer-Policy 는 same-origin 으로 둔다. 기본값(no-referrer)이면 브라우저가 같은 사이트의 폼 전송에도
// Origin 을 "null" 로 보내서 아래 sameOrigin 검사(CSRF 방어)가 모든 폼을 막는다. same-origin 은 바깥 사이트로는 여전히 아무것도 보내지 않는다.
app.use('*', secureHeaders({ referrerPolicy: 'same-origin' }));
app.use('*', sameOrigin);
app.use('*', loadUser);
app.use('*', async (c, next) => {
  c.set('locale', detectLocale(c));
  await next();
});

// 홈·공고 화면은 로그인하지 않은 요청을 60초 캐시한다 (lib/page-cache.ts).
app.get('/', pageCache, homePage);
app.get('/api/health', (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.route('/', auth);
app.route('/biz', biz);
app.route('/admin', admin);
app.route('/companies', companies);
app.route('/jobs', jobs);

// 이후 라우트는 docs/TASKS.md 순서대로 src/routes/ 에 추가한다:
//   apply.tsx (지원)

app.notFound((c) => renderError(c, 404));
app.onError((err, c) => {
  // 개인정보가 로그에 남지 않도록 메시지만 남긴다.
  console.error('error:', err instanceof Error ? err.message : 'unknown');
  return c.text('Internal Server Error', 500);
});

export default {
  fetch: app.fetch,
  // 예약 작업 (매일 03:00 KST). 구현은 docs/TASKS.md T-12.
  async scheduled(_ev: ScheduledController, _env: Env, _ctx: ExecutionContext) {},
} satisfies ExportedHandler<Env>;
