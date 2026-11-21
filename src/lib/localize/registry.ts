// 엔진 목록. 순서가 기본 시도 순서다 (LOCALIZE_ENGINE 로 지정한 엔진이 있으면 그것을 먼저). 마지막은 workers_ai.
// 새 엔진은 engines/openai-compat.ts 의 설명대로 파일 하나를 만들고 여기에 넣는다.
import { claude } from './engines/claude';
import { gemini } from './engines/gemini';
import { workersAi } from './engines/workers-ai';
import type { LocalizeEngine } from './types';

export const ENGINES: readonly LocalizeEngine[] = [claude, gemini, workersAi];
