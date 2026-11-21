// 직무·업계·근무지 선택 항목의 기본값 (T-06e). 0007 마이그레이션의 기본 행이 이 목록과 같아야 한다 (test/options.test.ts).
// 이 작업 전의 상수(lib/jobs.ts ROLE_CATEGORIES·INDUSTRIES·LOCATIONS, 이 순서)와 화면 문구(locales 의 job.role.* · job.industry.* · job.location.*)를
// 지우기 전에 그대로 옮겨 적었다. 테스트 전용이다 — 앱은 DB(job_options)만 읽는다.
// 가짜 D1 을 쓰는 라우트 테스트도 이 목록을 job_options 행으로 돌려준다 (optionRows()).
import type { OptionRow } from '../src/lib/options';

/** [kind, code, label_ko, label_zh] — 종류마다 원래 순서대로. */
export const SEED_OPTIONS: [OptionRow['kind'], string, string, string][] = [
  ['role_category', 'sales', '영업', '销售'],
  ['role_category', 'marketing', '마케팅', '市场营销'],
  ['role_category', 'finance', '재무·회계', '财务与会计'],
  ['role_category', 'hr', '인사', '人力资源'],
  ['role_category', 'admin', '총무·사무', '行政与文员'],
  ['role_category', 'it', 'IT·개발', 'IT与开发'],
  ['role_category', 'engineering', '기술·엔지니어링', '技术与工程'],
  ['role_category', 'operations', '운영', '运营'],
  ['role_category', 'logistics', '물류', '物流'],
  ['role_category', 'purchasing', '구매', '采购'],
  ['role_category', 'legal', '법무', '法务'],
  ['role_category', 'customer', '고객 응대', '客户服务'],
  ['role_category', 'translation', '통번역', '翻译'],
  ['role_category', 'management', '경영·관리', '经营管理'],
  ['role_category', 'other', '기타', '其他'],
  ['industry', 'electronics', '전자', '电子'],
  ['industry', 'battery', '배터리', '电池'],
  ['industry', 'auto', '자동차', '汽车'],
  ['industry', 'machinery', '기계', '机械'],
  ['industry', 'chemicals', '화학', '化工'],
  ['industry', 'ecommerce', '전자상거래', '电子商务'],
  ['industry', 'retail', '유통', '零售'],
  ['industry', 'logistics', '물류', '物流'],
  ['industry', 'trade', '무역', '贸易'],
  ['industry', 'finance', '금융', '金融'],
  ['industry', 'it_software', 'IT·소프트웨어', 'IT与软件'],
  ['industry', 'gaming', '게임', '游戏'],
  ['industry', 'consumer', '소비재', '消费品'],
  ['industry', 'food', '식품', '食品'],
  ['industry', 'travel', '여행·관광', '旅游'],
  ['industry', 'other', '기타', '其他'],
  ['location', 'seoul', '서울', '首尔'],
  ['location', 'gyeonggi', '경기', '京畿道'],
  ['location', 'incheon', '인천', '仁川'],
  ['location', 'busan', '부산', '釜山'],
  ['location', 'daegu', '대구', '大邱'],
  ['location', 'daejeon', '대전', '大田'],
  ['location', 'gwangju', '광주', '光州'],
  ['location', 'ulsan', '울산', '蔚山'],
  ['location', 'sejong', '세종', '世宗'],
  ['location', 'gangwon', '강원', '江原道'],
  ['location', 'chungbuk', '충북', '忠清北道'],
  ['location', 'chungnam', '충남', '忠清南道'],
  ['location', 'jeonbuk', '전북', '全罗北道'],
  ['location', 'jeonnam', '전남', '全罗南道'],
  ['location', 'gyeongbuk', '경북', '庆尚北道'],
  ['location', 'gyeongnam', '경남', '庆尚南道'],
  ['location', 'jeju', '제주', '济州'],
  ['location', 'remote', '재택', '远程办公'],
];

/** job_options 행 모양 (sort 는 종류 안에서 10, 20, 30 …, 모두 사용 중). */
export function optionRows(): OptionRow[] {
  const seen: Record<string, number> = {};
  return SEED_OPTIONS.map(([kind, code, label_ko, label_zh]) => {
    seen[kind] = (seen[kind] ?? 0) + 10;
    return { kind, code, label_ko, label_zh, sort: seen[kind]!, active: 1 };
  });
}
