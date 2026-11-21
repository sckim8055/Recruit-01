import { describe, expect, it } from 'vitest';
import { findBannedPhrases } from '../src/lib/rules';
import { ko } from '../src/locales/ko';
import { zh } from '../src/locales/zh';

describe('locales', () => {
  it('한국어·중국어 문구의 키가 같다', () => expect(Object.keys(zh).sort()).toEqual(Object.keys(ko).sort()));
  it('화면 문구에 금지 표현이 없다', () => expect(Object.values(ko).flatMap(findBannedPhrases)).toEqual([]));
});
