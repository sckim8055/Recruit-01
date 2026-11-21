// 백업 파일 암호화 (T-13). AES-256-GCM, 키 = scrypt(비밀문구, 무작위 salt). Node 내장 crypto 만 쓴다.
//
// 파일 형식 (모두 바이트):
//   "RBK1" (4) | logN (1) | r (1) | p (1) | salt (16) | iv (12) | 암호문 … | 인증 태그 (16)
// 머리(앞 35바이트)를 추가 인증 데이터(AAD)로 넣는다 — 머리의 숫자를 바꿔도 풀리지 않는다.
// 비밀문구가 틀리거나 파일이 한 바이트라도 바뀌면 GCM 태그 검사에서 실패한다 (어느 쪽인지 구별할 수 없다).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const MAGIC = Buffer.from('RBK1', 'ascii');
/** scrypt 강도: N = 2^17, r = 8, p = 1 (메모리 약 128MB, 일반 PC 에서 1초 안팎). */
export const DEFAULT_PARAMS = { logN: 17, r: 8, p: 1 };
const SALT = 16;
const IV = 12;
const TAG = 16;
const HEAD = MAGIC.length + 3 + SALT + IV;
/** 비밀문구 최소 길이. */
export const MIN_PASSPHRASE = 12;

export class BackupDecryptError extends Error {}

function deriveKey(passphrase, salt, { logN, r, p }) {
  if (logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 4) throw new BackupDecryptError('bad_params');
  const N = 2 ** logN;
  return scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 });
}

/** 평문 바이트 → 암호화된 파일 바이트. params 는 테스트에서 낮출 수 있다. */
export function encryptBackup(plain, passphrase, params = DEFAULT_PARAMS) {
  if (String(passphrase).length < MIN_PASSPHRASE) throw new Error('passphrase_too_short');
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const head = Buffer.concat([MAGIC, Buffer.from([params.logN, params.r, params.p]), salt, iv]);
  const key = deriveKey(passphrase, salt, params);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(head);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([head, body, c.getAuthTag()]);
}

/** 암호화된 파일 바이트 → 평문. 형식이 다르면 'not_backup', 비밀문구가 틀리거나 바뀐 파일이면 'wrong_passphrase_or_tampered'. */
export function decryptBackup(file, passphrase) {
  const buf = Buffer.from(file);
  if (buf.length < HEAD + TAG || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupDecryptError('not_backup');
  const params = { logN: buf[4], r: buf[5], p: buf[6] };
  const salt = buf.subarray(7, 7 + SALT);
  const iv = buf.subarray(7 + SALT, HEAD);
  const head = buf.subarray(0, HEAD);
  const body = buf.subarray(HEAD, buf.length - TAG);
  const tag = buf.subarray(buf.length - TAG);
  const key = deriveKey(passphrase, salt, params);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(head);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new BackupDecryptError('wrong_passphrase_or_tampered');
  }
}
