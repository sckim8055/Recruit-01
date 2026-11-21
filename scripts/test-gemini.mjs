// Gemini 연결 진단 (개발용). 실행: node scripts/test-gemini.mjs
// .dev.vars 의 GEMINI_API_KEY 로 Google 에 직접 요청해 보고, 걸린 시간과 결과를 보여준다. 키는 출력하지 않는다.
// 서버(wrangler)를 거치지 않으므로 "네트워크·키·모델 이름" 문제와 "서버 코드" 문제를 가를 수 있다.
import { readFileSync } from 'node:fs';

const vars = Object.fromEntries(
  readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const key = vars.GEMINI_API_KEY;
if (!key) { console.log('[X] .dev.vars 에 GEMINI_API_KEY 가 없습니다.'); process.exit(1); }
console.log(`key: 길이 ${key.length}자, 앞 2자 "${key.slice(0, 2)}" (따옴표·공백이 섞여 있으면 안 됩니다: ${/["'\s]/.test(key) ? '섞여 있음 [X]' : '정상'})`);

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const model = vars.LOCALIZE_GEMINI_MODEL || 'gemini-3.8-flash';

async function timed(label, url, init, ms) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status} · ${Date.now() - t0}ms`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`\n[${label}] 실패 · ${Date.now() - t0}ms · ${e?.name ?? ''} ${e?.cause?.code ?? e?.message ?? ''}`);
    return null;
  }
}

// 1) 모델 목록: 키가 유효한지, Google 에 닿는지, 쓸 수 있는 모델 이름이 무엇인지
const list = await timed('1 모델 목록', `${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } }, 20000);
if (list) {
  try {
    const names = (JSON.parse(list.text).models ?? []).map((m) => m.name.replace('models/', ''));
    const flash = names.filter((n) => n.includes('flash'));
    console.log(`   모델 ${names.length}개. flash 계열: ${flash.join(', ') || '(없음)'}`);
    console.log(`   기본 모델 "${model}" 이 목록에 ${names.includes(model) ? '있습니다' : '없습니다 [X]'}`);
  } catch { console.log('   ' + list.text.slice(0, 300).replace(/\s+/g, ' ')); }
}

// 2) 서버가 보내는 것과 같은 모양의 요청 (짧은 가짜 문장)
const body = (withThinking) => JSON.stringify({
  system_instruction: { parts: [{ text: 'Translate the Chinese job posting into Korean. Reply with JSON only: {"title_ko":"...","body_ko":"..."}' }] },
  contents: [{ role: 'user', parts: [{ text: '标题: 招聘销售经理\n正文: 负责韩国市场的销售工作，要求3年以上经验。' }] }],
  generationConfig: { maxOutputTokens: 2000, ...(withThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
});
const post = (b) => ({ method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' }, body: b });
const show = (r) => { if (r) console.log('   ' + r.text.slice(0, 500).replace(/\s+/g, ' ')); };

// 서버가 차례로 써 보는 모델들을 하나씩 시험한다 (서버는 모델당 11초까지 기다린다).
const models = vars.LOCALIZE_GEMINI_MODEL ? vars.LOCALIZE_GEMINI_MODEL.split(',').map((x) => x.trim()).filter(Boolean) : [model, 'gemini-3.7-flash', 'gemini-3.5-flash'];
let n = 2;
for (const m of models) {
  const r = await timed(`${n++} 생성 (${m})`, `${BASE}/models/${m}:generateContent`, post(body(true)), 40000);
  show(r);
  if (r && r.status === 400) show(await timed(`${n++} 생성 (${m}, thinking 설정 없이)`, `${BASE}/models/${m}:generateContent`, post(body(false)), 40000));
}
console.log('\n이 창에 나온 내용을 그대로 보내 주세요 (키는 들어 있지 않습니다).');
