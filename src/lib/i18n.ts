// 화면 문구. 한국어(구직자·기업)와 중국어(기업). 문구에 "취업상담·취업추천·취업지원" 을 쓰지 않는다 (rules.ts).
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv, Locale } from '../env';
import { ko } from '../locales/ko';
import { zh } from '../locales/zh';

const DICT: Record<Locale, Record<string, string>> = { ko, zh };

export function t(locale: Locale, key: string): string {
  return DICT[locale][key] ?? DICT.ko[key] ?? key;
}

/** 우선순위: ?lang= → 쿠키 → 로그인 사용자 설정 → Accept-Language → ko */
export function detectLocale(c: Context<AppEnv>): Locale {
  const q = c.req.query('lang');
  if (q === 'ko' || q === 'zh') return q;
  const ck = getCookie(c, 'lang');
  if (ck === 'ko' || ck === 'zh') return ck;
  if (c.var.user) return c.var.user.locale;
  return /^zh\b/i.test(c.req.header('accept-language') ?? '') ? 'zh' : 'ko';
}
