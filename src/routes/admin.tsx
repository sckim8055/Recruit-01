// 관리자 화면. 지금은 첫 화면 자리만 있다 (TOTP·검증 대기 목록은 T-03).
// 관리자에게 없는 기능: 공고 내용 수정, 이력서 전달, 추천 발송 (CLAUDE.md 규칙 1).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireRole } from '../lib/auth';
import { render } from '../render';
import { Placeholder } from '../views/pages';

export const admin = new Hono<AppEnv>();

// /admin 아래 모든 경로는 관리자만.
admin.use('*', requireRole('admin'));

admin.get('/', (c) => render(c, <Placeholder locale={c.var.locale} titleKey="admin.title" textKey="admin.soon" />, 'admin.title'));
