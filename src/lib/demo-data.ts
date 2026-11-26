// 시연 데이터 원본 (테스트 서버·로컬 개발 전용). 모두 지어낸 것이다 — 실제 기업·사람·연락처가 아니다 (CLAUDE.md 규칙 10).
// 여기에는 "무엇을 넣을지" 만 적는다. 게재·승인·지원 상태 같은 판단은 lib/demo-seed.ts 가 rules.ts 의 함수로 한다
// (publishBlocks · verifyBlocks · nextStatus · techLeakFlag) — 이 파일에 status 를 직접 적지 않는다.
// 내용을 바꾸면 lib/demo.ts 의 DEMO_SEED_VERSION 을 올린다. test/demo.test.ts 가 모든 항목을 폼 검사(validateJob 등)에 통과시킨다.
import type { Locale } from '../env';
import { DEMO_MAIL_DOMAIN, demoId, type DemoRole } from './demo';
import type { AppEvent } from './rules';
import type { ResumeBody } from './resume';

const U = (n: number) => demoId(1, n);
const C = (n: number) => demoId(2, n);
const J = (n: number) => demoId(3, n);
const R = (n: number) => demoId(4, n);
const A = (n: number) => demoId(5, n);
const mail = (local: string, sub?: string) => `${local}@${sub ? `${sub}.` : ''}${DEMO_MAIL_DOMAIN}`;

// ── 회원. 1~4 구직자, 11~16 기업 담당자. 로그인 화면에 보이는 계정은 lib/demo.DEMO_ACCOUNTS (id·이메일·역할이 같아야 한다 — 테스트가 확인).
export interface DemoUser { id: string; email: string; role: DemoRole; locale: Locale }

export const DEMO_USERS: readonly DemoUser[] = [
  { id: U(1), email: mail('seeker.kim'), role: 'seeker', locale: 'ko' },
  { id: U(2), email: mail('seeker.lee'), role: 'seeker', locale: 'ko' },
  { id: U(3), email: mail('seeker.park'), role: 'seeker', locale: 'ko' },
  { id: U(4), email: mail('seeker.choi'), role: 'seeker', locale: 'ko' },
  { id: U(11), email: mail('hr', 'lanhai'), role: 'company', locale: 'ko' },
  { id: U(12), email: mail('hq', 'lanhai'), role: 'company', locale: 'zh' },
  { id: U(13), email: mail('hq', 'jincheng'), role: 'company', locale: 'zh' },
  { id: U(14), email: mail('hr', 'xingyuan'), role: 'company', locale: 'ko' },
  { id: U(15), email: mail('owner', 'hechang'), role: 'company', locale: 'ko' },
  { id: U(16), email: mail('hr', 'yunfeng'), role: 'company', locale: 'ko' },
];

// ── 기업
export interface DemoCompany {
  id: string;
  name_ko: string;
  name_zh: string;
  entity_type: 'kr_entity' | 'cn_hq';
  /** 한국 사업자등록번호 자리. 000 으로 시작하는(실제 세무서 코드가 아닌) 검사 통과용 가짜 번호. cn_hq 는 null. */
  biz_no: string | null;
  hq_name: string;
  entry_stage: 'preparing' | 'just_established' | 'operating';
  industry: string;
  profile_ko: string;
  /** 운영자 확인을 마친 기업으로 넣을 것인가. 실제 값은 rules.verifyBlocks 를 통과할 때만 verified 가 된다. */
  wantVerified: boolean;
  members: ReadonlyArray<{ userId: string; member_role: 'owner' | 'member'; is_hq: 0 | 1 }>;
}

const NOTE = '※ 시연용 가상 기업입니다. 실제 기업이 아니며 공고도 예시입니다.';

