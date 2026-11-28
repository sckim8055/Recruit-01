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
import { resumeReadyToApply, sealResume, type ResumeBody, type ResumeChineseLevel } from './resume';
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
export const BULK_SEED_VERSION = 1;

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

/** 상호의 앞 글자: [중국어, 한국어 표기]. 조합은 실제 상호가 아니며, 이름 끝에 "(가상)·（虚拟）" 을 붙인다. */
const BRAND_A: ReadonlyArray<readonly [string, string]> = [
  ['瑞', '루이'], ['澜', '란'], ['拓', '퉈'], ['恒', '헝'], ['泓', '훙'], ['曜', '야오'], ['澄', '청'], ['朗', '랑'],
  ['沐', '무'], ['骁', '샤오'], ['霁', '지'], ['皓', '하오'], ['祺', '치'], ['煦', '쉬'], ['榕', '룽'], ['翊', '이'],
];
const BRAND_B: ReadonlyArray<readonly [string, string]> = [
  ['途', '투'], ['帆', '판'], ['岳', '웨'], ['川', '촨'], ['宸', '천'], ['屿', '위'], ['舟', '저우'], ['汀', '팅'], ['杉', '산'], ['屏', '핑'],
];
/** 업계 code → 상호 뒷부분 [중국어, 한국어]. 기술유출 필터 단어(电池 등)는 쓰지 않는다. 표에 없는 code(관리자가 추가한 항목)는 实业. */
const INDUSTRY_WORD: Readonly<Record<string, readonly [string, string]>> = {
  electronics: ['电子', '전자'], battery: ['能源', '에너지'], auto: ['汽车', '모터스'], machinery: ['机械', '기계'], chemicals: ['化工', '케미칼'],
  ecommerce: ['电商', '이커머스'], retail: ['零售', '리테일'], logistics: ['物流', '물류'], trade: ['贸易', '무역'], finance: ['金融', '파이낸스'],
  it_software: ['科技', '테크'], gaming: ['游戏', '게임즈'], consumer: ['日化', '생활'], food: ['食品', '식품'], travel: ['旅行', '트래블'], other: ['实业', '실업'],
};
const SURNAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권'];
const GIVEN_A = ['서', '민', '지', '현', '도', '하', '예', '시', '유', '채', '수', '은', '태', '준', '우'];
const GIVEN_B = ['윤', '준', '아', '연', '원', '호', '린', '빈', '율', '희', '진', '솔'];

