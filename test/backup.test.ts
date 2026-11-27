// 백업·복구 (T-19, scripts/backup.mjs · restore.mjs · lib/backup-pack.mjs): 묶기/풀기, 암호화 왕복, 평문이 남지 않음, 오래된 자동 백업 정리.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSafeEntryName, pack, unpack } from '../scripts/lib/backup-pack.mjs';
import { createBackup, listFiles, pruneBackups } from '../scripts/backup.mjs';
import { RESTORE_STEPS, restoreTo } from '../scripts/restore.mjs';
import { decryptBackup } from '../scripts/lib/backup-crypto.mjs';
import { pgEnvOf } from '../scripts/lib/pg-cli.mjs';

const FAST = { logN: 10, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'recruit-bk-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const latin1 = (a: Uint8Array) => Buffer.from(a).toString('latin1');

describe('묶음 형식', () => {
  it('왕복 · 이름 검사 · 손상 감지', () => {
    const e = [{ name: 'db.dump', data: new Uint8Array([1, 2, 3]) }, { name: 'files/rfiles/abc', data: new Uint8Array(0) }];
    expect(unpack(pack(e)).map((x) => [x.name, [...x.data]])).toEqual([['db.dump', [1, 2, 3]], ['files/rfiles/abc', []]]);
    for (const bad of ['../x', '/x', 'a\\b', 'C:x', 'files/../x', '', 'a//b']) expect(isSafeEntryName(bad), bad).toBe(false);
    expect(() => pack([{ name: '../x', data: new Uint8Array(1) }])).toThrow();
    const p = pack(e);
    expect(() => unpack(p.subarray(0, p.length - 1))).toThrow();
    expect(() => unpack(new TextEncoder().encode('nope'))).toThrow();
  });
});

describe('백업 만들기 → 풀기', () => {
  function setup() {
    const root = tmp();
    const filesDir = join(root, 'files'), backupDir = join(root, 'backups');
    mkdirSync(join(filesDir, 'rfiles'), { recursive: true });
    mkdirSync(join(filesDir, 'vdocs', 'company', 'c1'), { recursive: true });
    writeFileSync(join(filesDir, 'rfiles', 'k1'), Buffer.from('RF1-ciphertext-bytes'));
    writeFileSync(join(filesDir, 'vdocs', 'company', 'c1', 'd.pdf'), Buffer.from('%PDF-1.4 fake-doc fake.person@example.test'));
    writeFileSync(join(filesDir, 'rfiles', '.tmp-abc'), 'partial'); // 쓰는 중인 임시 파일은 넣지 않는다
    const dump = async () => Buffer.from('PGDMP fake dump with fake.person@example.test');
    return { root, filesDir, backupDir, dump };
  }

  it('DB 덤프 + 첨부파일을 암호화해 recruit-<날짜>.enc 하나로, 평문(이메일)은 파일에도 폴더에도 남지 않는다', async () => {
    const s = setup();
    const r = await createBackup({ ...s, passphrase: PASS, date: new Date(2026, 10, 27, 3, 0), params: FAST });
    expect(r.file.endsWith('recruit-20261127-0300.enc')).toBe(true);
    expect(r.files).toBe(2);
    expect(readdirSync(s.backupDir)).toEqual(['recruit-20261127-0300.enc']); // 임시 파일 없음
    const bytes = readFileSync(r.file);
    expect(latin1(bytes)).not.toContain('fake.person@example.test');
    expect(latin1(bytes)).not.toContain('PGDMP');
    // 같은 분에 다시 만들면 덮어쓰지 않는다
    await expect(createBackup({ ...s, passphrase: PASS, date: new Date(2026, 10, 27, 3, 0), params: FAST })).rejects.toThrow('이미 있습니다');
    // 풀기: db.dump · files/… · RESTORE-STEPS.txt
    const out = join(s.root, 'restored');
    expect(restoreTo(bytes, PASS, out)).toEqual({ files: 2, dbBytes: 45 });
    expect(readFileSync(join(out, 'db.dump'), 'utf8')).toBe('PGDMP fake dump with fake.person@example.test');
    expect(readFileSync(join(out, 'files', 'rfiles', 'k1'), 'utf8')).toBe('RF1-ciphertext-bytes');
    expect(existsSync(join(out, 'files', 'vdocs', 'company', 'c1', 'd.pdf'))).toBe(true);
    expect(existsSync(join(out, 'files', 'rfiles', '.tmp-abc'))).toBe(false);
    expect(readFileSync(join(out, 'RESTORE-STEPS.txt'), 'utf8')).toContain('pg_restore');
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))).toMatchObject({ v: 1, files: 2, db_bytes: 45 });
    expect(() => restoreTo(bytes, PASS, out)).toThrow('이미 있습니다');
    expect(() => restoreTo(bytes, 'wrong passphrase 123', join(s.root, 'r2'))).toThrow();
    expect(existsSync(join(s.root, 'r2'))).toBe(false); // 틀린 비밀문구면 아무것도 쓰지 않는다
  });

  it('짧은 비밀문구·빈 덤프는 거절, 덤프 실패면 파일이 생기지 않는다', async () => {
    const s = setup();
    await expect(createBackup({ ...s, passphrase: 'short', params: FAST })).rejects.toThrow();
    await expect(createBackup({ ...s, dump: async () => Buffer.alloc(0), passphrase: PASS, params: FAST })).rejects.toThrow('비어');
    await expect(createBackup({ ...s, dump: async () => { throw new Error('pg_dump 가 실패했습니다'); }, passphrase: PASS, params: FAST })).rejects.toThrow('pg_dump');
    expect(existsSync(s.backupDir) ? readdirSync(s.backupDir) : []).toEqual([]);
  });

  it('자동 백업 정리: 최근 n 개만 남긴다 (다른 파일은 건드리지 않는다)', () => {
    const d = tmp();
    for (const f of ['recruit-20261101-0300.enc', 'recruit-20261102-0300.enc', 'recruit-20261103-0300.enc', 'notes.txt', 'production-20261101-0900.sql.enc']) writeFileSync(join(d, f), 'x');
    expect(pruneBackups(d, 2)).toBe(1);
    expect(readdirSync(d).sort()).toEqual(['notes.txt', 'production-20261101-0900.sql.enc', 'recruit-20261102-0300.enc', 'recruit-20261103-0300.enc']);
  });

  it('파일 목록 · pg_dump 에 넘기는 환경 변수(비밀번호는 명령줄이 아니라 PGPASSWORD)', () => {
    expect(listFiles(join(tmp(), 'nope'))).toEqual([]);
    expect(pgEnvOf('postgres://recruit:p%40ss@localhost:5433/recruit')).toEqual({ PGHOST: 'localhost', PGPORT: '5433', PGUSER: 'recruit', PGPASSWORD: 'p@ss', PGDATABASE: 'recruit' });
    expect(RESTORE_STEPS).toContain('TEMPLATE template0');
  });

  it('예전 형식(.sql.enc)도 같은 암호화로 풀린다', async () => {
    const { encryptBackup } = await import('../scripts/lib/backup-crypto.mjs');
    const enc = encryptBackup(Buffer.from('INSERT INTO users …'), PASS, FAST);
    expect(Buffer.from(decryptBackup(enc, PASS)).toString()).toBe('INSERT INTO users …');
  });
});
