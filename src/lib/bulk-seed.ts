// 대량 테스트 데이터 (T-21, 테스트 서버·로컬 개발 전용 — 운영(production)에서는 실행하지 않는다).
// 운영자 요청: 목록·필터·페이지·지원자 화면·관리자 화면을 공고 약 500건 규모로 시험해 볼 수 있게, 그럴듯하지만 **모두 지어낸** 데이터를 넣는다 (CLAUDE.md 규칙 10).
// 명령: npm run seed:bulk [-- --jobs N --companies N --seekers N --applications N] · [-- --remove] · [-- --dry-run] (src/bulk-seed-cli.ts)
//
// 안전장치 (완화하지 않는다):
//   - APP_ENV = production 이면 아무것도 읽거나 쓰지 않고 끝난다 (runBulkCommand · CLI 둘 다 확인).
//   - 만드는 행의 id 는 모두 `b5eed00<종류>-0000-4000-8000-<번호>` 이고(bulkId), 지우기는 그 모양의 행과 그것을 가리키는 행만 지운다 (db/bulk-seed.deleteBulkRows).
//     시연 데이터(de30000…)·운영자가 만든 행은 건드리지 않는다. 파일 키도 같은 모양이다 (rfiles/b5eed009-…, rfiles/b5eed00a-…, vdocs/company/b5eed002-…/…).
//   - 메일 주소는 모두 `@bulk.demo.example` — lib/demo.isDemoAddress 가 참이라 lib/email.sendMail 이 실제로 보내지 않는다. 이 작업 자체는 메일 함수를 부르지 않는다.
//   - 관리자 계정·2단계 인증·조건 알림은 만들지 않는다. 기능 플래그는 읽기만 한다 (규칙 9).
// 규칙 함수를 건너뛰지 않는다 (lib/demo-seed.ts 와 같은 방식):
//   - 기업 검증: rules.verifyBlocks 가 빈 배열일 때만 verified (서류 행 + 체크섬이 맞는 가짜 사업자번호)
//   - 게재: rules.publishBlocks 가 빈 배열일 때만 db/jobs.publishJob (규칙 2). 기술유출 필터에 걸리는 공고는 검토 대기 초안으로 남는다
//   - 지원: lib/application.applyBlocks 가 빈 배열일 때만 db/applications.insertApplication (공개 조건·중복을 문장 안에서 다시 확인, 국외 이전 동의 행 포함)
//   - 지원 상태: 이벤트마다 rules.nextStatus 로 계산해 앱의 이벤트 함수(db/applicants.markViewed·recordMailEvent, db/applications.withdrawApplication)로만 바꾼다 (규칙 3)
//     — 면접 요청·불합격 이벤트는 메일 없이 이벤트만 남긴다 (테스트 데이터라 보낼 사람이 없다)
//   - 열람 이벤트를 낸 담당자는 authz.canViewApplication 이 허용한 사람이고, 열람 기록(access_log)을 함께 남긴다 (규칙 4)
//   - 이력서·지원서는 sealResume 암호문, 첨부파일은 resume-files.encryptFile(키를 AAD 로) 암호문만 저장한다 (규칙 5)
// 같은 조건으로 다시 실행하면 아무것도 바꾸지 않는다. 조건이 다르거나 중간에 끊긴 흔적이 있으면 대량 데이터만 지우고 다시 만든다.
// 출력은 개수뿐이다 (이름·이메일·이력서 내용은 콘솔에 쓰지 않는다).
import { flagsOf, type Env, type Flags } from '../env';
import { applyBlocks, buildSnapshot, consentAt, consentNeed, crossBorderVersion, WITHDRAWABLE, type ConsentNeed } from './application';
import { INTERVIEW_MAIL_MAX } from './applicant-mail';
import { canViewApplication, type Actor } from './authz';
import { ENTRY_STAGES, ownerIsHq } from './company';
import { requiredConsents } from './consent';
import { importEncKey, sha256Hex } from './crypto';
import { DEMO_MAIL_DOMAIN } from './demo';
import { demoDocPdf } from './demo-seed';
import { flagText, kstDate, parseKstDate, publishInputOf } from './jobs';
import { buildOptionSet, type OptionKind, type OptionSet } from './options';
import { isPubliclyVisible } from './public-jobs';
import { encryptFile } from './resume-files';
import { resumeReadyToApply, sealResume, type ResumeBody, type ResumeLang } from './resume';
import {
  CHINA_STUDY, CHINA_WORK, CITY, CN_LINE, COMPANIES, EDU, HSK, IT_FAMILIES, LEVEL_YEARS, NEWGRAD_REQ, OTHER_FAMILIES, PERKS, PERK_CN_STYLE, PERK_IT, REPORT_HQ, REPORT_HQ_IT,
  REPORT_KR, SECTOR, SELF, SELF_BILINGUAL, STAGE_LINE, STARTUP_REQ, TRAVEL, type CnLevel, type CompanySpec, type Family, type Level, type P,
} from './bulk-content';
import { DAY, type RetentionSettings } from './retention';
import { loadRetention } from './retention-setting';
import { isValidBizNo, nextStatus, parseOperatorDomains, publishBlocks, techLeakFlag, verifyBlocks, type AppStatus } from './rules';
import type { FileStore } from './storage';
import {
  countBulk, deleteBulkRows, insertBulkAccessLogs, insertBulkBase, insertBulkJobs, insertBulkResumes, listBulkFileKeys, listBulkUserEmails,
  setBulkClosedDeadlines, writeBulkStamp, type BulkAccessRow, type BulkBaseRows, type BulkCompanyRow, type BulkCounts, type BulkDocRow, type BulkJobRow,
  type BulkLike, type BulkMemberRow, type BulkResumeRow, type BulkUserRow,
} from '../db/bulk-seed';
import { insertApplication, withdrawApplication } from '../db/applications';
import { markViewed, recordMailEvent } from '../db/applicants';
import { blockJob, closeJob, publishJob } from '../db/jobs';
import { listOptions } from '../db/options';
import { getSetting } from '../db/settings';

// ── 표시 (id·주소·기록)

