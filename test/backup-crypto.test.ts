// 백업 파일 암호화 (T-13, scripts/lib/backup-crypto.mjs): 왕복 · 틀린 비밀문구 · 변조 · 형식. 모든 값은 가짜다.
// 빠르게 돌도록 대부분 scrypt 강도를 낮춰(logN 10) 시험하고, 기본 강도는 한 번만 왕복한다.
import { describe, expect, it } from 'vitest';
import { BackupDecryptError, decryptBackup, DEFAULT_PARAMS, encryptBackup, MIN_PASSPHRASE } from '../scripts/lib/backup-crypto.mjs';

const FAST = { logN: 10, r: 8, p: 1 };
const PASS = 'correct horse battery';
const SQL = new TextEncoder().encode("PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO users VALUES('u1','fake@example.test','seeker');\n");

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const copy = (a: Uint8Array) => new Uint8Array(a);
const latin1 = (a: Uint8Array) => Array.from(a, (x) => String.fromCharCode(x)).join('');

const code = (f: () => unknown): string => {
  try { f(); return 'no error'; } catch (e) { return e instanceof BackupDecryptError ? e.message : `other: ${String(e)}`; }
};

describe('백업 암호화', () => {
  it('같은 비밀문구로 풀면 원래 바이트, 암호문에는 평문이 없다', () => {
    const enc = encryptBackup(SQL, PASS, FAST);
    expect(new TextDecoder().decode(enc.subarray(0, 4))).toBe('RBK1');
    expect(latin1(enc).includes('fake@example.test')).toBe(false);
    expect(same(decryptBackup(enc, PASS), SQL)).toBe(true);
  });

  it('기본 강도(scrypt N=2^17)로도 왕복한다', () => {
    expect(DEFAULT_PARAMS.logN).toBe(17);
    const enc = encryptBackup(SQL, PASS);
    expect(same(decryptBackup(enc, PASS), SQL)).toBe(true);
  });

  it('같은 입력도 매번 다른 암호문 (무작위 salt·iv)', () => {
    expect(same(encryptBackup(SQL, PASS, FAST), encryptBackup(SQL, PASS, FAST))).toBe(false);
  });

  it('틀린 비밀문구는 풀리지 않는다', () => {
    const enc = encryptBackup(SQL, PASS, FAST);
    expect(code(() => decryptBackup(enc, 'correct horse battery!'))).toBe('wrong_passphrase_or_tampered');
    expect(code(() => decryptBackup(enc, ''))).toBe('wrong_passphrase_or_tampered');
  });

  it('한 바이트라도 바뀌면(머리·본문·태그 어디든) 풀리지 않는다', () => {
    const enc = copy(encryptBackup(SQL, PASS, FAST));
    for (const at of [7, 30, 40, enc.length - 1]) { // salt · iv · 본문 · 태그
      const t = copy(enc);
      t[at] = t[at]! ^ 0x01;
      expect(code(() => decryptBackup(t, PASS)), `byte ${at}`).toBe('wrong_passphrase_or_tampered');
    }
    const cut = enc.subarray(0, enc.length - 5);
    expect(code(() => decryptBackup(cut, PASS))).toBe('wrong_passphrase_or_tampered');
    // 머리의 강도 숫자를 바꾸면 (AAD) — 범위 밖이면 형식 오류, 범위 안이면 인증 실패
    const p = copy(enc); p[4] = 11;
    expect(code(() => decryptBackup(p, PASS))).toBe('wrong_passphrase_or_tampered');
    const q = copy(enc); q[4] = 40;
    expect(code(() => decryptBackup(q, PASS))).toBe('bad_params');
  });

  it('이 형식이 아닌 파일 · 너무 짧은 비밀문구', () => {
    expect(code(() => decryptBackup(SQL, PASS))).toBe('not_backup');
    expect(code(() => decryptBackup(new Uint8Array(3), PASS))).toBe('not_backup');
    expect(() => encryptBackup(SQL, 'x'.repeat(MIN_PASSPHRASE - 1), FAST)).toThrow('passphrase_too_short');
  });
});
