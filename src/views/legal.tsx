// 이용약관·개인정보처리방침 화면 (T-11). 본문은 src/legal/ 의 정적인 글이지만 JSX 로만 출력한다 (원시 HTML 없음).
// 주소(https://…)가 들어 있는 항목도 글자 그대로 보인다 (자동 링크 없음).
import type { Locale } from '../env';
import type { LegalDoc } from '../legal/types';
import { t } from '../lib/i18n';

export const LegalPage = ({ locale, doc, other }: { locale: Locale; doc: LegalDoc; other: 'terms' | 'privacy' }) => (
  <article class="wide doc">
    <h1>{doc.title}</h1>
    <p class="muted">{doc.effective}</p>
    {doc.intro.map((p) => <p>{p}</p>)}
    {doc.sections.map((s) => (
      <section>
        <h2>{s.h}</h2>
        <ul>{s.items.map((i) => <li>{i}</li>)}</ul>
      </section>
    ))}
    <p class="spaced"><a href={`/${other}`}>{t(locale, `footer.${other}`)}</a></p>
  </article>
);
