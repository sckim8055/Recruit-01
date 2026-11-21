// 브라우저 폼 전송이 막히지 않게 하는 머리글 확인.
// Referrer-Policy 가 no-referrer 이면 브라우저는 같은 사이트 POST 에도 Origin: null 을 보내 sameOrigin 검사에 걸린다.
import { describe, expect, it } from 'vitest';
import app from '../src/index';

describe('보안 머리글', () => {
  it('Referrer-Policy 는 same-origin', async () => {
    const res = await app.fetch(new Request('http://localhost/api/health') as never, { APP_ENV: 'dev' } as never);
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });
});
