import { describe, expect, it } from 'vitest';
import { formatBits, qrMatrix, qrSvgPath, qrVersionFor, rsRemainder, versionBits, QR_MAX_BYTES } from '../src/lib/qr';
import { otpauthUri } from '../src/lib/totp';

// QR 코드 (관리자 2단계 인증 등록 화면). 실제 디코더(OpenCV)로 버전 1~10 을 읽어 확인한 구현의 값을 고정한다.
describe('qr', () => {
  it('바이트 수에 맞는 버전을 고른다 (수준 M)', () => {
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(qrVersionFor(106)).toBe(6);
    expect(qrVersionFor(107)).toBe(7);
    expect(qrVersionFor(180)).toBe(9);
    expect(qrVersionFor(181)).toBe(10);
    expect(qrVersionFor(QR_MAX_BYTES)).toBe(10);
    expect(qrVersionFor(QR_MAX_BYTES + 1)).toBeNull();
  });

  it('형식·버전 정보는 표준의 알려진 값과 같다', () => {
    expect(formatBits(0)).toBe(0b101010000010010); // 수준 M, 마스크 0
    expect(formatBits(5)).toBe(0b100000011001110); // 수준 M, 마스크 5
    expect(versionBits(7)).toBe(0x07c94);
    expect(versionBits(10)).toBe(0x0a4d3);
  });

  it('리드-솔로몬: 표준 예제(1-M, "01234567")의 오류 정정 코드워드', () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(rsRemainder(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });

  it('행렬: 크기, 찾기 무늬, 타이밍 무늬, 고정 검은 칸', () => {
    const m = qrMatrix('hi')!;
    expect(m.length).toBe(21);
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
    const at = (x0: number, y0: number) => finder.map((_, y) => m[y0 + y]!.slice(x0, x0 + 7).map((b) => (b ? '1' : '0')).join(''));
    expect(at(0, 0)).toEqual(finder);
    expect(at(14, 0)).toEqual(finder);
    expect(at(0, 14)).toEqual(finder);
    for (let i = 8; i < 13; i++) expect(m[6]![i]).toBe(i % 2 === 0);
    expect(m[13]![8]).toBe(true);
  });

  it('관리자 등록 주소(긴 이메일 포함)가 들어가고, 같은 입력은 같은 그림이다', () => {
    const uri = otpauthUri('Recruit', 'very.long.fake.admin.address@subdomain.example.test', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    const a = qrSvgPath(uri)!;
    expect(a).not.toBeNull();
    expect(a.size).toBeGreaterThanOrEqual(45 + 8);
    expect(a.d.startsWith('M')).toBe(true);
    expect(qrSvgPath(uri)).toEqual(a);
    expect(qrSvgPath('x'.repeat(300))).toBeNull();
  });
});
