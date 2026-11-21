import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, totpAt, verifyTotp } from '../src/lib/totp';

// RFC 6238 부록 B 의 SHA-1 시험 벡터 (8자리 값의 뒤 6자리)
const secret = new TextEncoder().encode('12345678901234567890');

describe('totp', () => {
  it('RFC 6238 시험 벡터와 일치한다', async () => {
    expect(await totpAt(secret, 59)).toBe('287082');
    expect(await totpAt(secret, 1111111109)).toBe('081804');
    expect(await totpAt(secret, 1234567890)).toBe('005924');
    expect(await totpAt(secret, 20000000000)).toBe('353130');
  });
  it('base32 왕복', () => {
    expect(base32Encode(secret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect([...base32Decode('gezd gnbv-gy3t qojq GEZDGNBVGY3TQOJQ')]).toEqual([...secret]);
    expect(base32Decode(newTotpSecret()).length).toBe(20);
  });
  it('앞뒤 30초까지 받고 그 밖은 거부한다', async () => {
    const t = 1234567890, step = Math.floor(t / 30);
    expect(await verifyTotp(secret, '005924', t, null)).toBe(step);
    expect(await verifyTotp(secret, '005924', t + 30, null)).toBe(step);
    expect(await verifyTotp(secret, '005924', t - 30, null)).toBe(step);
    expect(await verifyTotp(secret, '005924', t + 90, null)).toBeNull();
    expect(await verifyTotp(secret, '000000', t, null)).toBeNull();
    expect(await verifyTotp(secret, '5924', t, null)).toBeNull();
  });
  it('이미 쓴 번호는 다시 받지 않는다', async () => {
    const t = 1234567890, step = Math.floor(t / 30);
    expect(await verifyTotp(secret, '005924', t, step)).toBeNull();
    expect(await verifyTotp(secret, '005924', t, step - 1)).toBe(step);
  });
  it('등록 주소 형식', () => {
    expect(otpauthUri('Recruit', 'a@b.co', 'ABC')).toBe('otpauth://totp/Recruit%3Aa%40b.co?secret=ABC&issuer=Recruit&algorithm=SHA1&digits=6&period=30');
  });
});
