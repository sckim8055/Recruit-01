// 파일 저장소 (T-19, src/lib/storage.ts): 키 검사(경로 벗어나기 금지), 쓰기(임시 파일 → 이름 바꾸기), 읽기·지우기·목록·커서, 종류(확장자).
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentTypeOfKey, fsFileStore, isSafeKey, isSafePrefix } from '../src/lib/storage';
import { newResumeFileKey } from '../src/lib/resume-files';
import { demoDocKey } from '../src/lib/demo-seed';
import { isSafeKey as importIsSafeKey } from '../scripts/import-from-cloudflare.mjs';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'recruit-store-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const GOOD = [
  'rfiles/0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f', 'vdocs/company/0b7c6a52-4c1e-4d0e-9a51-0e3f1c2d3e4f/1f0e7b1a-2c3d-4e5f-8a9b-0c1d2e3f4a5b.pdf',
  'vdocs/agency/a1/x.png', 'a', 'A.b_c-d',
];
const BAD = [
  '', '/abs', 'C:/x', 'C:\\x', 'a\\b', '../x', 'rfiles/../etc', 'rfiles/..', 'a//b', 'a/', '/', '.hidden', 'rfiles/.tmp-x', 'a/b.', 'CON', 'vdocs/nul.pdf',
  'com1', 'a b', 'a?b', 'a:b', 'ä', 'x'.repeat(201), 'rfiles/%2e%2e',
];

describe('키 검사', () => {
  it('앱이 만드는 키는 받는다', () => {
    for (const k of GOOD) expect(isSafeKey(k), k).toBe(true);
    for (let i = 0; i < 20; i++) expect(isSafeKey(newResumeFileKey())).toBe(true);
    expect(isSafeKey(demoDocKey({ id: 'de300002-0000-4000-8000-000000000001' } as never))).toBe(true);
  });
  it('경로를 벗어나거나 Windows 에서 문제가 되는 키는 거절', () => {
    for (const k of BAD) expect(isSafeKey(k), JSON.stringify(k)).toBe(false);
    expect(isSafeKey(null)).toBe(false);
    expect(isSafeKey(5)).toBe(false);
  });
  it('가져오기 스크립트의 키 검사와 같다', () => {
    for (const k of [...GOOD, ...BAD]) expect(importIsSafeKey(k), JSON.stringify(k)).toBe(isSafeKey(k));
  });
  it('목록 접두어: 비었거나 안전한 키 + /', () => {
    expect([isSafePrefix(''), isSafePrefix(undefined), isSafePrefix('rfiles/'), isSafePrefix('vdocs/company/')]).toEqual([true, true, true, true]);
    expect([isSafePrefix('rfiles'), isSafePrefix('../'), isSafePrefix('/'), isSafePrefix('a\\b/')]).toEqual([false, false, false, false]);
  });
  it('종류는 확장자로 (검증 서류), rfiles/ 는 없음', () => {
    expect([contentTypeOfKey('vdocs/company/c/x.pdf'), contentTypeOfKey('vdocs/company/c/x.JPG'), contentTypeOfKey('vdocs/company/c/x.png'), contentTypeOfKey('rfiles/abc')])
      .toEqual(['application/pdf', 'image/jpeg', 'image/png', undefined]);
  });
});

describe('fsFileStore', () => {
  it('put → get (바이트 그대로) → delete, 없는 키는 null·지워도 오류 아님', async () => {
    const root = tmp();
    const s = fsFileStore(root);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await s.put('rfiles/k1', bytes);
    const got = await s.get('rfiles/k1');
    expect(got && [...got.body]).toEqual([1, 2, 3, 250]);
    expect(got && [...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2, 3, 250]);
    expect(got?.httpMetadata).toEqual({});
    await s.put('vdocs/company/c1/d1.pdf', new TextEncoder().encode('%PDF-1.4').buffer as ArrayBuffer, { httpMetadata: { contentType: 'application/pdf' } });
    expect((await s.get('vdocs/company/c1/d1.pdf'))?.httpMetadata.contentType).toBe('application/pdf');
    expect(existsSync(join(root, 'vdocs', 'company', 'c1', 'd1.pdf'))).toBe(true);
    await s.delete('rfiles/k1');
    expect(await s.get('rfiles/k1')).toBeNull();
    await s.delete(['rfiles/k1', 'rfiles/never']);
    // 덮어쓰기
    await s.put('rfiles/k2', new Uint8Array([1]));
    await s.put('rfiles/k2', new Uint8Array([2, 2]));
    expect([...(await s.get('rfiles/k2'))!.body]).toEqual([2, 2]);
    // 임시 파일이 남지 않는다
    expect(readdirSync(join(root, 'rfiles')).filter((f) => f.startsWith('.tmp-'))).toEqual([]);
  });

  it('잘못된 키는 읽기·쓰기·지우기 모두 예외 (폴더 밖 파일을 건드리지 않는다)', async () => {
    const root = tmp();
    const outside = join(root, '..', `outside-${Date.now()}`);
    writeFileSync(outside, 'secret');
    dirs.push(outside);
    const s = fsFileStore(join(root, 'files'));
    for (const k of ['../' + outside.split('/').pop(), '/etc/passwd', 'C:\\Windows\\win.ini', 'a\\..\\b']) {
      await expect(s.get(k)).rejects.toThrow('invalid key');
      await expect(s.put(k, new Uint8Array([1]))).rejects.toThrow('invalid key');
      await expect(s.delete(k)).rejects.toThrow('invalid key');
    }
    await expect(s.list({ prefix: '../' })).rejects.toThrow();
    await expect(s.list({ prefix: 'rfiles/', cursor: '../x' })).rejects.toThrow();
    expect(existsSync(outside)).toBe(true);
  });

  it('list: 접두어 아래를 이름 순서로, limit 과 커서로 이어 본다, 임시 파일은 빼고 uploaded = 수정 시각', async () => {
    const s = fsFileStore(tmp());
    for (const k of ['rfiles/c', 'rfiles/a', 'rfiles/b', 'vdocs/company/x/1.pdf']) await s.put(k, new Uint8Array([1]));
    const p1 = await s.list({ prefix: 'rfiles/', limit: 2 });
    expect(p1.objects.map((o) => o.key)).toEqual(['rfiles/a', 'rfiles/b']);
    expect(p1.truncated).toBe(true);
    expect(p1.objects[0]!.uploaded).toBeInstanceOf(Date);
    expect(Math.abs(p1.objects[0]!.uploaded.getTime() - Date.now())).toBeLessThan(60_000);
    const p2 = await s.list({ prefix: 'rfiles/', limit: 2, cursor: p1.cursor });
    expect(p2).toMatchObject({ truncated: false, objects: [{ key: 'rfiles/c' }] });
    expect(p2.cursor).toBeUndefined();
    expect((await s.list({ prefix: 'nothing/' })).objects).toEqual([]);
    expect((await s.list({})).objects.map((o) => o.key)).toEqual(['rfiles/a', 'rfiles/b', 'rfiles/c', 'vdocs/company/x/1.pdf']);
  });
});
