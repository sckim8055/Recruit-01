// 엔진 목록. 순서가 기본 시도 순서다 (LOCALIZE_ENGINE 로 지정한 엔진이 있으면 그것을 먼저): claude(기본) → gemini(선택).
// T-19: Cloudflare Workers AI 는 PC 서버로 옮기며 뺐다 (Cloudflare 계정 안에서만 부를 수 있다). 예전 공고의 jobs.localize_engine 값 'workers_ai' 는
// 기록으로만 남고, "다시 만들기" 는 지금 쓸 수 있는 엔진 순서로 한다 (lib/localize/index.engineOrder — 모르는 id 는 건너뛴다).
// 새 엔진은 engines/openai-compat.ts 의 설명대로 파일 하나를 만들고 여기에 넣는다.
import { claude } from './engines/claude';
import { gemini } from './engines/gemini';
import type { LocalizeEngine } from './types';

export const ENGINES: readonly LocalizeEngine[] = [claude, gemini];