/** 직무 묶음 (role_category code 마다 제목·업무·요건의 중국어 원문과 한국어). 숫자는 양쪽에 같게 적는다 (digitDiff 경고가 나지 않게). */
interface Family {
  role: string;
  titles: ReadonlyArray<readonly [string, string]>;
  duties: ReadonlyArray<readonly [string, string]>;
  reqs: ReadonlyArray<readonly [string, string]>;
  /** 이력서용 (한국어만) */
  resume: { title: string; desired: string; headline: string; exp: readonly string[] };
}
const FAMILIES: readonly Family[] = [
  {
    role: 'sales',
    titles: [['韩国市场销售经理', '한국 시장 영업 매니저'], ['大客户销售专员', '대형 고객 영업 담당'], ['渠道销售主管', '채널 영업 리더']],
    duties: [['开拓韩国本地客户，完成季度签约目标', '국내 고객을 발굴하고 분기 계약 목표를 달성합니다'], ['向客户介绍产品并整理客户需求', '고객에게 제품을 소개하고 요구 사항을 정리합니다'],
      ['管理销售漏斗与客户档案', '영업 파이프라인과 고객 기록을 관리합니다'], ['配合总部制定韩国市场价格政策', '본사와 함께 한국 시장 가격 정책을 만듭니다']],
    reqs: [['3年以上B2B销售经验', 'B2B 영업 경력 3년 이상'], ['有经销商管理经验者优先', '대리점 관리 경험이 있으면 우대'], ['具备良好的沟通能力', '원활한 소통 능력']],
    resume: { title: '영업직 지원용', desired: '영업 매니저', headline: 'B2B 영업 경력, 신규 고객 발굴과 계약 관리', exp: ['유통 거래처 신규 발굴과 계약 진행', '분기 영업 목표 관리와 보고', '해외 거래처와 견적·계약 협의'] },
  },
  {
    role: 'finance',
    titles: [['财务会计专员', '재무·회계 담당'], ['税务会计主管', '세무 회계 리더'], ['成本会计', '원가 회계 담당']],
    duties: [['负责月度结账与凭证整理', '월 결산과 증빙 정리를 맡습니다'], ['配合税务申报与外部审计', '세무 신고와 외부 감사 대응을 지원합니다'],
      ['按总部格式编制管理报表', '본사 양식에 맞춰 관리 보고서를 만듭니다'], ['管理应收应付账款', '매출·매입 채권 채무를 관리합니다']],
    reqs: [['3年以上会计经验', '회계 경력 3년 이상'], ['了解韩国税务与4项社会保险', '한국 세무와 4대 보험에 대한 이해'], ['熟练使用电子表格', '스프레드시트 활용 능숙']],
    resume: { title: '회계직 지원용', desired: '재무·회계', headline: '법인 결산과 세무 신고 실무 경험', exp: ['월 결산과 부가세 신고 실무', '본사 보고용 관리 회계 보고서 작성', '외부 감사 자료 준비'] },
  },
  {
    role: 'translation',
    titles: [['中韩翻译专员', '중한 통번역 담당'], ['商务口译', '비즈니스 통역사'], ['技术文档翻译', '기술 문서 번역 담당']],
    duties: [['合同及内部资料的中韩互译', '계약서와 내부 자료의 중한 번역'], ['总部与韩国合作方会议的口译', '본사와 한국 협력사 회의 통역'],
      ['整理并维护公司术语表', '회사 용어집을 정리하고 관리합니다'], ['审校外部翻译稿件', '외부 번역 원고를 검수합니다']],
    reqs: [['中文与韩文均可流利使用', '중국어와 한국어 모두 유창'], ['2年以上翻译或口译经验', '번역 또는 통역 경력 2년 이상'], ['有行业文件翻译经验者优先', '업계 문서 번역 경험 우대']],
    resume: { title: '통번역 지원용', desired: '통번역', headline: '중한 통번역 경력, 계약서·회의 통역 경험', exp: ['계약서·사내 문서 중한 번역', '본사 회의 순차 통역', '용어집 정리와 번역 검수'] },
  },
  {
    role: 'it',
    titles: [['后端开发人员', '백엔드 개발자'], ['前端开发人员', '프론트엔드 개발자'], ['IT运维专员', 'IT 운영 담당']],
    duties: [['开发并维护业务系统接口', '업무 시스템 API 를 개발하고 유지보수합니다'], ['配合韩国本地支付与电子发票对接', '국내 결제와 전자세금계산서 연동을 맡습니다'],
      ['管理办公网络与员工电脑', '사무실 네트워크와 직원 PC 를 관리합니다'], ['编写技术文档并参与代码评审', '기술 문서를 쓰고 코드 리뷰에 참여합니다']],
    reqs: [['3年以上开发或运维经验', '개발 또는 운영 경력 3년 이상'], ['熟悉关系型数据库', '관계형 데이터베이스에 익숙한 분'], ['技术文档以英文为主', '기술 문서는 주로 영어입니다']],
    resume: { title: '개발직 지원용', desired: 'IT·개발', headline: '웹 서비스 개발과 운영 경력', exp: ['주문·결제 API 개발과 운영', '사내 시스템 유지보수', '코드 리뷰와 기술 문서 작성'] },
  },
  {
    role: 'engineering',
    titles: [['品质管理专员', '품질관리 담당'], ['供应商质量主管', '협력사 품질 리더'], ['质量体系专员', '품질 시스템 담당']],
    duties: [['负责来料检验与出货检验', '수입 검사와 출하 검사를 맡습니다'], ['处理客户质量投诉并跟进改善', '고객 품질 불만을 처리하고 개선을 챙깁니다'],
      ['维护质量管理体系文件', '품질 경영 시스템 문서를 관리합니다'], ['定期走访韩国协力厂商', '국내 협력사를 정기적으로 방문합니다']],
    reqs: [['3年以上质量管理经验', '품질관리 경력 3년 이상'], ['熟悉质量体系认证流程', '품질 인증 절차에 익숙한 분'], ['可配合出差', '출장 가능']],
    resume: { title: '품질관리 지원용', desired: '품질관리', headline: '제조 품질관리와 협력사 관리 경력', exp: ['수입·출하 검사 기준 운영', '고객 품질 불만 대응과 개선 보고', '협력사 품질 점검'] },
  },
  {
    role: 'logistics',
    titles: [['物流协调员', '물류 코디네이터'], ['仓储主管', '창고 운영 리더'], ['报关专员', '통관 담당']],
    duties: [['跟进中韩海运与空运货物', '한중 해상·항공 화물을 챙깁니다'], ['与客户和承运商沟通货物状态', '고객·운송사와 화물 상태를 소통합니다'],
      ['管理仓库出入库与库存盘点', '창고 입출고와 재고 실사를 관리합니다'], ['准备报关资料', '통관 서류를 준비합니다']],
    reqs: [['2年以上物流或货代经验', '물류 또는 포워딩 경력 2년 이상'], ['熟悉进出口流程', '수출입 절차에 익숙한 분'], ['有仓储管理经验者优先', '창고 관리 경험 우대']],
    resume: { title: '물류직 지원용', desired: '물류', headline: '포워딩과 통관 실무 경력', exp: ['해상·항공 화물 선적 관리', '통관 서류 준비와 관세사 협업', '창고 재고 관리'] },
  },
  {
    role: 'hr',
    titles: [['人事专员', '인사 담당'], ['招聘主管', '채용 리더'], ['薪酬福利专员', '급여·복리후생 담당']],
    duties: [['负责招聘、入职与劳动合同管理', '채용, 입사, 근로계약 관리를 맡습니다'], ['制定并维护就业规则与考勤制度', '취업규칙과 근태 제도를 만들고 관리합니다'],
      ['核算月度薪资与社会保险', '월 급여와 4대 보험을 계산합니다'], ['组织新员工培训', '신입 직원 교육을 준비합니다']],
    reqs: [['3年以上人事经验', '인사 경력 3년 이상'], ['熟悉韩国劳动法', '한국 노동법에 익숙한 분'], ['做事细致', '꼼꼼한 업무 처리']],
    resume: { title: '인사직 지원용', desired: '인사', headline: '채용·급여·노무 실무 경력', exp: ['채용 공고 운영과 면접 일정 관리', '월 급여와 4대 보험 처리', '취업규칙 개정 실무'] },
  },
  {
    role: 'marketing',
    titles: [['品牌营销经理', '브랜드 마케팅 매니저'], ['线上营销专员', '온라인 마케팅 담당'], ['内容营销主管', '콘텐츠 마케팅 리더']],
    duties: [['策划韩国市场品牌活动', '한국 시장 브랜드 행사를 기획합니다'], ['运营官方社交媒体账号', '공식 SNS 계정을 운영합니다'],
      ['分析广告投放效果', '광고 집행 성과를 분석합니다'], ['撰写产品介绍与案例文章', '제품 소개와 사례 글을 씁니다']],
    reqs: [['3年以上营销经验', '마케팅 경력 3년 이상'], ['熟悉韩国主要线上渠道', '국내 주요 온라인 채널에 익숙한 분'], ['有数据分析能力', '데이터 분석 능력']],
    resume: { title: '마케팅 지원용', desired: '마케팅', headline: '브랜드 캠페인과 온라인 광고 운영 경력', exp: ['SNS 채널 운영과 콘텐츠 기획', '온라인 광고 성과 분석', '브랜드 행사 기획'] },
  },
  {
    role: 'operations',
    titles: [['生产计划专员', '생산계획 담당'], ['生产管理主管', '생산관리 리더'], ['运营管理专员', '운영 관리 담당']],
    duties: [['制定月度生产计划并跟进进度', '월 생산 계획을 세우고 진행을 챙깁니다'], ['协调采购、仓储与生产部门', '구매·창고·생산 부서를 조율합니다'],
      ['统计产量与交期数据', '생산량과 납기 자료를 집계합니다'], ['向总部报告运营情况', '본사에 운영 현황을 보고합니다']],
    reqs: [['3年以上生产管理或运营经验', '생산관리 또는 운영 경력 3년 이상'], ['熟悉制造业流程', '제조업 업무 흐름에 익숙한 분'], ['能熟练使用办公软件', '사무 프로그램 활용 능숙']],
    resume: { title: '생산관리 지원용', desired: '생산관리', headline: '생산계획과 납기 관리 경력', exp: ['월 생산 계획 수립과 진척 관리', '구매·창고 부서 일정 조율', '생산 실적 보고'] },
  },
  {
    role: 'legal',
    titles: [['法务专员', '법무 담당'], ['合规主管', '컴플라이언스 리더'], ['合同管理专员', '계약 관리 담당']],
    duties: [['审核各类商务合同', '각종 거래 계약서를 검토합니다'], ['跟进韩国法人的合规事项', '한국 법인의 준법 사항을 챙깁니다'],
      ['与外部律师事务所沟通', '외부 법률 사무소와 소통합니다'], ['管理公司印章与合同档案', '회사 인감과 계약 문서를 관리합니다']],
    reqs: [['3年以上法务经验', '법무 경력 3년 이상'], ['熟悉韩国商法与劳动法', '한국 상법과 노동법에 익숙한 분'], ['有外资企业经验者优先', '외국계 기업 경험 우대']],
    resume: { title: '법무직 지원용', desired: '법무', headline: '계약 검토와 준법 업무 경력', exp: ['거래 계약서 검토와 수정', '사내 규정 정비', '외부 법률 사무소 협업'] },
  },
  {
    role: 'customer',
    titles: [['客户服务专员', '고객 응대 담당'], ['客服组长', '고객 응대 리더']],
    duties: [['处理客户咨询与退换货', '고객 문의와 교환·환불을 처리합니다'], ['整理常见问题并改进答复模板', '자주 묻는 질문을 정리하고 답변 양식을 고칩니다'],
      ['统计客户反馈并向产品团队报告', '고객 의견을 집계해 제품팀에 보고합니다']],
    reqs: [['1年以上客服经验', '고객 응대 경력 1년 이상'], ['态度亲切', '친절한 응대'], ['可轮班工作', '교대 근무 가능']],
    resume: { title: '고객 응대 지원용', desired: '고객 응대', headline: '고객 문의 응대와 상담 품질 관리 경력', exp: ['전화·채팅 문의 응대', '교환·환불 처리', '답변 양식 개선'] },
  },
  {
    role: 'purchasing',
    titles: [['采购专员', '구매 담당'], ['采购主管', '구매 리더']],
    duties: [['寻找并评估韩国本地供应商', '국내 공급업체를 찾고 평가합니다'], ['负责询价、比价与下单', '견적 요청, 가격 비교, 발주를 맡습니다'], ['跟进交货与付款', '납품과 대금 지급을 챙깁니다']],
    reqs: [['2年以上采购经验', '구매 경력 2년 이상'], ['有谈判能力', '협상 능력'], ['熟悉进口流程者优先', '수입 절차를 알면 우대']],
    resume: { title: '구매직 지원용', desired: '구매', headline: '원부자재 구매와 협력사 관리 경력', exp: ['공급업체 발굴과 단가 협상', '발주와 납기 관리', '구매 실적 보고'] },
  },
  {
    role: 'admin',
    titles: [['行政专员', '총무·사무 담당'], ['总务主管', '총무 리더']],
    duties: [['办公室日常行政与来访接待', '사무실 일상 총무와 방문객 응대'], ['管理办公用品采购', '사무용품 구매를 관리합니다'], ['协助总部人员来韩出差安排', '본사 직원의 한국 출장 준비를 돕습니다']],
    reqs: [['1年以上行政经验', '총무 경력 1년 이상'], ['做事细致', '꼼꼼한 업무 처리'], ['可进行基础电脑操作', '기본 컴퓨터 활용 가능']],
    resume: { title: '사무직 지원용', desired: '총무·사무', headline: '사무실 총무와 출장 지원 경력', exp: ['사무실 시설·비품 관리', '방문객 응대와 회의 준비', '출장 일정 지원'] },
  },
];

