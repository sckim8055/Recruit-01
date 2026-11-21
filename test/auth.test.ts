import { describe, expect, it } from 'vitest';
import { sessionUsable } from '../src/lib/auth';

describe('sessionUsable', () => {
  it('관리자는 TOTP 를 통과한 세션만 인정한다', () => {
    expect(sessionUsable('admin', 0)).toBe(false);
    expect(sessionUsable('admin', 1)).toBe(true);
  });
  it('다른 역할은 TOTP 가 필요 없다', () => {
    expect(sessionUsable('seeker', 0)).toBe(true);
    expect(sessionUsable('company', 0)).toBe(true);
  });
});
