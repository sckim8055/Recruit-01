// 백업 묶음 형식 (T-19). DB 덤프(pg_dump -Fc) + 첨부파일 폴더를 한 덩어리 바이트로 묶고 푼다. 순수 함수 — test/backup.test.ts.
// 묶은 바이트는 그대로 저장하지 않고 scripts/lib/backup-crypto.mjs(AES-256-GCM + scrypt 비밀문구)로 암호화한다.
//
// 형식: "RPK1" | 항목 수(u32) | 항목마다 [이름 길이(u16) | 이름(UTF-8) | 크기(u64) | 바이트]
//   이름: "db.dump" (pg_dump 출력) · "manifest.json" (만든 시각·개수, 개인정보 없음) · "files/<저장소 키>" (rfiles/… 는 이미 ENC_KEY 로 암호화된 바이트)
// 이름은 풀 때 다시 검사한다 ('..'·절대 경로·역슬래시 금지) — 풀어서 쓸 폴더 밖으로 나가지 않게.

const MAGIC = Buffer.from('RPK1', 'ascii');

export const isSafeEntryName = (name) =>
  typeof name === 'string' && name.length > 0 && name.length <= 300 && !name.startsWith('/') && !name.includes('\\') && !/^[A-Za-z]:/.test(name)
  && name.split('/').every((p) => p && p !== '.' && p !== '..' && /^[A-Za-z0-9._-]+$/.test(p));

/** entries: [{ name, data: Uint8Array }] → Buffer */
export function pack(entries) {
  const parts = [MAGIC];
  const n = Buffer.alloc(4);
  n.writeUInt32BE(entries.length);
  parts.push(n);
  for (const e of entries) {
    if (!isSafeEntryName(e.name)) throw new Error(`backup: bad entry name`);
    const name = Buffer.from(e.name, 'utf8');
    const h = Buffer.alloc(2 + name.length + 8);
    h.writeUInt16BE(name.length, 0);
    name.copy(h, 2);
    h.writeBigUInt64BE(BigInt(e.data.length), 2 + name.length);
    parts.push(h, Buffer.from(e.data.buffer, e.data.byteOffset, e.data.byteLength));
  }
  return Buffer.concat(parts);
}

/** Buffer → [{ name, data }]. 형식이 다르면 예외. */
export function unpack(buf) {
  const b = Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 4).equals(MAGIC)) throw new Error('backup: not a recruit backup pack');
  const count = b.readUInt32BE(4);
  let off = 8;
  const out = [];
  for (let i = 0; i < count; i++) {
    const len = b.readUInt16BE(off);
    const name = b.subarray(off + 2, off + 2 + len).toString('utf8');
    const size = Number(b.readBigUInt64BE(off + 2 + len));
    off += 2 + len + 8;
    if (!isSafeEntryName(name) || off + size > b.length) throw new Error('backup: damaged pack');
    out.push({ name, data: b.subarray(off, off + size) });
    off += size;
  }
  if (off !== b.length) throw new Error('backup: damaged pack');
  return out;
}

/** 백업 파일 이름: recruit-<yyyymmdd-hhmm>.enc (PC 의 현지 시각). */
export function backupFileName(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `recruit-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.enc`;
}