export const DEMO_COMPANIES: readonly DemoCompany[] = [
  {
    id: C(1), name_ko: '란하이테크코리아 (예시)', name_zh: '蓝海科技韩国（示例）', entity_type: 'kr_entity', biz_no: '0000000015',
    hq_name: '蓝海科技有限公司（示例）', entry_stage: 'operating', industry: 'IT·소프트웨어',
    profile_ko: `${NOTE}\n\n매장 운영에 쓰는 재고·주문 관리 소프트웨어를 만드는 회사의 한국 법인입니다. 서울 사무실에서 영업, 고객 지원, 개발 인력이 함께 일합니다.`,
    wantVerified: true,
    members: [{ userId: U(11), member_role: 'owner', is_hq: 0 }, { userId: U(12), member_role: 'member', is_hq: 1 }],
  },
  {
    id: C(2), name_ko: '진청물류 (예시)', name_zh: '金程物流（示例）', entity_type: 'cn_hq', biz_no: null,
    hq_name: '金程国际物流有限公司（示例）', entry_stage: 'preparing', industry: '물류',
    profile_ko: `${NOTE}\n\n한국 법인 설립을 준비하고 있는 국제 물류 회사입니다. 인천을 거점으로 한중 화물 운송과 통관 업무를 시작할 예정이며, 지금은 중국 본사에서 직접 채용합니다.`,
    wantVerified: true,
    members: [{ userId: U(13), member_role: 'owner', is_hq: 1 }],
  },
  {
    id: C(3), name_ko: '싱위안뷰티코리아 (예시)', name_zh: '星源美妆韩国（示例）', entity_type: 'kr_entity', biz_no: '0000000029',
    hq_name: '星源美妆集团（示例）', entry_stage: 'just_established', industry: '소비재',
    profile_ko: `${NOTE}\n\n올해 한국 법인을 세운 화장품 회사입니다. 온라인 판매 채널 운영과 고객 응대 조직을 새로 만들고 있습니다.`,
    wantVerified: true,
    members: [{ userId: U(14), member_role: 'owner', is_hq: 0 }],
  },
  {
    id: C(4), name_ko: '윈펑게임즈코리아 (예시)', name_zh: '云峰游戏韩国（示例）', entity_type: 'kr_entity', biz_no: '0000000034',
    hq_name: '云峰互动娱乐（示例）', entry_stage: 'operating', industry: '게임',
    profile_ko: `${NOTE}\n\n모바일 게임을 한국에 서비스하는 회사입니다. 현지화, 마케팅, 운영을 서울 사무실에서 맡습니다.`,
    wantVerified: true,
    members: [{ userId: U(16), member_role: 'owner', is_hq: 0 }],
  },
  {
    // 운영자 확인 전의 기업: 공고를 초안으로만 쓸 수 있는 상태를 보여 준다.
    id: C(5), name_ko: '허창식품코리아 (예시)', name_zh: '禾昌食品韩国（示例）', entity_type: 'kr_entity', biz_no: '0000000048',
    hq_name: '禾昌食品有限公司（示例）', entry_stage: 'just_established', industry: '식품',
    profile_ko: `${NOTE}\n\n방금 가입해 아직 사업자 서류 확인을 받지 않은 기업의 예시입니다.`,
    wantVerified: false,
    members: [{ userId: U(15), member_role: 'owner', is_hq: 0 }],
  },
];

// ── 공고
export interface DemoJob {
  id: string;
  companyId: string;
  createdBy: string;
  /** 넣고 싶은 모습. published 는 rules.publishBlocks 가 빈 배열일 때만 게재되고, 아니면 초안으로 남는다. */
  want: 'published' | 'draft' | 'closed';
  title_zh: string;
  source_zh: string;
  /** 한국어(현지화 결과를 기업이 확인한 것). null 이면 아직 현지화 전인 초안. */
  title_ko: string | null;
  body_ko: string | null;
  role_category: string;
  industry: string;
  location: string;
  salary_min: number | null;
  salary_max: number | null;
  salary_basis: 'severance_excluded' | 'severance_included' | null;
  work_hours: string | null;
  report_line: 'kr_head' | 'cn_hq';
  chinese_level: 'none' | 'basic' | 'business' | 'native';
  contact_email: string;
  /** 며칠 전에 게재했는가 (목록 순서용). */
  postedDaysAgo: number;
  /** 며칠 뒤 마감인가. null = 마감일 없음. */
  closesInDays: number | null;
}

