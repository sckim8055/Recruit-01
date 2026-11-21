// 기업 담당자·헤드헌터 화면. 지금은 첫 화면 자리만 있다 (기업 등록·공고는 T-04·T-05).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireRole } from '../lib/auth';
import { render } from '../render';
import { Placeholder } from '../views/pages';

export const biz = new Hono<AppEnv>();

// /biz 아래 모든 경로는 기업 담당자·헤드헌터만.
biz.use('*', requireRole('company', 'headhunter'));

biz.get('/', (c) => render(c, <Placeholder locale={c.var.locale} titleKey="biz.title" textKey="biz.soon" />, 'biz.title'));