/** 공통 근무 조건 문장 [중국어, 한국어]. */
const PERKS: ReadonlyArray<readonly [string, string]> = [
  ['试用期3个月，试用期薪资相同', '수습 3개월, 수습 기간 급여 동일'], ['每周可远程办公1天', '주 1일 재택근무 가능'], ['弹性上下班', '시차 출퇴근'],
  ['提供午餐补贴', '점심 식대 지원'], ['入职第1年起年假15天', '입사 첫해부터 연차 15일'], ['每年提供体检', '매년 건강검진 지원'],
];
const CN_LINE: Readonly<Record<string, readonly [string, string]>> = {
  none: ['不要求中文', '중국어는 필요하지 않습니다'], basic: ['可进行基础中文沟通', '기초 중국어 소통 가능'],
  business: ['能用中文进行商务沟通', '중국어로 업무 소통 가능'], native: ['中文达到母语或接近母语水平', '중국어 원어민 또는 그에 가까운 수준'],
};
const REPORT_LINE: Readonly<Record<string, readonly [string, string]>> = {
  kr_head: ['向韩国负责人汇报', '한국 책임자에게 보고합니다'], cn_hq: ['直接向中国总部汇报', '중국 본사에 직접 보고합니다'],
};
const STAGE_KO: Readonly<Record<string, string>> = {
  preparing: '한국 법인 설립을 준비하고 있습니다.', just_established: '최근 한국 법인을 세우고 조직을 만들고 있습니다.', operating: '한국에서 사업을 운영하고 있습니다.',
};
/** 기술유출 필터(rules.techLeakFlag)에 일부러 걸리는 예시. 자동 게재되지 않고 관리자 검토 대기로 남는다. */
const TECH_LEAK: Readonly<{ title: readonly [string, string]; duty: readonly [string, string] }> = {
  title: ['电池工艺工程师（研发）', '배터리 공정 엔지니어 (연구개발)'],
  duty: ['负责电池工艺研发与验证', '배터리 공정 연구개발과 검증을 맡습니다'],
};

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
  id: string; jobId: string; seekerId: string; resumeId: string; snapshot: string; fileKey: string | null; filePlain: Uint8Array | null;
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

  const industries = activeOf(ctx.options, 'industry');
  const roles = new Set(activeOf(ctx.options, 'role_category').map((o) => o.code));
  const locations = activeOf(ctx.options, 'location');
  const families = FAMILIES.filter((f) => roles.has(f.role));
  if (!industries.length || !locations.length || !families.length) throw new Error('bulk: no active options');
  const inactive = { role: new Set(inactiveOf(ctx.options, 'role_category').map((o) => o.code)), industry: inactiveOf(ctx.options, 'industry'), location: inactiveOf(ctx.options, 'location') };

  // ── 기업·담당자·서류
  const brands = BRAND_A.flatMap((a) => BRAND_B.map((b) => [a, b] as const));
  r.shuffle(brands);
  const companies: BulkCompanyRow[] = [];
  const members: BulkMemberRow[] = [];
  const docs: BulkDocRow[] = [];
  const docFiles: BulkPlan['docFiles'] = [];
  const docPdf = demoDocPdf();
  const membersOf = new Map<string, BulkMemberRow[]>();
  const companyWeight: number[] = [];
  for (let i = 1; i <= params.companies; i++) {
    const id = bulkId(2, i);
    const [[az, ak], [bz, bk]] = brands[(i - 1) % brands.length]!;
    const series = i > brands.length ? ` ${Math.ceil(i / brands.length)}` : '';
    const ind = industries[(i * 7) % industries.length]!;
    const [iz, ik] = INDUSTRY_WORD[ind.code] ?? INDUSTRY_WORD.other!;
    const entity: 'kr_entity' | 'cn_hq' = r.chance(0.12) ? 'cn_hq' : 'kr_entity';
    const stage = entity === 'cn_hq' ? 'preparing' : r.pick(ENTRY_STAGES);
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
    companies.push({
      id, name_ko: `${ak}${bk}${ik}${entity === 'kr_entity' ? '코리아' : ''}${series} (가상)`, name_zh: `${az}${bz}${iz}${entity === 'kr_entity' ? '韩国' : ''}${series}（虚拟）`,
      biz_no: bizNo, entity_type: entity, hq_name: `${az}${bz}${iz}有限公司${series}（虚拟）`, entry_stage: stage, industry: ind.label_ko,
      profile_ko: `※ 대량 테스트용 가상 기업입니다. 실제 기업이 아니며 공고도 예시입니다.\n\n${ind.label_ko} 분야의 중국 기업입니다. ${STAGE_KO[stage]}`,
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
  const companyById = new Map(companies.map((c) => [c.id, c]));

  // ── 공고
  const cumC: number[] = [];
  companyWeight.reduce((s, w, i) => (cumC[i] = s + w), 0);
  const pickCompany = (): BulkCompanyRow => {
    const x = r() * cumC[cumC.length - 1]!;
    let lo = 0, hi = cumC.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumC[mid]! < x) lo = mid + 1; else hi = mid; }
    return companies[lo]!;
  };
  const jobs: PlannedJob[] = [];
  for (let n = 1; n <= params.jobs; n++) {
    const co = pickCompany();
    const ms = membersOf.get(co.id)!;
    const author = r.pick(ms);
    const fam = r.pick(families);
    const x = r();
    const want: JobWant = x < 0.01 ? 'tech' : x < 0.03 ? 'blocked' : x < 0.06 ? 'draft' : x < 0.08 ? 'review' : x < 0.17 ? 'closed' : 'open';
    const [tz, tk] = want === 'tech' ? TECH_LEAK.title : r.pick(fam.titles);
    const senior = want !== 'tech' && r.chance(0.2);
    const loc = inactive.location.length && r.chance(0.02) ? r.pick(inactive.location) : r.pick(locations);
    const indCode = inactive.industry.length && r.chance(0.02) ? r.pick(inactive.industry).code
      : (industries.find((o) => o.label_ko === co.industry) ?? r.pick(industries)).code;
    const cn = r.pick(['none', 'basic', 'basic', 'business', 'business', 'business', 'native'] as const);
    const report = co.entity_type === 'cn_hq' || r.chance(0.3) ? 'cn_hq' as const : 'kr_head' as const;
    const duties = r.shuffle([...fam.duties]).slice(0, r.int(2, 3));
    if (want === 'tech') duties.unshift(TECH_LEAK.duty);
    const reqs = r.shuffle([...fam.reqs]).slice(0, 2);
    const perks = r.shuffle([...PERKS]).slice(0, r.int(1, 3));
    const zh = lines('【岗位职责】', ...duties.map(([z]) => `- ${z}`), `- ${REPORT_LINE[report]![0]}`,
      '【任职要求】', ...reqs.map(([z]) => `- ${z}`), `- ${CN_LINE[cn]![0]}`,
      '【工作条件】', `- 工作地点：${loc.label_zh}`, ...perks.map(([z]) => `- ${z}`));
    const ko = lines('[담당 업무]', ...duties.map(([, k]) => `- ${k}`), `- ${REPORT_LINE[report]![1]}`,
      '[자격 요건]', ...reqs.map(([, k]) => `- ${k}`), `- ${CN_LINE[cn]![1]}`,
      '[근무 조건]', `- 근무지: ${loc.label_ko}`, ...perks.map(([, k]) => `- ${k}`));
    const title_zh = `${senior ? '资深' : ''}${tz}`;
    const title_ko = `${senior ? '시니어 ' : ''}${tk}`;
    // 연봉: 30% 협의(숫자 없음, 그중 절반은 퇴직금 기준만 적음), 나머지는 범위 + 퇴직금 포함/별도
    const negotiable = r.chance(0.3);
    const smin = negotiable ? null : r.int(28, 80) * 100;
    const smax = smin === null ? null : smin + r.int(3, 20) * 100;
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
  }

  // ── 구직자·이력서
  const resumes: BulkResumeRow[] = [];
  const resumeFiles: BulkPlan['resumeFiles'] = [];
  const seekerResume: Array<{ seekerId: string; resumeId: string; body: ResumeBody; filePlain: Uint8Array | null; created: number }> = [];
  let fileNo = 0;
  for (let s = 1; s <= params.seekers; s++) {
    const email = `seeker${pad(s, 4)}@${BULK_MAIL_DOMAIN}`;
    const created = ago(r.int(95, 130));
    const uid = addUser(email, 'seeker', r.chance(0.1) ? 'zh' : 'ko', created);
    if (!r.chance(250 / 300)) continue;
    const fam = r.pick(FAMILIES);
    const years = r.chance(0.12) ? 0 : r.int(1, 18);
    const level = r.pick(['none', 'basic', 'business', 'business', 'native'] as const) as ResumeChineseLevel;
    const withFile = r.chance(0.3);
    const withExp = !withFile || r.chance(0.7); // 첨부도 경력 요약도 없는 이력서는 지원할 수 없으므로 만들지 않는다
    const since = 2026 - Math.max(years, 1);
    const exp = withExp ? lines(
      ...r.shuffle([...fam.resume.exp]).slice(0, 2).map((e, k) => `- ${k === 0 ? `${since}~현재` : `${since - 2}~${since}`} 가상기업 ${'ABCDEFGH'[r.int(0, 7)]}사: ${e}`),
      `- 중국어: ${{ none: '못함', basic: '기초 회화', business: '업무 소통 가능', native: '원어민 수준' }[level]}`,
    ) : null;
    let filePlain: Uint8Array | null = null;
    let fileKey: string | null = null;
    let meta: ResumeBody['file'] = null;
    if (withFile) {
      fileNo += 1;
      filePlain = fakeResumePdf(fileNo);
      fileKey = resumeFileKey(fileNo);
      meta = { name: r.chance(0.5) ? '경력기술서.pdf' : 'resume.pdf', ext: 'pdf', mime: 'application/pdf', size: filePlain.length };
      resumeFiles.push({ key: fileKey, plain: filePlain });
    }
    const body: ResumeBody = {
      v: 1, name: `${r.pick(SURNAMES)}${r.pick(GIVEN_A)}${r.pick(GIVEN_B)}(가상)`, chinese_level: level, years,
      headline: `${fam.resume.headline}${years ? ` ${years}년` : ' (신입)'}`.slice(0, 100), contact_email: email,
      phone: r.chance(0.6) ? `010-0000-${pad(s % 10000, 4)}` : null, desired_role: fam.resume.desired, experience_text: exp, file: meta,
    };
    const rid = bulkId(4, s);
    resumes.push({ id: rid, user_id: uid, title: fam.resume.title, is_default: 1, body: await sealResume(ctx.encKey, body), file_r2_key: fileKey, created_at: created + 3600, updated_at: created + 7200 });
    seekerResume.push({ seekerId: uid, resumeId: rid, body, filePlain, created });
  }

  // ── 지원: 지금 공개 목록에 보이는 공고(게재될 공고)에만. 인기 공고와 지원 없는 공고가 함께 있게 가중치를 준다.
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
  const applications: PlannedApplication[] = [];
  const keepDays = ctx.retention.application_keep_days;
  const used = new Set<string>();
  let appNo = 0, appFileNo = 0, attempts = 0;
  while (applications.length < params.applications && totalW > 0 && seekerResume.length && attempts++ < params.applications * 30) {
    const job = pickJob();
    const sk = r.pick(seekerResume);
    const pair = `${job.row.id}|${sk.seekerId}`;
    if (used.has(pair)) continue;
    const until = Math.min(job.closeAt ?? now, now) - 120;
    const from = Math.max(job.publishAt!, sk.created + 3 * 3600);
    if (until <= from) continue;
    used.add(pair);
    const ts = from + Math.floor(r() * (until - from));
    const fields = { name: sk.body.name, chinese_level: sk.body.chinese_level, years: sk.body.years, headline: sk.body.headline, contact_email: sk.body.contact_email,
      phone: sk.body.phone, desired_role: sk.body.desired_role, experience_text: sk.body.experience_text };
    const include = !!sk.filePlain && (!sk.body.experience_text || r.chance(0.85));
    const snapshot = buildSnapshot(sk.body, fields, { include, copied: include });
    const consentGiven = job.need === 'required' ? true : job.need === 'optional' ? r.chance(0.6) : false;
    // 실제 지원과 같은 판단 (lib/application.applyBlocks). 막히면 넣지 않는다.
    if (applyBlocks({ canApply: true, jobVisible: true, alreadyApplied: false, resumeReady: resumeReadyToApply(snapshot), consentNeed: job.need, consentGiven }).length) continue;
    appNo += 1;
    let fileKey: string | null = null;
    if (include) { appFileNo += 1; fileKey = applicationFileKey(appFileNo); }
    const consent = consentAt(job.need, consentGiven, ts);
    const app: PlannedApplication = {
      id: bulkId(5, appNo), jobId: job.row.id, seekerId: sk.seekerId, resumeId: sk.resumeId, snapshot: await sealResume(ctx.encKey, snapshot),
      fileKey, filePlain: include ? sk.filePlain : null, consentAt: consent, consentVersion: crossBorderVersion(keepDays), ts, keepDays, events: [],
    };
    // 이후 이벤트 계획 (시각은 차례로 늘어난다). 회사 쪽 이벤트를 낸 사람은 그 지원서를 볼 수 있는 담당자다 (authz.canViewApplication).
    const ref = { seeker_id: sk.seekerId, job: { company_id: job.row.company_id, agency_id: null, created_by: job.row.created_by }, cross_border_consent_at: consent, status: 'submitted' };
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
    if (!app.events.some((e) => e.event === 'reject_mail') && r.chance(0.05)) push('withdrawn', sk.seekerId);
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
    resumes: p.resumes.length, resume_files: p.resumeFiles.length, applications: p.applications.length,
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
      id: a.id, jobId: a.jobId, seekerId: a.seekerId, resumeId: a.resumeId, snapshot: a.snapshot, fileKey: a.fileKey,
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