const lines = (...s: string[]) => s.join('\n');
type JobCore = Omit<DemoJob, 'id' | 'companyId' | 'createdBy' | 'contact_email' | 'industry'>;
const jobsOf = (companyNo: number, ownerNo: number, contact: string, industry: string, start: number, list: JobCore[]): DemoJob[] =>
  list.map((j, i) => ({ ...j, id: J(start + i), companyId: C(companyNo), createdBy: U(ownerNo), contact_email: contact, industry }));

export const DEMO_JOBS: readonly DemoJob[] = [
  ...jobsOf(1, 11, mail('recruit', 'lanhai'), 'it_software', 1, [
    {
      want: 'published', postedDaysAgo: 1, closesInDays: 30,
      title_zh: '韩国市场销售经理', title_ko: '한국 시장 영업 매니저',
      source_zh: lines('【岗位职责】', '- 开拓韩国连锁零售与餐饮客户，完成季度签约目标', '- 向客户演示产品，并与总部产品团队沟通客户需求', '- 管理销售漏斗，每周向韩国负责人汇报',
        '【任职要求】', '- 5年以上B2B软件或解决方案销售经验', '- 能用中文进行商务沟通', '【工作条件】', '- 首尔办公室，周一至周五', '- 试用期3个月，试用期薪资相同'),
      body_ko: lines('[담당 업무]', '- 한국의 프랜차이즈 유통·외식 고객을 발굴하고 분기 계약 목표를 달성합니다', '- 고객에게 제품을 시연하고, 고객 요구를 본사 제품팀에 전달합니다', '- 영업 파이프라인을 관리하고 매주 한국 책임자에게 보고합니다',
        '[자격 요건]', '- B2B 소프트웨어 또는 솔루션 영업 경력 5년 이상', '- 중국어로 업무 소통 가능', '[근무 조건]', '- 서울 사무실, 월~금 근무', '- 수습 3개월, 수습 기간 급여 동일'),
      role_category: 'sales', location: 'seoul', salary_min: 5000, salary_max: 7000, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'business',
    },
    {
      want: 'published', postedDaysAgo: 3, closesInDays: 21,
      title_zh: '客户成功经理', title_ko: '고객 성공 매니저',
      source_zh: lines('【岗位职责】', '- 负责已签约客户的上线培训与日常答疑', '- 整理客户反馈，推动续约', '【任职要求】', '- 2年以上客户支持或运营经验', '- 中文可进行简单沟通者优先',
        '【工作条件】', '- 首尔办公室，每周可远程办公1天'),
      body_ko: lines('[담당 업무]', '- 계약한 고객의 도입 교육과 일상 문의 응대를 맡습니다', '- 고객 의견을 정리하고 계약 갱신을 이끕니다', '[자격 요건]', '- 고객 지원 또는 운영 경력 2년 이상', '- 간단한 중국어 소통이 가능하면 우대',
        '[근무 조건]', '- 서울 사무실, 주 1일 재택근무 가능'),
      role_category: 'customer', location: 'seoul', salary_min: 4000, salary_max: 5200, salary_basis: 'severance_excluded', work_hours: '09:30-18:30', report_line: 'kr_head', chinese_level: 'basic',
    },
    {
      want: 'published', postedDaysAgo: 5, closesInDays: null,
      title_zh: '后端开发人员', title_ko: '백엔드 개발자',
      source_zh: lines('【岗位职责】', '- 开发并维护订单与库存服务的接口', '- 配合韩国本地支付与电子发票的对接', '【任职要求】', '- 4年以上后端开发经验，熟悉任意一种主流语言与关系型数据库', '- 不要求中文，技术文档以英文为主',
        '【工作条件】', '- 首尔办公室，弹性上下班'),
      body_ko: lines('[담당 업무]', '- 주문·재고 서비스의 API 를 개발하고 유지보수합니다', '- 한국 결제와 전자세금계산서 연동을 맡습니다', '[자격 요건]', '- 백엔드 개발 경력 4년 이상, 주요 언어 하나와 관계형 데이터베이스에 익숙한 분', '- 중국어는 필요하지 않습니다. 기술 문서는 주로 영어입니다',
        '[근무 조건]', '- 서울 사무실, 시차 출퇴근'),
      role_category: 'it', location: 'seoul', salary_min: 6000, salary_max: 9000, salary_basis: 'severance_excluded', work_hours: '10:00-19:00', report_line: 'kr_head', chinese_level: 'none',
    },
    {
      want: 'published', postedDaysAgo: 8, closesInDays: 14,
      title_zh: '财务会计专员', title_ko: '재무·회계 담당',
      source_zh: lines('【岗位职责】', '- 负责韩国法人的月度结账、税务申报配合', '- 按总部格式编制管理报表，每月向总部财务汇报', '【任职要求】', '- 3年以上会计经验，了解韩国税务与4项社会保险', '- 能用中文阅读并撰写报表说明',
        '【工作条件】', '- 首尔办公室'),
      body_ko: lines('[담당 업무]', '- 한국 법인의 월 결산과 세무 신고 지원을 맡습니다', '- 본사 양식에 맞춰 관리 보고서를 만들고 매월 본사 재무팀에 보고합니다', '[자격 요건]', '- 회계 경력 3년 이상, 한국 세무와 4대 보험을 이해하는 분', '- 중국어로 보고서 설명을 읽고 쓸 수 있는 분',
        '[근무 조건]', '- 서울 사무실'),
      role_category: 'finance', location: 'seoul', salary_min: 4500, salary_max: 6000, salary_basis: 'severance_included', work_hours: '09:00-18:00', report_line: 'cn_hq', chinese_level: 'business',
    },
    {
      want: 'published', postedDaysAgo: 12, closesInDays: 40,
      title_zh: '内容营销经理', title_ko: '콘텐츠 마케팅 매니저',
      source_zh: lines('【岗位职责】', '- 策划并撰写面向韩国客户的案例文章与产品介绍', '- 运营官方博客与邮件通讯', '【任职要求】', '- 3年以上B2B内容营销经验', '- 不要求中文'),
      body_ko: lines('[담당 업무]', '- 한국 고객을 위한 사례 글과 제품 소개를 기획하고 씁니다', '- 공식 블로그와 뉴스레터를 운영합니다', '[자격 요건]', '- B2B 콘텐츠 마케팅 경력 3년 이상', '- 중국어는 필요하지 않습니다'),
      role_category: 'marketing', location: 'seoul', salary_min: null, salary_max: null, salary_basis: null, work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'none',
    },
    {
      // 기술유출 필터에 걸리는 예시: 자동으로 게재되지 않고 운영자 검토를 기다린다 (rules.techLeakFlag).
      want: 'published', postedDaysAgo: 0, closesInDays: null,
      title_zh: '显示驱动电路设计工程师', title_ko: '디스플레이 구동 회로설계 엔지니어',
      source_zh: lines('【岗位职责】', '- 负责显示驱动芯片相关电路的设计与验证', '【任职要求】', '- 5年以上相关研发经验'),
      body_ko: lines('[담당 업무]', '- 디스플레이 구동 칩 관련 회로의 설계와 검증을 맡습니다', '[자격 요건]', '- 관련 연구개발 경력 5년 이상'),
      role_category: 'engineering', location: 'gyeonggi', salary_min: 8000, salary_max: 12000, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'cn_hq', chinese_level: 'basic',
    },
    {
      want: 'closed', postedDaysAgo: 40, closesInDays: null,
      title_zh: '行政专员', title_ko: '총무·사무 담당',
      source_zh: lines('【岗位职责】', '- 办公室日常行政、采购与来访接待', '【任职要求】', '- 1年以上行政经验'),
      body_ko: lines('[담당 업무]', '- 사무실 일상 총무, 구매, 방문객 응대', '[자격 요건]', '- 총무 경력 1년 이상'),
      role_category: 'admin', location: 'seoul', salary_min: 3200, salary_max: 3800, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'basic',
    },
  ]),
  ...jobsOf(2, 13, mail('hr', 'jincheng'), 'logistics', 11, [
    {
      want: 'published', postedDaysAgo: 2, closesInDays: 45,
      title_zh: '韩国法人筹备运营经理', title_ko: '한국 법인 설립 준비 운영 매니저',
      source_zh: lines('【岗位职责】', '- 配合总部完成韩国法人设立、办公室与仓库选址', '- 搭建当地供应商与报关行合作关系', '- 法人设立后负责日常运营', '【任职要求】', '- 7年以上物流或贸易行业经验，有团队管理经验', '- 能用中文向总部汇报',
        '【说明】', '- 目前由中国总部直接招聘，简历将由总部负责人查阅'),
      body_ko: lines('[담당 업무]', '- 본사와 함께 한국 법인 설립, 사무실·창고 입지 선정을 진행합니다', '- 국내 협력사와 관세사 협력 관계를 만듭니다', '- 법인 설립 뒤에는 일상 운영을 책임집니다', '[자격 요건]', '- 물류 또는 무역 업계 경력 7년 이상, 팀 관리 경험', '- 중국어로 본사에 보고할 수 있는 분',
        '[안내]', '- 지금은 중국 본사가 직접 채용하며, 지원서는 본사 담당자가 열람합니다'),
      role_category: 'operations', location: 'incheon', salary_min: 5500, salary_max: 7500, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'cn_hq', chinese_level: 'business',
    },
    {
      want: 'published', postedDaysAgo: 4, closesInDays: 30,
      title_zh: '报关与物流协调员', title_ko: '통관·물류 코디네이터',
      source_zh: lines('【岗位职责】', '- 跟进中韩海运与空运货物的订舱、报关与派送', '- 与客户和承运商沟通货物状态', '【任职要求】', '- 2年以上货代或报关相关经验', '- 可进行基础中文沟通'),
      body_ko: lines('[담당 업무]', '- 한중 해상·항공 화물의 선적 예약, 통관, 배송을 챙깁니다', '- 고객·운송사와 화물 상태를 소통합니다', '[자격 요건]', '- 포워딩 또는 통관 관련 경력 2년 이상', '- 기초 중국어 소통 가능'),
      role_category: 'logistics', location: 'incheon', salary_min: 3800, salary_max: 4800, salary_basis: 'severance_excluded', work_hours: '08:30-17:30', report_line: 'cn_hq', chinese_level: 'basic',
    },
    {
      want: 'published', postedDaysAgo: 9, closesInDays: null,
      title_zh: '中韩翻译专员', title_ko: '중한 통번역 담당',
      source_zh: lines('【岗位职责】', '- 合同、报关文件及内部资料的中韩互译', '- 总部与韩国合作方会议的口译', '【任职要求】', '- 中文与韩文均达到母语或接近母语水平', '- 有物流或贸易文件翻译经验者优先'),
      body_ko: lines('[담당 업무]', '- 계약서, 통관 서류, 내부 자료의 중한 번역', '- 본사와 한국 협력사 회의 통역', '[자격 요건]', '- 중국어와 한국어 모두 원어민 또는 그에 가까운 수준', '- 물류·무역 문서 번역 경험 우대'),
      role_category: 'translation', location: 'seoul', salary_min: 3600, salary_max: 4500, salary_basis: 'severance_included', work_hours: '09:00-18:00', report_line: 'cn_hq', chinese_level: 'native',
    },
  ]),
  ...jobsOf(3, 14, mail('recruit', 'xingyuan'), 'consumer', 21, [
    {
      want: 'published', postedDaysAgo: 1, closesInDays: 25,
      title_zh: '电商运营（商品企划）', title_ko: '이커머스 운영 MD',
      source_zh: lines('【岗位职责】', '- 负责韩国主要电商平台店铺的商品上架、促销策划与销售分析', '- 与总部沟通库存与新品计划', '【任职要求】', '- 3年以上美妆或快消品电商运营经验', '- 可进行基础中文沟通者优先'),
      body_ko: lines('[담당 업무]', '- 국내 주요 온라인몰 스토어의 상품 등록, 행사 기획, 판매 분석을 맡습니다', '- 본사와 재고·신제품 계획을 소통합니다', '[자격 요건]', '- 화장품 또는 소비재 이커머스 운영 경력 3년 이상', '- 기초 중국어 소통이 가능하면 우대'),
      role_category: 'operations', location: 'seoul', salary_min: 4000, salary_max: 5500, salary_basis: 'severance_excluded', work_hours: '09:30-18:30', report_line: 'kr_head', chinese_level: 'basic',
    },
    {
      want: 'published', postedDaysAgo: 6, closesInDays: 20,
      title_zh: '人事专员', title_ko: '인사 담당',
      source_zh: lines('【岗位职责】', '- 负责招聘、入职与劳动合同管理', '- 制定并维护韩国法人的就业规则与考勤制度', '【任职要求】', '- 4年以上人事经验，熟悉韩国劳动法', '- 能用中文与总部人事沟通'),
      body_ko: lines('[담당 업무]', '- 채용, 입사, 근로계약 관리를 맡습니다', '- 한국 법인의 취업규칙과 근태 제도를 만들고 관리합니다', '[자격 요건]', '- 인사 경력 4년 이상, 한국 노동법에 익숙한 분', '- 중국어로 본사 인사팀과 소통할 수 있는 분'),
      role_category: 'hr', location: 'seoul', salary_min: 4500, salary_max: 6000, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'business',
    },
    {
      want: 'published', postedDaysAgo: 10, closesInDays: null,
      title_zh: '客服组长', title_ko: '고객 응대 리더',
      source_zh: lines('【岗位职责】', '- 管理客服团队，处理升级的客户咨询与退换货问题', '- 整理常见问题并改进答复模板', '【任职要求】', '- 3年以上客服经验，其中1年以上带组经验', '- 不要求中文'),
      body_ko: lines('[담당 업무]', '- 고객 응대 팀을 관리하고, 넘어온 문의와 교환·환불 건을 처리합니다', '- 자주 묻는 질문을 정리하고 답변 양식을 개선합니다', '[자격 요건]', '- 고객 응대 경력 3년 이상, 그중 팀 리더 경험 1년 이상', '- 중국어는 필요하지 않습니다'),
      role_category: 'customer', location: 'gyeonggi', salary_min: 3800, salary_max: 4600, salary_basis: 'severance_included', work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'none',
    },
  ]),
  ...jobsOf(4, 16, mail('jobs', 'yunfeng'), 'gaming', 31, [
    {
      want: 'published', postedDaysAgo: 2, closesInDays: 35,
      title_zh: '游戏本地化项目经理', title_ko: '게임 현지화 PM',
      source_zh: lines('【岗位职责】', '- 统筹游戏文本的韩文翻译、审校与版本更新排期', '- 管理外部翻译供应商并把控用语一致性', '【任职要求】', '- 3年以上游戏本地化或翻译项目管理经验', '- 中文达到母语或接近母语水平'),
      body_ko: lines('[담당 업무]', '- 게임 텍스트의 한국어 번역, 검수, 업데이트 일정을 총괄합니다', '- 외부 번역 업체를 관리하고 용어 일관성을 책임집니다', '[자격 요건]', '- 게임 현지화 또는 번역 프로젝트 관리 경력 3년 이상', '- 중국어 원어민 또는 그에 가까운 수준'),
      role_category: 'translation', location: 'seoul', salary_min: 5000, salary_max: 7000, salary_basis: 'severance_excluded', work_hours: '10:00-19:00', report_line: 'kr_head', chinese_level: 'native',
    },
    {
      want: 'published', postedDaysAgo: 7, closesInDays: 18,
      title_zh: '效果营销专员', title_ko: '퍼포먼스 마케터',
      source_zh: lines('【岗位职责】', '- 负责韩国市场的广告投放、素材测试与数据分析', '- 按周汇总投放效果并提出优化方案', '【任职要求】', '- 3年以上移动应用或游戏广告投放经验', '- 不要求中文'),
      body_ko: lines('[담당 업무]', '- 한국 시장의 광고 집행, 소재 테스트, 데이터 분석을 맡습니다', '- 매주 광고 성과를 정리하고 개선안을 냅니다', '[자격 요건]', '- 모바일 앱 또는 게임 광고 집행 경력 3년 이상', '- 중국어는 필요하지 않습니다'),
      role_category: 'marketing', location: 'seoul', salary_min: 4500, salary_max: 6500, salary_basis: 'severance_excluded', work_hours: '10:00-19:00', report_line: 'kr_head', chinese_level: 'none',
    },
    {
      want: 'published', postedDaysAgo: 14, closesInDays: null,
      title_zh: '法务专员', title_ko: '법무 담당',
      source_zh: lines('【岗位职责】', '- 审核合作与外包合同，处理游戏分级与用户条款相关事务', '- 与总部法务及外部律所协作', '【任职要求】', '- 5年以上企业法务经验', '- 能用中文审阅合同者优先'),
      body_ko: lines('[담당 업무]', '- 제휴·외주 계약을 검토하고, 게임 등급 분류와 이용약관 관련 업무를 처리합니다', '- 본사 법무팀, 외부 법무법인과 협업합니다', '[자격 요건]', '- 기업 법무 경력 5년 이상', '- 중국어로 계약서를 검토할 수 있으면 우대'),
      role_category: 'legal', location: 'seoul', salary_min: 6000, salary_max: 8000, salary_basis: 'severance_excluded', work_hours: '10:00-19:00', report_line: 'kr_head', chinese_level: 'business',
    },
  ]),
  ...jobsOf(5, 15, mail('owner', 'hechang'), 'food', 41, [
    {
      // 아직 한국어로 옮기지 않은 초안. 기업 확인 전이라 게재할 수도 없다.
      want: 'draft', postedDaysAgo: 0, closesInDays: null,
      title_zh: '韩国渠道销售专员', title_ko: null,
      source_zh: lines('【岗位职责】', '- 开拓韩国超市与便利店渠道', '【任职要求】', '- 2年以上食品或快消品销售经验'),
      body_ko: null,
      role_category: 'sales', location: 'seoul', salary_min: 3600, salary_max: 4500, salary_basis: 'severance_excluded', work_hours: '09:00-18:00', report_line: 'kr_head', chinese_level: 'basic',
    },
  ]),
];

