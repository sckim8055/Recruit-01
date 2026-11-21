// 이용약관·개인정보처리방침 (T-11). 누구나 볼 수 있고 동의하지 않은 회원도 열 수 있다 (lib/consent 의 예외 주소).
// 로그인하지 않은 요청은 홈과 같이 page-cache(60초)를 거친다. 로그인한 요청은 no-store (page-cache 가 처리).
// 개인정보처리방침의 보관 기간은 지금 설정값으로 채운다 (T-12c, legal/render.renderLegal — 캐시에 없는 요청마다 설정 한 행 읽기).
// 비로그인 방문자에게는 설정을 바꾼 뒤 최대 60초(page-cache TTL) 예전 숫자가 보일 수 있다.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { PRIVACY } from '../legal/privacy';
import { renderLegal } from '../legal/render';
import { fmtDate } from '../lib/company';
import { t } from '../lib/i18n';
import { RETENTION_SETTING } from '../lib/retention';
import { loadRetention } from '../lib/retention-setting';
import { getSettingWithMeta } from '../db/settings';
import { TERMS } from '../legal/terms';
import { pageCache } from '../lib/page-cache';
import { render } from '../render';
import { LegalPage } from '../views/legal';

export const legal = new Hono<AppEnv>();

legal.get('/terms', pageCache, (c) => {
  const doc = TERMS[c.var.locale];
  return render(c, <LegalPage locale={c.var.locale} doc={doc} other="privacy" />, { text: doc.title });
});

legal.get('/privacy', pageCache, async (c) => {
  const doc = renderLegal(PRIVACY, await loadRetention(c.env.DB))[c.var.locale];
  // 관리자가 보관 기간을 바꾼 적이 있으면 그 날짜를 문서 위에 알린다 (방침 11항: 바뀐 내용과 시행일을 알린다).
  // 기간을 줄이는 변경은 다시 동의를 받지 않으므로, 이 줄이 변경을 알리는 자리다.
  const meta = await getSettingWithMeta(c.env.DB, RETENTION_SETTING);
  const note = meta ? t(c.var.locale, 'legal.retention_changed').replace('{date}', fmtDate(meta.updated_at)) : undefined;
  return render(c, <LegalPage locale={c.var.locale} doc={doc} other="terms" note={note} />, { text: doc.title });
});
