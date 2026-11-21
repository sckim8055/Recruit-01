// TOTP (RFC 6238: HMAC-SHA1, 30초, 6자리). 순수 함수 — test/totp.test.ts 가 RFC 시험 벡터로 검증한다.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

async function hotp(secret: Uint8Array, counter: number, digits = 6): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = mac[mac.length - 1]! & 15;
  const bin = ((mac[off]! & 127) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const totpAt = (secret: Uint8Array, unixSec: number): Promise<string> => hotp(secret, Math.floor(unixSec / TOTP_STEP));

/**
 * 인증번호가 맞으면 통과한 시간 단계를, 아니면 null 을 돌려준다.
 * 시계 오차를 감안해 앞뒤 한 단계(±30초)까지 받는다. lastStep 이하의 단계는 받지 않는다 (같은 번호 재사용 방지).
 */
export async function verifyTotp(secret: Uint8Array, code: string, unixSec: number, lastStep: number | null): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = Math.floor(unixSec / TOTP_STEP);
  let matched: number | null = null;
  // 걸리는 시간이 맞은 위치에 따라 달라지지 않도록 세 단계를 모두 계산한다.
  for (const step of [cur - 1, cur, cur + 1]) {
    const expect = await hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < 6; i++) diff |= expect.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && (lastStep === null || step > lastStep) && matched === null) matched = step;
  }
  return matched;
}

/** 인증 앱에 등록할 때 쓰는 주소. */
export function otpauthUri(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