export const BULK_ID_PREFIX = 'b5eed00';
/** 종류: 1 회원 · 2 기업 · 3 공고 · 4 이력서 · 5 지원 · 6 검증 서류 · 7 동의 · 8 열람 기록 · 9 이력서 첨부 파일 · a 지원서 첨부 파일. */
export type BulkKind = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export const bulkId = (kind: BulkKind, n: number): string =>
  `${BULK_ID_PREFIX}${kind.toString(16)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BULK_ID_RE = /^b5eed00[1-9a]-0000-4000-8000-\d{12}$/;
export const isBulkId = (id: string): boolean => BULK_ID_RE.test(id);
const likeOf = (kind: BulkKind) => `${BULK_ID_PREFIX}${kind.toString(16)}-0000-4000-8000-%`;
export const BULK_LIKE: BulkLike = {
  user: likeOf(1), company: likeOf(2), job: likeOf(3), resume: likeOf(4), application: likeOf(5), doc: likeOf(6), consent: likeOf(7), access: likeOf(8),
};
/** 대량 데이터의 메일 도메인. `demo.example` 의 하위 도메인 — 실제 메일함이 없고(RFC 2606) lib/email.ts 가 보내지 않는다. */
export const BULK_MAIL_DOMAIN = `bulk.${DEMO_MAIL_DOMAIN}`;
export const isBulkAddress = (email: string): boolean => email.trim().toLowerCase().endsWith(`@${BULK_MAIL_DOMAIN}`);
export const resumeFileKey = (n: number): string => `rfiles/${bulkId(9, n)}`;
export const applicationFileKey = (n: number): string => `rfiles/${bulkId(10, n)}`;
export const isBulkFileKey = (key: string): boolean => {
  const parts = key.split('/');
  if (parts[0] === 'rfiles') return parts.length === 2 && isBulkId(parts[1]!);
  return parts[0] === 'vdocs' && parts[1] === 'company' && parts.length === 4 && isBulkId(parts[2]!);
};
/** site_settings 키. 값: {"v", "params", "at"}. 다 넣은 뒤에만 쓴다 (없는데 대량 행이 있으면 = 중간에 끊긴 것). */
export const BULK_STAMP_KEY = 'bulk.seed';
/** 만드는 내용이나 방법을 바꾸면 올린다 — 다음 실행 때 지우고 다시 만든다. */
export const BULK_SEED_VERSION = 2; // 2 = T-22 시나리오형 내용 + 이력서 작성 언어

// ── 명령 인자

export interface BulkParams { jobs: number; companies: number; seekers: number; applications: number }
export const DEFAULT_BULK_PARAMS: Readonly<BulkParams> = Object.freeze({ jobs: 500, companies: 60, seekers: 300, applications: 1200 });
/** 받는 범위 (실수로 아주 큰 수를 넣어 PC 가 멈추지 않게). */
export const BULK_LIMITS: Readonly<Record<keyof BulkParams, readonly [number, number]>> = Object.freeze({
  jobs: [1, 5000], companies: [1, 500], seekers: [1, 5000], applications: [0, 20000],
});

export type BulkArgs =
  | { ok: true; mode: 'create' | 'remove'; dryRun: boolean; params: BulkParams }
  | { ok: false; message: string };

export const BULK_USAGE = [
  '사용법:',
  '  npm run seed:bulk                         기본 개수로 만들기 (공고 500 · 기업 60 · 구직자 300 · 지원 1200)',
  '  npm run seed:bulk -- --jobs 500 --companies 60 --seekers 300 --applications 1200',
  '  npm run seed:bulk -- --remove             대량 테스트 데이터만 지우기',
  '  npm run seed:bulk -- --dry-run            무엇을 만들지(지울지) 개수만 보기',
].join('\n');

export function parseBulkArgs(argv: readonly string[]): BulkArgs {
  const params: BulkParams = { ...DEFAULT_BULK_PARAMS };
  let remove = false, dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--remove') { remove = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    const m = /^--(jobs|companies|seekers|applications)(?:=(.*))?$/.exec(a);
    if (!m) return { ok: false, message: `알 수 없는 인자입니다: ${a}\n${BULK_USAGE}` };
    const key = m[1] as keyof BulkParams;
    const raw = m[2] ?? argv[++i];
    const [lo, hi] = BULK_LIMITS[key];
    if (raw === undefined || !/^\d{1,6}$/.test(raw) || Number(raw) < lo || Number(raw) > hi) {
      return { ok: false, message: `--${key} 에는 ${lo}~${hi} 사이의 숫자를 넣으세요.` };
    }
    params[key] = Number(raw);
  }
  if (remove && argv.some((a) => /^--(jobs|companies|seekers|applications)/.test(a))) {
    return { ok: false, message: '--remove 에는 개수를 함께 쓰지 않습니다.' };
  }
  return { ok: true, mode: remove ? 'remove' : 'create', dryRun, params };
}

// ── 결정적 난수 (같은 조건이면 같은 행)

export const BULK_RANDOM_SEED = 20261128;

/** mulberry32. 0 ≤ 값 < 1. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng { (): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean; shuffle<T>(xs: T[]): T[] }
function rngOf(seed: number): Rng {
  const r = makeRng(seed) as Rng;
  r.int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  r.pick = (xs) => xs[Math.floor(r() * xs.length)]!;
  r.chance = (p) => r() < p;
  r.shuffle = (xs) => { for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!]; } return xs; };
  return r;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const lines = (...s: string[]) => s.join('\n');

// ── 지어낸 이름·글의 재료 (실제 기업·사람이 아니다 — 모든 기업·구직자 이름에 "(가상)" 이 붙는다)
// T-22: 기업·직무·이력서 글은 lib/bulk-content.ts 의 표 (한국에 진출한 중국 기업이 한국 직원을 뽑는 장면). 여기는 이름 재료와 조합 방법만.

const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권'];
const GIVEN_A = ['서', '민', '지', '현', '도', '하', '예', '시', '유', '채', '수', '은', '태', '준', '우'];
const GIVEN_B = ['윤', '준', '아', '연', '원', '호', '린', '빈', '율', '희', '진', '솔'];

/** 기술유출 필터(rules.techLeakFlag)에 일부러 걸리는 예시. 자동 게재되지 않고 관리자 검토 대기로 남는다. */
const TECH_LEAK: Readonly<{ title: P; duty: P }> = {
  title: ['电池工艺工程师（研发）', '배터리 공정 엔지니어 (연구개발)'],
  duty: ['负责电池工艺研发与验证', '배터리 공정 연구개발과 검증을 맡습니다'],
};

/** IT 직무 비율 (운영자 요청: 공고의 절반 이상이 IT — role_category 'it'). 업계·단계에 맞는 IT 묶음이 없는 기업은 다른 직무로 간다. */
export const BULK_IT_SHARE = 0.6;
/** 구직자 중 IT 경력자 비율. */
export const BULK_IT_SEEKER_SHARE = 0.55;

const fill = (s: string, v: { y?: number; city?: string }): string =>
  s.replaceAll('{y}', String(v.y ?? '')).replaceAll('{city}', v.city ?? '');
/** 중국어 목록: "1、…；" 마지막은 "。". 한국어: "1. …". 번호 개수는 양쪽이 같다 (digitDiff). */
const numZh = (xs: readonly string[]) => xs.map((x, i) => `${i + 1}、${x}${i === xs.length - 1 ? '。' : '；'}`);
const numKo = (xs: readonly string[]) => xs.map((x, i) => `${i + 1}. ${x}`);
/** 리드 표시: 괄호가 있으면 괄호 안에 더한다 ("…（韩国站，团队负责人）" / "… (한국 서비스, 리드)"). */
const leadZh = (t: string) => (t.endsWith('）') ? `${t.slice(0, -1)}，团队负责人）` : `${t}（团队负责人）`);
const leadKo = (t: string) => (t.endsWith(')') ? `${t.slice(0, -1)}, 리드)` : `${t} (리드)`);
const SENIOR_TITLE = /经理|主管|负责人|顾问|总经理/;

// ── 계획 (DB 접근 없음, 결정적)

export interface BulkPlanCtx {
  now: number;
  encKey: CryptoKey;
  flags: Flags;
  appEnv: 'dev' | 'test';
  registrationNo: string;
  operatorDomains: string[];
  retention: RetentionSettings;
  options: OptionSet;
}

type JobWant = 'open' | 'closed' | 'blocked' | 'draft' | 'review' | 'tech';

export interface PlannedJob {
  row: BulkJobRow;
  want: JobWant;
  /** publishBlocks 가 빈 배열이면 게재 시각, 아니면 null (초안으로 남는다). */
  publishAt: number | null;
  /** want = closed: 지난 마감일 (마감은 지원을 넣은 뒤). */
  closeAt: number | null;
  companyVerified: boolean;
  members: BulkMemberRow[];
  need: ConsentNeed;
}

export interface PlannedEvent { event: 'viewed' | 'interview_mail' | 'reject_mail' | 'withdrawn'; actorId: string; at: number }

export interface PlannedApplication {
  id: string; jobId: string; seekerId: string; resumeId: string; resumeLang: ResumeLang; snapshot: string; fileKey: string | null; filePlain: Uint8Array | null;
  consentAt: number | null; consentVersion: string; ts: number; keepDays: number; events: PlannedEvent[];
}

export interface BulkPlan {
  base: BulkBaseRows;
  docFiles: Array<{ key: string; bytes: Uint8Array }>;
  jobs: PlannedJob[];
  resumes: BulkResumeRow[];
  resumeFiles: Array<{ key: string; plain: Uint8Array }>;
  applications: PlannedApplication[];
}

/** 체크섬이 맞는 가짜 사업자등록번호 (000 으로 시작 — 실제 세무서 코드가 아니다. 시연 데이터 00000000xx 와 겹치지 않게 0009 로 시작). */
export function fakeBizNo(n: number): string {
  const body = `0009${pad(n, 5)}`;
  for (let d = 0; d <= 9; d++) if (isValidBizNo(`${body}${d}`)) return `${body}${d}`;
  throw new Error('bulk: biz no');
}

/** 첨부용 가짜 PDF (ASCII 문장 하나). 실제 이력서가 아님을 적는다. */
export function fakeResumePdf(n: number): Uint8Array {
  const text = `SAMPLE RESUME ${n} - fake test data, not a real person.`;
  const stream = `BT /F1 12 Tf 60 760 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((x) => `${pad(x, 10)} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const activeOf = (o: OptionSet, k: OptionKind) => o.list[k].filter((r) => r.active === 1);
const inactiveOf = (o: OptionSet, k: OptionKind) => o.list[k].filter((r) => r.active !== 1);
const actorOf = (m: BulkMemberRow): Actor => ({ id: m.user_id, role: 'company', companyIds: [m.company_id], hqCompanyIds: m.is_hq ? [m.company_id] : [], agencyIds: [] });

/** 넣을 행을 모두 만든다 (DB 접근 없음). 상태는 규칙 함수로 정한다. 같은 params·ctx 면 같은 결과(시각은 ctx.now 기준). */
export async function buildBulkPlan(params: BulkParams, ctx: BulkPlanCtx): Promise<BulkPlan> {
  const r = rngOf(BULK_RANDOM_SEED);
  const now = ctx.now;
  const ago = (days: number) => now - Math.round(days * DAY);
  const req = requiredConsents(ctx.retention);
  const users: BulkUserRow[] = [];
  const consents: BulkBaseRows['consents'] = [];
  let userNo = 0, consentNo = 0;
  const addUser = (email: string, role: 'seeker' | 'company', locale: 'ko' | 'zh', created: number): string => {
    const id = bulkId(1, ++userNo);
    users.push({ id, email, role, locale, created_at: created });
    for (const c of req) consents.push({ id: bulkId(7, ++consentNo), user_id: id, type: c.type, version: c.version, agreed_at: created });
    return id;
  };
  /** 가중치 [값, 무게] 에서 하나. */
  const pickW = <T>(xs: ReadonlyArray<readonly [T, number]>): T => {
    let x = r() * xs.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of xs) { if ((x -= w) < 0) return v; }
    return xs[xs.length - 1]![0];
  };

  const industries = activeOf(ctx.options, 'industry');
  const roles = new Set(activeOf(ctx.options, 'role_category').map((o) => o.code));
  const locations = activeOf(ctx.options, 'location');
  const itFamilies = IT_FAMILIES.filter((f) => roles.has(f.role));
  const otherFamilies = OTHER_FAMILIES.filter((f) => roles.has(f.role));
  if (!industries.length || !locations.length || !(itFamilies.length + otherFamilies.length)) throw new Error('bulk: no active options');
  const inactive = { role: new Set(inactiveOf(ctx.options, 'role_category').map((o) => o.code)), industry: inactiveOf(ctx.options, 'industry'), location: inactiveOf(ctx.options, 'location') };
  const locOf = (code: string) => locations.find((o) => o.code === code);

  // ── 기업·담당자·서류
  const companies: BulkCompanyRow[] = [];
  const members: BulkMemberRow[] = [];
  const docs: BulkDocRow[] = [];
  const docFiles: BulkPlan['docFiles'] = [];
  const docPdf = demoDocPdf();
  const membersOf = new Map<string, BulkMemberRow[]>();
  const specOf = new Map<string, CompanySpec>();
  const companyWeight: number[] = [];
  for (let i = 1; i <= params.companies; i++) {
    const id = bulkId(2, i);
    const spec = COMPANIES[(i - 1) % COMPANIES.length]!;
    specOf.set(id, spec);
    const series = i > COMPANIES.length ? ` ${Math.ceil(i / COMPANIES.length)}` : '';
    const indCode = spec.industry ?? SECTOR[spec.sector].industry;
    const ind = industries.find((o) => o.code === indCode) ?? industries[(i * 7) % industries.length]!;
    const entity: 'kr_entity' | 'cn_hq' = spec.cnHq ? 'cn_hq' : 'kr_entity';
    const stage = spec.stage;
    const [cityZh, cityKo] = CITY[spec.city]!;
    const created = ago(r.int(100, 140));
    const want: 'verified' | 'pending' | 'rejected' = i % 13 === 6 ? 'pending' : i % 23 === 11 ? 'rejected' : 'verified';
    const bizNo = entity === 'kr_entity' ? fakeBizNo(i) : null;
    const docType = entity === 'kr_entity' ? 'biz_cert' as const : 'cn_license' as const;
    const docId = bulkId(6, i);
    const docKey = `vdocs/company/${id}/${docId}.pdf`;
    const reviewStatus = want === 'verified' ? 'approved' as const : want;
    docs.push({ id: docId, company_id: id, doc_type: docType, r2_key: docKey, review_status: reviewStatus, reviewed_at: want === 'pending' ? null : created + DAY, created_at: created + 3600 });
    docFiles.push({ key: docKey, bytes: docPdf });
    // 검증 상태는 verifyBlocks 가 정한다 (확인을 마친 서류만 센다).
    const verified = want === 'verified' && verifyBlocks({ entity_type: entity, biz_no: bizNo, docTypes: [docType] }).length === 0;
    const status = verified ? 'verified' as const : want === 'rejected' ? 'rejected' as const : 'pending' as const;
    // 진출 이유에 이미 법인 이야기가 있으면 단계 문장을 되풀이하지 않는다.
    const [stageZh, stageKo] = spec.why[1].includes('법인') ? ['', ''] : STAGE_LINE[stage];
    companies.push({
      id, name_ko: `${spec.name[1]}${entity === 'kr_entity' ? ' 코리아' : ''}${series} (가상)`, name_zh: `${spec.name[0]}${entity === 'kr_entity' ? '韩国' : ''}${series}（虚拟）`,
      biz_no: bizNo, entity_type: entity, hq_name: `${cityZh}${spec.hq ?? (spec.name[0].length <= 2 ? `${spec.name[0]}${SECTOR[spec.sector].hqWord}` : spec.name[0])}有限公司${series}（虚拟）`, entry_stage: stage, industry: ind.label_ko,
      profile_ko: lines(
        '※ 대량 테스트용 가상 기업입니다. 실제 기업이 아니며 공고도 예시입니다.', '',
        `${cityKo}에 본사를 둔 ${spec.product[1]} 기업입니다. ${spec.why[1]}${stageKo ? ` ${stageKo}` : ''}`, '',
        `【公司简介】总部位于${cityZh}，主营${spec.product[0]}。${spec.why[0]}${stageZh}`,
      ),
      verify_status: status, verified_at: verified ? created + DAY : null,
      reject_reason: status === 'rejected' ? '테스트 데이터: 서류의 상호가 읽히지 않는 예시입니다.' : null, created_at: created,
    });
    // 담당자 1~3명. 대표의 본사 소속 여부는 기업 형태로 정한다 (lib/company.ownerIsHq). 일부 기업에 본사 소속 담당자를 더한다 (국외 이전 동의 경로).
    const ms: BulkMemberRow[] = [];
    const ownerHq = ownerIsHq(entity);
    const extra = r.chance(0.35) ? (r.chance(0.4) ? 2 : 1) : 0;
    const hqExtra = entity === 'kr_entity' && r.chance(0.3);
    for (let k = 0; k <= extra; k++) {
      const isHq: 0 | 1 = k === 0 ? ownerHq : entity === 'cn_hq' ? (r.chance(0.5) ? 1 : 0) : (hqExtra && k === 1 ? 1 : 0);
      const email = `c${pad(i, 3)}.${k === 0 ? 'owner' : `m${k}`}@${BULK_MAIL_DOMAIN}`;
      const uid = addUser(email, 'company', isHq || r.chance(0.15) ? 'zh' : 'ko', created);
      ms.push({ company_id: id, user_id: uid, member_role: k === 0 ? 'owner' : 'member', is_hq: isHq, created_at: created });
    }
    members.push(...ms);
    membersOf.set(id, ms);
    // 공고 수의 차이 (몇 건뿐인 기업과 수십 건인 기업이 함께 있게)
    // 검증 전·반려 기업은 공고가 적다 (초안 몇 건) — 목록 화면의 공고 수가 기업 상태에 크게 흔들리지 않게.
    companyWeight.push(status !== 'verified' ? 0.3 : r.chance(0.15) ? 6 + r() * 6 : 0.4 + r() * 1.6);
  }

  // ── 공고: 기업의 업계·진출 단계에 맞는 직무 묶음 (특화 묶음은 무게 2.5). IT 가 BULK_IT_SHARE 쯤.
  const famChoices = (spec: CompanySpec, pool: readonly Family[]): Array<readonly [Family, number]> =>
    pool.filter((f) => (!f.stages || f.stages.includes(spec.stage)) && (!f.sectors || f.sectors.includes(spec.sector))).map((f) => [f, f.sectors ? 2.5 : 1] as const);
  const cumC: number[] = [];
  companyWeight.reduce((s, w, i) => (cumC[i] = s + w), 0);
  const pickCompany = (): BulkCompanyRow => {
    const x = r() * cumC[cumC.length - 1]!;
    let lo = 0, hi = cumC.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumC[mid]! < x) lo = mid + 1; else hi = mid; }
    return companies[lo]!;
  };
  const jobs: PlannedJob[] = [];
  const jobMeta = new Map<string, { fam: Family; cn: CnLevel }>();
  const techFamily = otherFamilies.find((f) => f.key === 'kc_cert') ?? otherFamilies[0] ?? itFamilies[0]!;
  for (let n = 1; n <= params.jobs; n++) {
    const co = pickCompany();
    const spec = specOf.get(co.id)!;
    const ms = membersOf.get(co.id)!;
    const author = r.pick(ms);
    const x = r();
    const want: JobWant = x < 0.01 ? 'tech' : x < 0.03 ? 'blocked' : x < 0.06 ? 'draft' : x < 0.08 ? 'review' : x < 0.17 ? 'closed' : 'open';
    const wantIt = r.chance(BULK_IT_SHARE);
    const first = famChoices(spec, wantIt ? itFamilies : otherFamilies);
    const choices = first.length ? first : famChoices(spec, wantIt ? otherFamilies : itFamilies);
    const fam = want === 'tech' ? techFamily : choices.length ? pickW(choices) : r.pick(wantIt && itFamilies.length ? itFamilies : otherFamilies.length ? otherFamilies : itFamilies);
    const [cityZh, cityKo] = CITY[spec.city]!;

    // 레벨·경력 연차·제목
    const [bz, bk] = want === 'tech' ? TECH_LEAK.title : r.pick(fam.sectorTitles?.[spec.sector] ?? fam.titles);
    let level: Level = fam.years ? 'mid' : fam.levels ? r.pick(['junior', 'mid', 'mid', 'mid', 'senior', 'senior', 'lead'] as const) : r.chance(0.2) ? 'senior' : 'mid';
    if (SENIOR_TITLE.test(bz) && level === 'junior') level = 'mid';
    if (/主管|负责人/.test(bz) && level === 'lead') level = 'senior';
    const y = fam.years ?? LEVEL_YEARS[level];
    const title_zh = want === 'tech' || fam.years ? bz : level === 'junior' ? `初级${bz}` : level === 'senior' ? `${fam.levels ? '高级' : '资深'}${bz}` : level === 'lead' ? leadZh(bz) : bz;
    const title_ko = want === 'tech' || fam.years ? bk : level === 'junior' ? `주니어 ${bk}` : level === 'senior' ? `시니어 ${bk}` : level === 'lead' ? leadKo(bk) : bk;

    const locPool = fam.locs ?? (fam.role === 'it' ? ['seoul', 'seoul', 'seoul', 'gyeonggi', 'gyeonggi', 'remote'] : SECTOR[spec.sector].locs);
    const cands = locPool.map(locOf).filter((o): o is NonNullable<typeof o> => !!o);
    const loc = inactive.location.length && r.chance(0.02) ? r.pick(inactive.location) : !cands.length || r.chance(0.05) ? r.pick(locations) : r.pick(cands);
    const indCode = inactive.industry.length && r.chance(0.02) ? r.pick(inactive.industry).code
      : (industries.find((o) => o.label_ko === co.industry) ?? r.pick(industries)).code;
    const cn = r.pick(fam.cn);
    const report = co.entity_type === 'cn_hq' || spec.stage === 'preparing' || r.chance(0.3) ? 'cn_hq' as const : 'kr_head' as const;
    const rep = report === 'kr_head' ? REPORT_KR : r.pick(fam.role === 'it' ? REPORT_HQ_IT : REPORT_HQ);

    // 본문: 짧은 공고 / 보통 / 자세한 공고. 중국어 원문은 중국 본사 인사팀이 쓰는 모양(【岗位职责】…), 한국어는 같은 구조의 승인된 현지화본.
    const style = r() < 0.3 ? 'short' : r() < 0.55 ? 'medium' : 'detailed';
    // 첫 업무(그 직무의 핵심)는 맨 앞에 두고, 나머지만 섞는다.
    const duties = [fam.duties[0]!, ...r.shuffle(fam.duties.slice(1))].slice(0, style === 'short' ? 2 : style === 'medium' ? r.int(3, 4) : 5);
    if (want === 'tech') duties.unshift(TECH_LEAK.duty);
    const yearsReq: P = level === 'junior' && r.chance(0.35) ? NEWGRAD_REQ : fam.reqs[0]!;
    const restReqs = r.shuffle(fam.reqs.slice(1)).slice(0, style === 'short' ? 1 : style === 'medium' ? 2 : fam.reqs.length);
    const reqs: P[] = [yearsReq, ...restReqs];
    if (style !== 'short' && spec.stage !== 'operating' && !fam.startupReq && r.chance(0.5)) reqs.push(STARTUP_REQ);
    if (style !== 'short' && r.chance(report === 'cn_hq' ? 0.5 : 0.2)) reqs.push(r.pick(TRAVEL));
    reqs.push(r.pick(CN_LINE[cn]));
    const plus = style === 'detailed' ? r.shuffle([...fam.plus]).slice(0, r.int(1, 2)) : style === 'medium' && r.chance(0.4) ? [r.pick(fam.plus)] : [];
    const perks: P[] = style === 'short' ? [] : r.shuffle([...PERKS]).slice(0, style === 'medium' ? 2 : r.int(3, 4));
    // 가끔 중국 회사 습관 표현(五险一金). 같은 공고에 한국 4대 보험 줄이 있으면 뺀다 (서로 다른 제도를 한 공고에 함께 적지 않게).
    if (perks.length && r.chance(0.1)) { perks.splice(0, perks.length, ...perks.filter((p) => !p[1].includes('4대 보험')), PERK_CN_STYLE); }
    if (perks.length && fam.role === 'it' && r.chance(0.4)) perks.push(r.pick(PERK_IT));
    const v = { y, city: cityZh }, vk = { y, city: cityKo };
    // 단락 사이는 빈 줄 (화면이 줄바꿈을 그대로 보인다).
    const paras = (...bs: Array<string[] | false>) => bs.filter((b): b is string[] => !!b && b.length > 0).map((b) => lines(...b)).join('\n\n');
    const zh = paras(
      [...(style === 'short' ? [] : [`汇报对象：${rep[0]}`]), `工作地点：${loc.label_zh}`],
      style === 'detailed' && ['【关于我们】', `总部位于${cityZh}，主营${spec.product[0]}。${spec.why[0]}`],
      ['【岗位职责】', ...numZh(duties.map(([z]) => fill(z, v)))],
      ['【任职要求】', ...numZh(reqs.map(([z]) => fill(z, v)))],
      plus.length > 0 && ['【加分项】', ...plus.map(([z]) => `· ${z}`)],
      perks.length > 0 && ['【我们提供】', ...perks.map(([z]) => `· ${z}`)],
    );
    const ko = paras(
      [...(style === 'short' ? [] : [`보고 대상: ${rep[1]}`]), `근무지: ${loc.label_ko}`],
      style === 'detailed' && ['[회사 소개]', `${cityKo}에 본사를 둔 ${spec.product[1]} 기업입니다. ${spec.why[1]}`],
      ['[담당 업무]', ...numKo(duties.map(([, k]) => fill(k, vk)))],
      ['[자격 요건]', ...numKo(reqs.map(([, k]) => fill(k, vk)))],
      plus.length > 0 && ['[우대 사항]', ...plus.map(([, k]) => `- ${k}`)],
      perks.length > 0 && ['[제공 사항]', ...perks.map(([, k]) => `- ${k}`)],
    );
    // 연봉 (만원, 구조화 칸 — 본문에 쓰지 않는다): 30% 협의(숫자 없음, 그중 절반은 퇴직금 기준만 적음), 나머지는 레벨에 맞는 범위
    const band: readonly [number, number] = fam.key === 'country_manager' ? [90, 140] : ({ junior: [30, 40], mid: [40, 58], senior: [58, 80], lead: [78, 100] } as const)[level];
    const negotiable = r.chance(0.3);
    const smin = negotiable ? null : r.int(band[0], band[1]) * 100;
    const smax = smin === null ? null : smin + r.int(3, level === 'lead' || fam.key === 'country_manager' ? 30 : 15) * 100;
    const basis = !negotiable || r.chance(0.5) ? r.pick(['severance_excluded', 'severance_excluded', 'severance_included'] as const) : null;
    const start = r.pick(['08:30', '09:00', '09:00', '09:30', '10:00']);
    const end = { '08:30': '17:30', '09:00': '18:00', '09:30': '18:30', '10:00': '19:00' }[start]!;
    const localized = want !== 'draft';
    const localize_status = want === 'draft' ? 'draft' as const : want === 'review' ? 'review' as const : 'approved' as const;
    const postedAgo = want === 'closed' ? 30 + r() * 60 : r() * 90;
    const publishAt = ago(postedAgo);
    const closeAt = want === 'closed' ? Math.min(publishAt + r.int(14, 28) * DAY, now - DAY) : null;
    const closesAt = want === 'open' && r.chance(0.65) ? parseKstDate(kstDate(now + r.int(3, 60) * DAY)) : null;
    const created = want === 'draft' || want === 'review' ? ago(r() * 30) : publishAt - r.int(1, 3) * DAY;
    const row: BulkJobRow = {
      id: bulkId(3, n), company_id: co.id, created_by: author.user_id, title_zh, source_zh: zh, title_ko: localized ? title_ko : null, body_ko: localized ? ko : null,
      localize_status, role_category: inactive.role.size && r.chance(0.02) ? r.pick([...inactive.role]) : fam.role, industry: indCode, location: loc.code,
      salary_min: smin, salary_max: smax, salary_basis: basis, work_hours: `${start}-${end}`, report_line: report, chinese_level: cn,
      contact_email: `recruit.c${pad(Number(co.id.slice(-12)), 3)}@${BULK_MAIL_DOMAIN}`,
      review_flag: null, closes_at: closesAt, created_at: created, updated_at: Math.max(created, ago(r() * 10)),
    };
    row.review_flag = techLeakFlag(flagText(row));
    const companyVerified = co.verify_status === 'verified';
    // 게재는 publishBlocks 가 빈 배열일 때만 (규칙 2). 초안·검토 중·기술유출 검토 대기·미검증 기업의 공고는 여기서 걸린다.
    const blocks = publishBlocks(publishInputOf(
      { job_family: 'office', title_ko: row.title_ko, body_ko: row.body_ko, localize_status, contact_email: row.contact_email, salary_basis: basis,
        salary_min: smin, agency_id: null, review_flag: row.review_flag, review_cleared_by: null },
      { companyVerified, flags: ctx.flags, appEnv: ctx.appEnv, registrationNo: ctx.registrationNo, operatorDomains: ctx.operatorDomains },
    ));
    const publishable = blocks.length === 0 && (want === 'open' || want === 'closed' || want === 'blocked');
    jobs.push({
      row, want, publishAt: publishable ? Math.min(publishAt, now - 60) : null, closeAt: publishable ? closeAt : null, companyVerified, members: ms,
      need: consentNeed({ hqMembers: ms.filter((m) => m.is_hq === 1).length, localMembers: ms.filter((m) => m.is_hq === 0).length }),
    });
    jobMeta.set(row.id, { fam, cn });
  }

  // ── 구직자·이력서: IT 경력자가 절반 이상. 중국어 업무 가능·원어민 수준 구직자의 일부는 중국어 이력서만, 일부는 한국어(대표) + 중국어 두 개.
  const resumes: BulkResumeRow[] = [];
  const resumeFiles: BulkPlan['resumeFiles'] = [];
  interface SeekerResume { id: string; lang: ResumeLang; body: ResumeBody; filePlain: Uint8Array | null }
  interface Seeker { id: string; created: number; fam: Family; level: CnLevel; resumes: SeekerResume[] }
  const seekers: Seeker[] = [];
  let fileNo = 0, resumeNo = 0;
  const seekerFamilies = { it: itFamilies.length ? itFamilies : otherFamilies, other: otherFamilies.length ? otherFamilies : itFamilies };
  for (let s = 1; s <= params.seekers; s++) {
    const email = `seeker${pad(s, 4)}@${BULK_MAIL_DOMAIN}`;
    const created = ago(r.int(95, 130));
    const uid = addUser(email, 'seeker', r.chance(0.1) ? 'zh' : 'ko', created);
    if (!r.chance(260 / 300)) continue;
    const fam = r.pick(r.chance(BULK_IT_SEEKER_SHARE) ? seekerFamilies.it : seekerFamilies.other);
    const level: CnLevel = fam.key === 'interpreter' ? 'native'
      : fam.key === 'first_hire' || fam.key === 'country_manager' || fam.key === 'itpm' ? r.pick(['business', 'native'] as const)
      : pickW([['none', 25], ['basic', 20], ['business', 35], ['native', 20]] as const);
    const years = fam.years ? r.int(Math.max(1, fam.years - 2), fam.years + 6) : r.chance(0.1) ? 0 : r.int(1, 15);
    const bilingual = level === 'business' || level === 'native';
    const y = r();
    const langs: ResumeLang[] = !bilingual ? ['ko'] : y < 0.34 ? ['ko', 'zh'] : y < 0.64 ? ['zh'] : ['ko'];
    const name = `${r.pick(SURNAMES)}${r.pick(GIVEN_A)}${r.pick(GIVEN_B)}(가상)`;
    const phone = r.chance(0.6) ? `010-0000-${pad(s % 10000, 4)}` : null;
    const seeker: Seeker = { id: uid, created, fam, level, resumes: [] };
    // 경력·학력·어학은 두 언어 이력서가 같은 사실을 적는다 (같은 사람).
    const career = r.shuffle([...fam.resume.exp]).slice(0, years === 0 ? 1 : years <= 3 ? 1 : years <= 8 ? 2 : 3);
    const spans = career.map((_, k) => (years === 0 ? 0 : k === career.length - 1 ? Math.max(1, years - (career.length - 1) * Math.floor(years / career.length)) : Math.max(1, Math.floor(years / career.length))));
    const month = r.int(1, 10);
    const edu = EDU[r.pick(fam.resume.edu)] ?? EDU.biz!;
    const china = bilingual ? r.pick(years >= 4 && r.chance(0.5) ? CHINA_WORK : CHINA_STUDY) : null;
    const hsk = level === 'business' || level === 'native' ? r.pick(HSK[level]) : null;
    const self = r.pick(bilingual && r.chance(0.4) ? SELF_BILINGUAL : SELF);
    const brief = r.chance(0.3);
    const dated = (lang: ResumeLang): string[] => {
      const out: string[] = [];
      let endY = 2026, endM = month;
      career.forEach((e, k) => {
        const [org, team, a, b] = lang === 'ko' ? e.ko : e.zh;
        if (years === 0) {
          out.push(lang === 'ko' ? `신입 (인턴 6개월 | ${org} · ${team})` : `应届毕业（实习6个月：${org}｜${team}）`, lang === 'ko' ? `- ${a}` : `· ${a}`);
          return;
        }
        const startY = endY - spans[k]!, startM = endM;
        const from = `${startY}.${pad(startM, 2)}`, to = k === 0 ? (lang === 'ko' ? '현재' : '至今') : `${endY}.${pad(endM, 2)}`;
        out.push(lang === 'ko' ? `${from} ~ ${to} | ${org} · ${team}` : `${from} – ${to}　${org}｜${team}`);
        out.push(...(lang === 'ko' ? [`- ${a}`, `- ${b}`] : [`· ${a}`, `· ${b}`]));
        endY = startY; endM = Math.max(1, startM - 1);
      });
      return out;
    };
    for (const lang of langs) {
      const withFile = r.chance(lang === 'ko' ? 0.3 : 0.2);
      const withExp = !withFile || r.chance(0.7); // 첨부도 경력 요약도 없는 이력서는 지원할 수 없으므로 만들지 않는다
      const sections = (...bs: Array<string[] | false>) => bs.filter((b): b is string[] => !!b).map((b) => lines(...b)).join('\n\n');
      const exp = !withExp ? null : lang === 'ko' ? sections(
        ['[경력]', ...dated('ko')], ['[학력]', edu[1]],
        level !== 'none' && ['[어학]', level === 'basic' ? '- 중국어: 기초 회화' : `- ${hsk![1]}`, ...(china ? [`- ${china[1]}`] : [])],
        !brief && ['[기술·역량]', fam.resume.skills[1]], !brief && ['[자기소개]', self[1]],
      ) : sections(
        ['【工作经历】', ...dated('zh')], ['【教育背景】', edu[0]],
        ['【语言能力】', `韩语（母语）；中文（${level === 'native' ? '可作为工作语言' : hsk![0]}）`], !!china && ['【海外经历】', china![0]],
        !brief && ['【专业技能】', fam.resume.skills[0]], !brief && ['【自我评价】', self[0]],
      );
      let filePlain: Uint8Array | null = null;
      let fileKey: string | null = null;
      let meta: ResumeBody['file'] = null;
      if (withFile) {
        fileNo += 1;
        filePlain = fakeResumePdf(fileNo);
        fileKey = resumeFileKey(fileNo);
        meta = { name: lang === 'zh' ? '中文简历.pdf' : r.chance(0.5) ? '경력기술서.pdf' : 'resume.pdf', ext: 'pdf', mime: 'application/pdf', size: filePlain.length };
        resumeFiles.push({ key: fileKey, plain: filePlain });
      }
      const [dz, dk] = fam.resume.desired;
      const headline = years === 0
        ? (lang === 'ko' ? `${dk} 분야 신입, 인턴 경험` : `应届毕业生，有${dz}方向实习经验`)
        : fill(lang === 'ko' ? fam.resume.headline[1] : fam.resume.headline[0], { y: years });
      const body: ResumeBody = {
        v: 1, name, chinese_level: level, years, headline: headline.slice(0, 100), contact_email: email, phone,
        desired_role: lang === 'ko' ? dk : dz, experience_text: exp, file: meta,
      };
      const title = lang === 'ko' ? r.pick([`${dk} 지원용`, '기본 이력서', dk]).slice(0, 40)
        : langs.length > 1 ? '중국어 이력서' : r.pick(['中文简历', '중국어 이력서', `${dz}简历`]).slice(0, 40);
      const rid = bulkId(4, ++resumeNo);
      const at = created + 3600 * (seeker.resumes.length + 1);
      resumes.push({ id: rid, user_id: uid, title, lang, is_default: seeker.resumes.length === 0 ? 1 : 0, body: await sealResume(ctx.encKey, body), file_r2_key: fileKey, created_at: at, updated_at: at + 3600 });
      seeker.resumes.push({ id: rid, lang, body, filePlain });
    }
    seekers.push(seeker);
  }

  // ── 지원: 지금 공개 목록에 보이는 공고(게재될 공고)에만. 인기 공고와 지원 없는 공고가 함께 있게 가중치를 준다.
  // 지원자는 같은 직무 경력자가 많고(IT 공고에는 IT 경력자), 두 언어 이력서가 있으면 공고의 중국어 수준에 맞춰 고른다 (실제 구직자가 고르듯).
  const visible = jobs.filter((j) => j.publishAt !== null
    && isPubliclyVisible({ status: 'published', agency_id: null, job_family: 'office', closes_at: j.row.closes_at, company_verify_status: j.companyVerified ? 'verified' : 'pending' }, { flags: ctx.flags, now }));
  r.shuffle(visible);
  const weights = visible.map((_, i) => (r.chance(0.15) ? 0 : 1 / Math.pow(i + 1, 0.8)));
  const cumJ: number[] = [];
  weights.reduce((s, w, i) => (cumJ[i] = s + w), 0);
  const totalW = cumJ[cumJ.length - 1] ?? 0;
  const pickJob = (): PlannedJob => {
    const x = r() * totalW;
    let lo = 0, hi = cumJ.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumJ[mid]! <= x) lo = mid + 1; else hi = mid; }
    return visible[lo]!;
  };
  const byFam = new Map<string, Seeker[]>();
  const byIt = new Map<boolean, Seeker[]>([[true, []], [false, []]]);
  for (const sk of seekers) {
    if (!byFam.has(sk.fam.key)) byFam.set(sk.fam.key, []);
    byFam.get(sk.fam.key)!.push(sk);
    byIt.get(sk.fam.role === 'it')!.push(sk);
  }
  const pickSeeker = (fam: Family, cn: CnLevel): Seeker => {
    const x = r();
    let pool = x < 0.5 ? byFam.get(fam.key) : x < 0.82 ? byIt.get(fam.role === 'it') : undefined;
    if (!pool?.length) pool = seekers;
    let sk = r.pick(pool);
    if ((cn === 'business' || cn === 'native') && sk.level === 'none' && r.chance(0.6)) sk = r.pick(pool);
    return sk;
  };
  const ZH_PICK: Readonly<Record<CnLevel, number>> = { native: 0.75, business: 0.5, basic: 0.15, none: 0.05 };
  const applications: PlannedApplication[] = [];
  const keepDays = ctx.retention.application_keep_days;
  const used = new Set<string>();
  let appNo = 0, appFileNo = 0, attempts = 0;
  while (applications.length < params.applications && totalW > 0 && seekers.length && attempts++ < params.applications * 30) {
    const job = pickJob();
    const meta = jobMeta.get(job.row.id)!;
    const sk = pickSeeker(meta.fam, meta.cn);
    const pair = `${job.row.id}|${sk.id}`;
    if (used.has(pair)) continue;
    const until = Math.min(job.closeAt ?? now, now) - 120;
    const from = Math.max(job.publishAt!, sk.created + 3 * 3600);
    if (until <= from) continue;
    used.add(pair);
    const ts = from + Math.floor(r() * (until - from));
    const zhRes = sk.resumes.find((x) => x.lang === 'zh');
    const res = sk.resumes.length > 1 && zhRes && r.chance(ZH_PICK[meta.cn]) ? zhRes : sk.resumes[0]!;
    const b = res.body;
    const fields = { name: b.name, chinese_level: b.chinese_level, years: b.years, headline: b.headline, contact_email: b.contact_email,
      phone: b.phone, desired_role: b.desired_role, experience_text: b.experience_text };
    const include = !!res.filePlain && (!b.experience_text || r.chance(0.85));
    const snapshot = buildSnapshot(b, fields, { include, copied: include }, res.lang);
    const consentGiven = job.need === 'required' ? true : job.need === 'optional' ? r.chance(0.6) : false;
    // 실제 지원과 같은 판단 (lib/application.applyBlocks). 막히면 넣지 않는다.
    if (applyBlocks({ canApply: true, jobVisible: true, alreadyApplied: false, resumeReady: resumeReadyToApply(snapshot), consentNeed: job.need, consentGiven }).length) continue;
    appNo += 1;
    let fileKey: string | null = null;
    if (include) { appFileNo += 1; fileKey = applicationFileKey(appFileNo); }
    const consent = consentAt(job.need, consentGiven, ts);
    const app: PlannedApplication = {
      id: bulkId(5, appNo), jobId: job.row.id, seekerId: sk.id, resumeId: res.id, resumeLang: res.lang, snapshot: await sealResume(ctx.encKey, snapshot),
      fileKey, filePlain: include ? res.filePlain : null, consentAt: consent, consentVersion: crossBorderVersion(keepDays), ts, keepDays, events: [],
    };
    // 이후 이벤트 계획 (시각은 차례로 늘어난다). 회사 쪽 이벤트를 낸 사람은 그 지원서를 볼 수 있는 담당자다 (authz.canViewApplication).
    const ref = { seeker_id: sk.id, job: { company_id: job.row.company_id, agency_id: null, created_by: job.row.created_by }, cross_border_consent_at: consent, status: 'submitted' };
    const viewers = job.members.filter((m) => canViewApplication(actorOf(m), ref).allow);
    let t = ts;
    const later = (): number | null => { t += r.int(3600, 5 * DAY); return t < now - 60 ? t : null; };
    const push = (event: PlannedEvent['event'], actorId: string): boolean => { const at = later(); if (at === null) return false; app.events.push({ event, actorId, at }); return true; };
    if (viewers.length) {
      const viewer = r.pick(viewers);
      if (r.chance(0.65) && push('viewed', viewer.user_id)) {
        const y = r();
        if (y < 0.22) {
          if (push('interview_mail', viewer.user_id) && r.chance(0.25)) push('interview_mail', viewer.user_id);
          if (r.chance(0.3)) push('reject_mail', viewer.user_id);
        } else if (y < 0.47) push('reject_mail', viewer.user_id);
      } else if (r.chance(0.05)) push('reject_mail', viewer.user_id);
    }
    // 취소는 진행 중인 지원만 할 수 있다 (불합격 뒤에는 계획하지 않는다).
    if (!app.events.some((e) => e.event === 'reject_mail') && r.chance(0.05)) push('withdrawn', sk.id);
    applications.push(app);
  }

  return { base: { users, consents, companies, members, docs }, docFiles, jobs, resumes, resumeFiles, applications };
}
/** 계획의 개수 (출력용 — 이름·내용 없음). */
export function planCounts(p: BulkPlan): Record<string, number> {
  const ev = p.applications.flatMap((a) => a.events);
  return {
    companies: p.base.companies.length, companies_verified: p.base.companies.filter((c) => c.verify_status === 'verified').length,
    company_users: p.base.users.filter((u) => u.role === 'company').length, seekers: p.base.users.filter((u) => u.role === 'seeker').length,
    jobs: p.jobs.length, jobs_to_publish: p.jobs.filter((j) => j.publishAt !== null).length,
    jobs_to_close: p.jobs.filter((j) => j.publishAt !== null && j.want === 'closed').length, jobs_to_block: p.jobs.filter((j) => j.publishAt !== null && j.want === 'blocked').length,
    jobs_it: p.jobs.filter((j) => j.row.role_category === 'it').length,
    resumes: p.resumes.length, resumes_zh: p.resumes.filter((x) => x.lang === 'zh').length, resume_files: p.resumeFiles.length, applications: p.applications.length,
    application_files: p.applications.filter((a) => a.fileKey).length, events: ev.length,
  };
}

// ── 실행

export interface BulkOut { (line: string): void }

/** 대량 회원 주소의 해시 (email_log.to_hash 와 같은 방식 — lib/email.ts). */
async function bulkEmailHashes(env: Env): Promise<string[]> {
  return Promise.all((await listBulkUserEmails(env.DB, BULK_LIKE)).map((e) => sha256Hex(e.toLowerCase())));
}

async function bulkCounts(env: Env): Promise<BulkCounts> {
  return countBulk(env.DB, BULK_LIKE, await bulkEmailHashes(env));
}

const fmt = (o: Record<string, number>): string[] => Object.entries(o).map(([k, v]) => `  ${k.padEnd(22)} ${v}`);

/** 대량 파일 목록 (지우기의 남은 파일 찾기). 이름 순서대로 1000개씩. */
async function listBulkFiles(files: FileStore): Promise<string[]> {
  const out: string[] = [];
  for (const prefix of ['rfiles/', 'vdocs/company/']) {
    let cursor: string | undefined;
    for (;;) {
      const page = await files.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const o of page.objects) if (isBulkFileKey(o.key)) out.push(o.key);
      if (!page.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
  }
  return out;
}

export interface RemoveResult { rows: Record<string, number>; files: number; foreignApplications: number }

/** 대량 데이터만 지운다: DB 먼저(한 트랜잭션), 그다음 파일 (lib/maintenance.ts 와 같은 순서). */
export async function removeBulk(env: Env): Promise<RemoveResult> {
  const hashes = await bulkEmailHashes(env);
  const before = await countBulk(env.DB, BULK_LIKE, hashes);
  const keys = await listBulkFileKeys(env.DB, BULK_LIKE);
  const rows = await deleteBulkRows(env.DB, BULK_LIKE, hashes, `%@${BULK_MAIL_DOMAIN}`, BULK_STAMP_KEY);
  // 행이 가리키던 파일 + 대량 키 모양의 남은 파일(중간에 끊긴 실행이 남긴 것). 다른 회원의 지원서 첨부(대량 공고에 낸 것)도 행과 함께 지웠으므로 지운다.
  const all = new Set([...keys, ...await listBulkFiles(env.FILES)]);
  await env.FILES.delete([...all]);
  return { rows, files: all.size, foreignApplications: before.foreign_applications };
}

/** 대량 데이터를 만든다 (있으면 먼저 지우는 것은 호출부). 개수를 돌려준다. */
export async function createBulk(env: Env, plan: BulkPlan, ts: number, params: BulkParams, out: BulkOut): Promise<Record<string, number>> {
  const key = await importEncKey(env.ENC_KEY);
  const flags = flagsOf(env);
  const step = (s: string) => out(`  - ${s}`);

  step('회원·기업·검증 서류');
  await Promise.all(plan.docFiles.map((f) => env.FILES.put(f.key, f.bytes, { httpMetadata: { contentType: 'application/pdf' } })));
  await insertBulkBase(env.DB, plan.base);

  step('공고 (초안으로 넣은 뒤 게재할 수 있는 것만 게재)');
  await insertBulkJobs(env.DB, plan.jobs.map((j) => j.row));
  let published = 0;
  for (const j of plan.jobs) {
    // publishAt 은 buildBulkPlan 이 publishBlocks 가 빈 배열일 때만 정했다. publishJob 의 WHERE 가 상태·승인·검토·기업 검증을 다시 확인한다.
    if (j.publishAt !== null && await publishJob(env.DB, { ts: j.publishAt, id: j.row.id, rev: 0 })) published += 1;
  }

  step('이력서·첨부');
  for (const f of plan.resumeFiles) await env.FILES.put(f.key, await encryptFile(key, f.plain, f.key));
  await insertBulkResumes(env.DB, plan.resumes);

  step('지원 (실제 지원과 같은 함수)');
  let applied = 0, events = 0, skippedEvents = 0;
  const access: BulkAccessRow[] = [];
  const withdrawnFiles: string[] = [];
  for (const a of plan.applications) {
    if (a.fileKey && a.filePlain) await env.FILES.put(a.fileKey, await encryptFile(key, a.filePlain, a.fileKey));
    const ok = await insertApplication(env.DB, {
      id: a.id, jobId: a.jobId, seekerId: a.seekerId, resumeId: a.resumeId, resumeLang: a.resumeLang, snapshot: a.snapshot, fileKey: a.fileKey,
      consentAt: a.consentAt, consentVersion: a.consentVersion, ts: a.ts, keepDays: a.keepDays,
    }, flags);
    if (!ok) { if (a.fileKey) await env.FILES.delete(a.fileKey); continue; }
    applied += 1;
    // 상태는 이벤트마다 nextStatus 로 계산하고, 앱의 이벤트 함수로만 바꾼다 (규칙 3). 함수가 거절하면 그 지원의 나머지 이벤트는 넣지 않는다.
    let status: AppStatus = 'submitted';
    for (const e of a.events) {
      const to = nextStatus(status, e.event);
      let done = false;
      if (e.event === 'viewed') {
        done = to !== status && await markViewed(env.DB, { id: a.id, actorId: e.actorId, from: status, to, ts: e.at });
        if (done) access.push({ id: bulkId(8, access.length + 1), actor_id: e.actorId, actor_role: 'company', target_id: a.id, at: e.at });
      } else if (e.event === 'interview_mail' || e.event === 'reject_mail') {
        done = await recordMailEvent(env.DB, { id: a.id, actorId: e.actorId, event: e.event, from: status, to, maxSame: e.event === 'interview_mail' ? INTERVIEW_MAIL_MAX : 1, ts: e.at });
      } else {
        done = WITHDRAWABLE.includes(status) && await withdrawApplication(env.DB, { id: a.id, seekerId: a.seekerId, newStatus: to, fromStatuses: WITHDRAWABLE, ts: e.at });
        if (done && a.fileKey) withdrawnFiles.push(a.fileKey);
      }
      if (!done) { skippedEvents += 1; break; }
      events += 1;
      status = to;
    }
  }
  await insertBulkAccessLogs(env.DB, access);
  // 취소한 지원의 첨부는 DB 가 더 이상 가리키지 않은 뒤 지운다 (routes 의 취소와 같은 순서).
  if (withdrawnFiles.length) await env.FILES.delete(withdrawnFiles);

  step('마감·차단');
  let closed = 0, blocked = 0;
  const deadlines: Array<{ id: string; closes_at: number }> = [];
  for (const j of plan.jobs) {
    if (j.publishAt === null) continue;
    if (j.want === 'closed' && j.closeAt !== null && await closeJob(env.DB, j.row.id)) { closed += 1; deadlines.push({ id: j.row.id, closes_at: j.closeAt }); }
    if (j.want === 'blocked' && await blockJob(env.DB, { reason: '테스트 데이터: 관리자 차단 예시입니다 (가상 공고).', id: j.row.id })) blocked += 1;
  }
  await setBulkClosedDeadlines(env.DB, BULK_LIKE, deadlines);

  await writeBulkStamp(env.DB, BULK_STAMP_KEY, JSON.stringify({ v: BULK_SEED_VERSION, params, at: ts }), ts);
  return {
    published_then: published, closed, blocked, applications: applied, events, events_skipped: skippedEvents, access_log: access.length,
    files: (await listBulkFiles(env.FILES)).length,
  };
}

interface BulkStamp { v: number; params: BulkParams; at: number }
function parseStamp(raw: string | null): BulkStamp | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<BulkStamp>;
    return typeof o.v === 'number' && typeof o.at === 'number' && o.params && typeof o.params === 'object' ? o as BulkStamp : null;
  } catch {
    return null;
  }
}
const sameParams = (a: BulkParams, b: BulkParams) => (Object.keys(DEFAULT_BULK_PARAMS) as Array<keyof BulkParams>).every((k) => a[k] === b[k]);

/**
 * 명령 하나를 실행한다 (CLI 와 테스트가 같이 쓴다). 돌려주는 값 = 종료 코드. out 에는 개수만 쓴다.
 * 운영(production)이면 DB 를 읽지도 않고 1.
 */
export async function runBulkCommand(env: Env, args: Extract<BulkArgs, { ok: true }>, ts: number, out: BulkOut): Promise<number> {
  if (env.APP_ENV === 'production') {
    out('[X] 운영 서버(APP_ENV=production)에서는 대량 테스트 데이터를 만들거나 지울 수 없습니다. 테스트 서버나 개발 PC 에서만 쓰세요.');
    return 1;
  }
  if (env.APP_ENV !== 'test' && env.APP_ENV !== 'dev') {
    out('[X] APP_ENV 가 test 또는 dev 일 때만 실행합니다.');
    return 1;
  }
  const existing = await bulkCounts(env);
  const hasAny = existing.users + existing.companies + existing.jobs + existing.applications > 0;

  if (args.mode === 'remove') {
    if (args.dryRun) {
      out('[dry-run] 지울 대량 테스트 데이터 (실제로 지우지 않았습니다):');
      fmt({ ...existing }).forEach(out);
      if (existing.foreign_applications) out(`[!] 대량 공고에 다른 회원이 낸 지원 ${existing.foreign_applications}건도 함께 지워집니다.`);
      return 0;
    }
    if (!hasAny) { out('지울 대량 테스트 데이터가 없습니다.'); return 0; }
    const r = await removeBulk(env);
    out('[OK] 대량 테스트 데이터를 지웠습니다. 지운 행:');
    fmt(Object.fromEntries(Object.entries(r.rows).filter(([, n]) => n > 0))).forEach(out);
    out(`  ${'files'.padEnd(22)} ${r.files}`);
    if (r.foreignApplications) out(`[!] 대량 공고에 다른 회원이 낸 지원 ${r.foreignApplications}건도 함께 지웠습니다.`);
    return 0;
  }

  const stamp = parseStamp(await getSetting(env.DB, BULK_STAMP_KEY));
  if (stamp && stamp.v === BULK_SEED_VERSION && sameParams(stamp.params, args.params) && hasAny) {
    out('같은 조건의 대량 테스트 데이터가 이미 있습니다. 바꾸지 않았습니다. (지우려면 --remove)');
    fmt({ users: existing.users, companies: existing.companies, jobs: existing.jobs, jobs_published: existing.jobs_published, resumes: existing.resumes, applications: existing.applications }).forEach(out);
    return 0;
  }

  const plan = await buildBulkPlan(args.params, {
    now: ts, encKey: await importEncKey(env.ENC_KEY), flags: flagsOf(env), appEnv: env.APP_ENV, registrationNo: env.REGISTRATION_NO ?? '',
    operatorDomains: parseOperatorDomains(env.OPERATOR_DOMAINS ?? ''), retention: await loadRetention(env.DB), options: buildOptionSet(await listOptions(env.DB)),
  });
  if (args.dryRun) {
    out(`[dry-run] 만들 대량 테스트 데이터 (실제로 넣지 않았습니다)${hasAny ? ' — 지금 있는 대량 데이터는 먼저 지웁니다' : ''}:`);
    fmt(planCounts(plan)).forEach(out);
    return 0;
  }
  if (hasAny) {
    out(stamp ? '조건이 달라 기존 대량 테스트 데이터를 지우고 다시 만듭니다.' : '중간에 끊긴 대량 테스트 데이터를 지우고 다시 만듭니다.');
    await removeBulk(env);
  }
  out('대량 테스트 데이터를 만듭니다:');
  const r = await createBulk(env, plan, ts, args.params, out);
  const c = await bulkCounts(env);
  out('[OK] 만들었습니다.');
  fmt({
    companies: c.companies, users: c.users, jobs: c.jobs, jobs_published: c.jobs_published, jobs_closed: c.jobs_closed, jobs_blocked: c.jobs_blocked, jobs_draft: c.jobs_draft,
    resumes: c.resumes, resume_files: c.resume_files, applications: c.applications, application_files: c.application_files, events: c.events, access_log: c.access_log,
    files: r.files!,
  }).forEach(out);
  if (r.events_skipped) out(`  (계획한 이벤트 중 앱 함수가 받지 않은 것 ${r.events_skipped}건은 넣지 않았습니다)`);
  return 0;
}

