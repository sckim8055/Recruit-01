// 이용약관·개인정보처리방침 (T-11). 누구나 볼 수 있고 동의하지 않은 회원도 열 수 있다 (lib/consent 의 예외 주소).
// 로그인하지 않은 요청은 홈과 같이 page-cache(60초)를 거친다. 로그인한 요청은 no-store (page-cache 가 처리).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { PRIVACY } from '../legal/privacy';
import { TERMS } from '../legal/terms';
import { pageCache } from '../lib/page-cache';
import { render } from '../render';
import { LegalPage } from '../views/legal';

export const legal = new Hono<AppEnv>();

legal.get('/terms', pageCache, (c) => {
  const doc = TERMS[c.var.locale];
  return render(c, <LegalPage locale={c.var.locale} doc={doc} other="privacy" />, { text: doc.title });
});

legal.get('/privacy', pageCache, (c) => {
  const doc = PRIVACY[c.var.locale];
  return render(c, <LegalPage locale={c.var.locale} doc={doc} other="terms" />, { text: doc.title });
});