// ── 이력서 (이름·연락처는 지어낸 것. 전화번호는 넣지 않는다)
export interface DemoResume { id: string; userId: string; title: string; isDefault: 0 | 1; body: Omit<ResumeBody, 'v' | 'file'> }

export const DEMO_RESUMES: readonly DemoResume[] = [
  {
    id: R(1), userId: U(1), title: '영업·사업개발용', isDefault: 1,
    body: {
      name: '김하준 (시연)', chinese_level: 'business', years: 6, headline: 'B2B 소프트웨어 영업 6년, 중국어 업무 소통 가능', contact_email: mail('seeker.kim'), phone: null,
      desired_role: '영업 매니저',
      experience_text: lines('2021~현재 (예시) 유통 솔루션 회사 영업 담당 — 프랜차이즈 고객 신규 계약, 연간 목표 달성', '2019~2021 (예시) 무역 회사 해외영업 — 중국 거래처 발굴과 견적·계약 진행', '중국어: 회의·메일 업무 가능 (중국 근무 1년)'),
    },
  },
  {
    id: R(2), userId: U(1), title: '운영·고객 지원용', isDefault: 0,
    body: {
      name: '김하준 (시연)', chinese_level: 'business', years: 6, headline: '고객 도입 교육과 계약 갱신 경험', contact_email: mail('seeker.kim'), phone: null,
      desired_role: '고객 성공 매니저',
      experience_text: lines('영업을 하면서 계약 뒤 도입 교육과 문의 응대를 함께 맡았습니다.', '고객 의견을 정리해 제품팀에 전달하고 갱신율을 관리했습니다.'),
    },
  },
  {
    id: R(3), userId: U(2), title: '기본 이력서', isDefault: 1,
    body: {
      name: '이서윤 (시연)', chinese_level: 'native', years: 2, headline: '중한 통번역 2년, 무역 문서 번역 경험', contact_email: mail('seeker.lee'), phone: null,
      desired_role: '통번역',
      experience_text: lines('2024~현재 (예시) 번역 회사 — 계약서·통관 서류 중한 번역', '회의 통역 다수', '중국어·한국어 모두 원어민 수준'),
    },
  },
  {
    id: R(4), userId: U(3), title: '기본 이력서', isDefault: 1,
    body: {
      name: '박도윤 (시연)', chinese_level: 'basic', years: 4, headline: '고객 지원 4년, 도입 교육 담당', contact_email: mail('seeker.park'), phone: null,
      desired_role: '고객 지원',
      experience_text: lines('2022~현재 (예시) 소프트웨어 회사 고객 지원 — 신규 고객 교육, 문의 응대', '기초 중국어 가능'),
    },
  },
  {
    id: R(5), userId: U(4), title: '기본 이력서', isDefault: 1,
    body: {
      name: '최지우 (시연)', chinese_level: 'none', years: 5, headline: '백엔드 개발 5년, 결제 연동 경험', contact_email: mail('seeker.choi'), phone: null,
      desired_role: '백엔드 개발자',
      experience_text: lines('2021~현재 (예시) 커머스 회사 백엔드 개발 — 주문·결제 API', '관계형 데이터베이스 설계와 성능 개선'),
    },
  },
];

