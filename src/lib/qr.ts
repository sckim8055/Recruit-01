// QR 코드 만들기 (서버에서 SVG 로 그린다). 관리자 2단계 인증 등록 화면에서 otpauth 주소를 인증 앱으로 스캔할 수 있게 한다.
// 외부 서비스·클라이언트 자바스크립트·의존성 없이 한다 (CLAUDE.md 규칙 7) — 비밀키가 들어 있으므로 바깥 QR 서비스에 보내면 안 된다.
// 범위: 바이트 모드, 오류 정정 수준 M, 버전 1~10 (최대 213바이트). otpauth 주소는 110바이트 안팎이다.
// 검증: test/qr.test.ts (알려진 크기·형식 정보·RS 계산) + 개발 때 실제 디코더로 읽어 확인.

/** 버전별(1~10) 수준 M 의 블록 구성: [블록당 오류 정정 코드워드, [블록 수, 블록당 데이터 코드워드]...] */
const BLOCKS: ReadonlyArray<readonly [number, ...Array<readonly [number, number]>]> = [
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
export const QR_MAX_BYTES = 213;

const dataCodewords = (ver: number): number => {
  const [, ...groups] = BLOCKS[ver - 1]!;
  return groups.reduce((n, [count, size]) => n + count * size, 0);
};
/** 바이트 수 n 을 담을 수 있는 가장 작은 버전. 넘치면 null. */
export function qrVersionFor(n: number): number | null {
  for (let ver = 1; ver <= 10; ver++) {
    const bits = 4 + (ver < 10 ? 8 : 16) + n * 8;
    if (bits <= dataCodewords(ver) * 8) return ver;
  }
  return null;
}

// ── GF(256) (다항식 0x11D) 와 리드-솔로몬
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

/** 데이터 코드워드에 대한 오류 정정 코드워드 (길이 degree). */
export function rsRemainder(data: ArrayLike<number>, degree: number): number[] {
  // 생성 다항식 ∏(x - α^i), 최고차 계수(1)는 빼고 보관
  const gen = new Array<number>(degree).fill(0);
  gen[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      gen[j] = mul(gen[j]!, root);
      if (j + 1 < degree) gen[j] = gen[j]! ^ gen[j + 1]!;
    }
    root = mul(root, 2);
  }
  const rem = new Array<number>(degree).fill(0);
  for (let k = 0; k < data.length; k++) {
    const factor = data[k]! ^ rem.shift()!;
    rem.push(0);
    for (let j = 0; j < degree; j++) rem[j] = rem[j]! ^ mul(gen[j]!, factor);
  }
  return rem;
}

/** 형식 정보 15비트 (수준 M = 00, 마스크 0~7). */
export function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
/** 버전 정보 18비트 (버전 7 이상). */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 마스크 고르기용 벌점 (ISO 18004 의 네 규칙). */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(m[y]!);
  for (let x = 0; x < size; x++) lines.push(m.map((row) => row[x]!));
  for (const line of lines) {
    // 규칙 1: 같은 색이 5칸 이상 이어짐
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    // 규칙 3: 찾기 무늬와 닮은 1:1:3:1:1 (+ 옆에 흰 4칸)
    for (let i = 0; i + 11 <= size; i++) {
      const s = line.slice(i, i + 11).map((b) => (b ? '1' : '0')).join('');
      if (s === '10111010000' || s === '00001011101') score += 40;
    }
  }
  // 규칙 2: 2×2 같은 색
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y]![x];
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  // 규칙 4: 검은 칸 비율이 50% 에서 벗어난 정도
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * 글을 QR 코드 행렬로 (true = 검은 칸). 행렬[y][x]. 너무 길면 null.
 * forceMask 는 테스트용 (없으면 벌점이 가장 낮은 마스크).
 */
export function qrMatrix(text: string, forceMask?: number): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const ver = qrVersionFor(bytes.length);
  if (!ver) return null;
  const size = ver * 4 + 17;
  const total = dataCodewords(ver);

  // ── 데이터 비트열: 모드(0100) + 길이 + 바이트 + 종료 + 채움
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, total * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  // ── 블록으로 나누고 오류 정정 붙여 섞기
  const [ecLen, ...groups] = BLOCKS[ver - 1]!;
  const dataBlocks: number[][] = [];
  let at = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      dataBlocks.push(data.slice(at, at + len));
      at += len;
    }
  }
  const ecBlocks = dataBlocks.map((b) => rsRemainder(b, ecLen));
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]!);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]!);

  // ── 기능 무늬
  const m: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const centers = ALIGN[ver - 1]!;
  const last = centers.length - 1;
  centers.forEach((cy, i) => centers.forEach((cx, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask: number) => {
    const f = formatBits(mask);
    const bit = (i: number) => ((f >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // 자리를 먼저 잡는다
  if (ver >= 7) {
    const v = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const dark = ((v >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // ── 데이터 칸 채우기 (지그재그)
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fn[y]![x]) continue;
        if (k < out.length * 8) m[y]![x] = ((out[k >>> 3]! >>> (7 - (k & 7))) & 1) === 1;
        k++;
      }
    }
  }

  // ── 마스크
  const apply = (mask: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x];
  };
  let best = forceMask ?? 0;
  if (forceMask === undefined) {
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      apply(mask);
      drawFormat(mask);
      const s = penalty(m);
      if (s < bestScore) {
        bestScore = s;
        best = mask;
      }
      apply(mask); // 되돌리기 (XOR)
    }
  }
  apply(best);
  drawFormat(best);
  return m;
}

/**
 * QR 코드의 SVG path 데이터와 한 변의 칸 수(여백 4칸 포함). 화면은 이것으로 <svg> 를 그린다 (views).
 * 글이 너무 길면 null — 그때 화면은 QR 없이 키만 보인다.
 */
export function qrSvgPath(text: string): { d: string; size: number } | null {
  const m = qrMatrix(text);
  if (!m) return null;
  const quiet = 4;
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  }));
  return { d, size: m.length + quiet * 2 };
}
