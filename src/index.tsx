// 진입점. 화면(SSR)과 API 를 하나의 Worker 로 제공한다. 정적 파일은 public/ 에서 자동 제공된다.
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Env } from './env';
import { loadUser, sameOrigin } from './lib/auth';
import { detectLocale } from './lib/i18n';
import { render, renderError } from './render';
import { admin } from './routes/admin';
import { auth } from './routes/auth';
import { biz } from './routes/biz';
import { Home } from './views/pages';

const app = new Hono<AppEnv>();

app.use('*', secureHeaders());
app.use('*', sameOrigin);
app.use('*', loadUser);
app.use('*', async (c, next) => {
  c.set('locale', detectLocale(c));
  await next();
});

app.get('/', (c) => render(c, <Home locale={c.var.locale} />));
app.get('/api/health', (c) => c.json({ ok: true, env: c.env.APP_ENV }));
app.route('/', auth);
app.route('/biz', biz);
app.route('/admin', admin);

// 이후 라우트는 docs/TASKS.md 순서대로 src/routes/ 에 추가한다:
//   company.tsx (기업 검증·기업 페이지) · jobs.tsx (공고) · apply.tsx (지원)

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
