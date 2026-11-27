// 파일 저장소 (T-19). Cloudflare R2 대신 PC 의 폴더(DATA_DIR/files)에 둔다. 앱이 쓰는 것은 R2 와 같은 이름의 작은 부분뿐이다:
//   put(key, bytes, { httpMetadata: { contentType } }) · get(key) → { body, arrayBuffer(), httpMetadata } | null · delete(key | key[]) · list({ prefix, limit, cursor })
// 나중에 S3 호환 저장소를 쓰려면 이 FileStore 를 같은 모양으로 하나 더 만들면 된다 (지금은 만들지 않는다).
//
// 원칙
// - 파일 내용은 바꾸지 않는다: 이력서·지원서 첨부는 호출부(lib/resume-files.ts)가 ENC_KEY 로 암호화한 바이트(키를 AAD 로)를 넘기고, 여기서는 그대로 쓴다.
//   검증 서류(vdocs/)는 예전처럼 평문 그대로다 (lib/files.ts — R2 때와 같다).
// - 키는 앱이 만드는 모양만 받는다: 'rfiles/<uuid>' · 'vdocs/<company|agency>/<id>/<uuid>.<pdf|jpg|png>' 처럼 '/' 로 나눈 조각마다
//   영문·숫자·'-'·'_'·'.' 만, 첫 글자는 영문·숫자, '..'·빈 조각·절대 경로·드라이브 문자(C:)·역슬래시·Windows 예약 이름(CON, NUL …) 금지, 전체 200자 이하.
//   그 밖의 키는 예외 (경로를 벗어나 다른 파일을 읽거나 쓰지 못하게).
// - 쓰기는 같은 폴더의 임시 파일에 쓴 뒤 이름 바꾸기(rename) — 중간에 끊겨도 반쯤 쓴 파일이 그 키로 보이지 않는다.
// - 종류(contentType)는 따로 저장하지 않는다. 읽을 때 확장자로 정한다 (.pdf·.jpg·.png — 검증 서류). 확장자가 없으면(rfiles/) 없음
//   = R2 에서도 rfiles/ 는 종류를 남기지 않았다.
// - uploaded(목록) = 파일의 수정 시각.
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface StoredObject {
  key: string;
  size: number;
  body: Uint8Array;
  httpMetadata: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ListedObject { key: string; size: number; uploaded: Date }
export interface ListResult { objects: ListedObject[]; truncated: boolean; cursor?: string }

export interface FileStore {
  put(key: string, value: Uint8Array | ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** 없는 키를 지워도 오류가 아니다 (R2 와 같다). */
  delete(key: string | string[]): Promise<void>;
  /** prefix 아래의 키를 이름 순서로 limit 개. cursor = 앞 쪽의 마지막 키 (그다음부터). */
  list(opts: { prefix?: string; limit?: number; cursor?: string }): Promise<ListResult>;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
export const MAX_KEY_LENGTH = 200;

/** 키가 앱이 만드는 모양인가. 순수 함수 (test/storage.test.ts). */
export function isSafeKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) return false;
  const parts = key.split('/');
  return parts.every((p) => SEGMENT.test(p) && !p.includes('..') && !p.endsWith('.') && !RESERVED.test(p));
}

/** list 의 prefix: 빈 값이거나 안전한 키 + '/' 로 끝나는 모양 (예: 'rfiles/'). */
export function isSafePrefix(prefix: unknown): prefix is string {
  if (prefix === undefined || prefix === '') return true;
  if (typeof prefix !== 'string' || !prefix.endsWith('/')) return false;
  return isSafeKey(prefix.slice(0, -1));
}

const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' };
export const contentTypeOfKey = (key: string): string | undefined => {
  const last = key.slice(key.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? MIME_BY_EXT[last.slice(dot + 1).toLowerCase()] : undefined;
};

const TMP_PREFIX = '.tmp-';

/** 폴더 저장소. root = DATA_DIR/files (절대 경로). */
export function fsFileStore(rootDir: string): FileStore {
  const root = resolve(rootDir);
  const pathOf = (key: string): string => {
    if (!isSafeKey(key)) throw new Error('storage: invalid key');
    const p = resolve(root, ...key.split('/'));
    if (!p.startsWith(root + sep)) throw new Error('storage: invalid key'); // isSafeKey 가 이미 막지만 한 번 더
    return p;
  };

  async function walk(dir: string, rel: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return;
      throw e;
    }
    for (const ent of entries) {
      if (ent.name.startsWith(TMP_PREFIX)) continue;
      const k = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(join(dir, ent.name), k, out);
      else if (ent.isFile() && isSafeKey(k)) out.push(k);
    }
  }

  return {
    async put(key, value) {
      const p = pathOf(key);
      const dir = p.slice(0, p.lastIndexOf(sep));
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${TMP_PREFIX}${randomBytes(8).toString('hex')}`);
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await rename(tmp, p); // Windows 에서도 같은 볼륨 안의 rename 은 대상이 있으면 바꿔 쓴다
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },

    async get(key) {
      const p = pathOf(key);
      let buf: Buffer;
      try {
        buf = await readFile(p);
      } catch (e) {
        if ((e as { code?: string }).code === 'ENOENT') return null;
        throw e;
      }
      const body = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      const ct = contentTypeOfKey(key);
      return {
        key, size: body.byteLength, body, httpMetadata: ct ? { contentType: ct } : {},
        arrayBuffer: async () => body.slice().buffer as ArrayBuffer,
      };
    },

    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) {
        try {
          await unlink(pathOf(k));
        } catch (e) {
          if ((e as { code?: string }).code !== 'ENOENT') throw e;
        }
      }
    },

    async list(opts) {
      const prefix = opts.prefix ?? '';
      if (!isSafePrefix(prefix)) throw new Error('storage: invalid prefix');
      if (opts.cursor !== undefined && !isSafeKey(opts.cursor)) throw new Error('storage: invalid cursor');
      const limit = Math.max(1, Math.min(opts.limit ?? 1000, 1000));
      const keys: string[] = [];
      await walk(prefix ? join(root, ...prefix.slice(0, -1).split('/')) : root, prefix.slice(0, -1), keys);
      keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const after = opts.cursor;
      const rest = after ? keys.filter((k) => k > after) : keys;
      const page = rest.slice(0, limit);
      const objects: ListedObject[] = [];
      for (const k of page) {
        try {
          const s = await stat(pathOf(k));
          objects.push({ key: k, size: s.size, uploaded: s.mtime });
        } catch {
          /* 그사이 지워졌다 */
        }
      }
      const truncated = rest.length > page.length;
      return truncated ? { objects, truncated, cursor: page[page.length - 1] } : { objects, truncated };
    },
  };
}