// ── 지원. 상태는 여기 적지 않는다 — events 를 rules.nextStatus 로 차례로 적용한 결과가 상태다 (CLAUDE.md 규칙 3).
export interface DemoApplication {
  id: string;
  jobId: string;
  seekerId: string;
  resumeId: string;
  /** 국외 이전 동의에 체크했는가. 필요 없는 기업이면 남기지 않고, 필수인 기업인데 false 면 그 지원은 넣지 않는다 (lib/application). */
  consent: boolean;
  daysAgo: number;
  events: ReadonlyArray<{ event: AppEvent; actorId: string; daysAgo: number }>;
}

export const DEMO_APPLICATIONS: readonly DemoApplication[] = [
  // 구직자 김하준: 진행 단계가 서로 다른 지원 4건
  {
    id: A(1), jobId: J(1), seekerId: U(1), resumeId: R(1), consent: true, daysAgo: 6,
    events: [{ event: 'viewed', actorId: U(11), daysAgo: 5 }, { event: 'interview_mail', actorId: U(11), daysAgo: 3 }],
  },
  { id: A(2), jobId: J(2), seekerId: U(1), resumeId: R(2), consent: false, daysAgo: 2, events: [] },
  { id: A(3), jobId: J(11), seekerId: U(1), resumeId: R(1), consent: true, daysAgo: 4, events: [{ event: 'viewed', actorId: U(13), daysAgo: 3 }] },
  {
    id: A(4), jobId: J(21), seekerId: U(1), resumeId: R(2), consent: false, daysAgo: 9,
    events: [{ event: 'viewed', actorId: U(14), daysAgo: 8 }, { event: 'reject_mail', actorId: U(14), daysAgo: 6 }],
  },
  // 란하이테크코리아의 지원자 목록을 채우는 다른 지원자들 (로그인 화면에 없는 계정)
  { id: A(5), jobId: J(1), seekerId: U(3), resumeId: R(4), consent: true, daysAgo: 1, events: [] },
  { id: A(6), jobId: J(2), seekerId: U(3), resumeId: R(4), consent: false, daysAgo: 5, events: [{ event: 'viewed', actorId: U(11), daysAgo: 4 }] },
  { id: A(7), jobId: J(3), seekerId: U(4), resumeId: R(5), consent: false, daysAgo: 2, events: [] },
  { id: A(8), jobId: J(1), seekerId: U(4), resumeId: R(5), consent: true, daysAgo: 7, events: [{ event: 'viewed', actorId: U(11), daysAgo: 6 }] },
  { id: A(9), jobId: J(31), seekerId: U(3), resumeId: R(4), consent: false, daysAgo: 3, events: [] },
];
