// 관리자 시스템 점검 화면 (T-13, GET /admin/system). 설정 점검 결과·비밀값 유무·예약 작업 시간표·오늘 사용량·한도와 출처·알림 발송 상태(T-17)·보관 기간(읽기만).
// 비밀값의 값은 이 화면 어디에도 나오지 않는다 (lib/config-check 가 "설정됨/없음" 과 길이 구간만 돌려준다).
import type { Locale } from '../env';
import { t } from '../lib/i18n';
import type { CheckItem, CheckLevel, SecretState } from '../lib/config-check';
import type { StepName } from '../lib/maintenance';
import type { TodayUsage, UsageLine } from '../lib/quota';
import { RETENTION_SPEC, type RetentionSettings } from '../lib/retention';
import { retentionValueText } from './admin-settings';
import { LimitsSystemBox } from './admin-limits';
import type { EffectiveLimits } from '../lib/limits';

const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);

const BADGE: Record<CheckLevel, string> = { ok: 'badge s-verified', warning: 'badge l-review', problem: 'badge s-rejected' };

export const SystemPage = (p: {
  locale: Locale; appEnv: string; worst: CheckLevel; checks: ReadonlyArray<Pick<CheckItem, 'level' | 'code' | 'n'> & { id: string }>; secrets: SecretState[];
  schedule: readonly StepName[]; usage: TodayUsage; retention: RetentionSettings;
  /** 시간표 단계 뒤에 같은 실행에서 하는 단계 (UTC 시 → 단계, T-10). */
  shared?: Readonly<Record<number, StepName>>;
  /** 조건 알림 개수와 오늘 알림 메일 (개수만, T-10). */
  alerts?: { active: number; paused: number; mail: UsageLine };
  /** 지금 쓰는 한도·출처·알림 켜기/끄기 (T-17). */
  limits?: EffectiveLimits;
}) => {
  const l = p.locale;
  return (
    <section class="wide">
      <h1>{t(l, 'sys.title')}</h1>
      <p class="muted">{t(l, 'sys.lead')}</p>
      <div class="box">
        <p>{t(l, 'sys.env')}: <b>{p.appEnv || '-'}</b></p>
        <p class={p.worst === 'ok' ? 'ok' : p.worst === 'warning' ? 'warn' : 'error'}>{t(l, `sys.summary.${p.worst}`)}</p>
      </div>

      <div class="box">
        <h2>{t(l, 'sys.checks.title')}</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>{t(l, 'sys.col.level')}</th><th>{t(l, 'sys.col.item')}</th><th>{t(l, 'sys.col.result')}</th></tr></thead>
          <tbody>
            {p.checks.map((c) => (
              <tr>
                <td class="nowrap"><span class={BADGE[c.level]}>{t(l, `sys.level.${c.level}`)}</span></td>
                <td>{t(l, `sys.chk.${c.id}`)}</td>
                <td>{fill(t(l, `sys.res.${c.id}.${c.code}`), { n: c.n ?? '' })}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <div class="box">
        <h2>{t(l, 'sys.secrets.title')}</h2>
        <div class="table-wrap"><table>
          <tbody>
            {p.secrets.map((s) => (
              <tr>
                <th>{s.name}</th>
                <td>{t(l, s.set ? 'sys.secret.set' : 'sys.secret.missing')}</td>
                <td class="muted">{s.set ? t(l, `sys.len.${s.length}`) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p class="hint">{t(l, 'sys.secrets.note')}</p>
      </div>

      <div class="box">
        <h2>{t(l, 'admin.usage.title')} <span class="muted">({p.usage.day})</span></h2>
        <div class="table-wrap"><table>
          <tbody>
            <tr><th>{t(l, 'admin.usage.localize')}</th><td>{p.usage.localize.n} / {p.usage.localize.limit}</td></tr>
            <tr><th>{t(l, 'admin.usage.mail')}</th><td>{p.usage.mail.n} / {p.usage.mail.limit}</td></tr>
          </tbody>
        </table></div>
      </div>

      {p.limits && <LimitsSystemBox locale={l} limits={p.limits} />}

      {p.alerts && (
        <div class="box">
          <h2>{t(l, 'sys.alerts.title')}</h2>
          <div class="table-wrap"><table>
            <tbody>
              <tr><th>{t(l, 'sys.alerts.active')}</th><td class="num">{p.alerts.active}</td></tr>
              <tr><th>{t(l, 'sys.alerts.paused')}</th><td class="num">{p.alerts.paused}</td></tr>
              <tr><th>{t(l, 'sys.alerts.mail_today')}</th><td class="num">{p.alerts.mail.n} / {p.alerts.mail.limit}</td></tr>
            </tbody>
          </table></div>
          <p class="hint">{t(l, 'sys.alerts.note')}</p>
        </div>
      )}

      <div class="box">
        <h2>{t(l, 'sys.ret.title')}</h2>
        <div class="table-wrap"><table>
          <tbody>
            {RETENTION_SPEC.map((s) => (
              <tr><th>{t(l, `adm.ret.short.${s.key}`)}</th><td>{retentionValueText(l, s.key, p.retention[s.key])}</td></tr>
            ))}
          </tbody>
        </table></div>
        <p class="hint">{t(l, 'sys.ret.note')} <a href="/admin/settings#retention">{t(l, 'adm.set.title')}</a></p>
      </div>

      <div class="box">
        <h2>{t(l, 'sys.cron.title')}</h2>
        <p class="hint">{t(l, 'sys.cron.note')}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>UTC</th><th>{t(l, 'sys.cron.kst')}</th><th>{t(l, 'sys.cron.step')}</th></tr></thead>
          <tbody>
            {p.schedule.map((step, h) => (
              <tr><td>{String(h).padStart(2, '0')}:00</td><td>{String((h + 9) % 24).padStart(2, '0')}:00</td><td>{t(l, `sys.step.${step}`)} <span class="muted">({step})</span>
                {p.shared?.[h] && <> + {t(l, `sys.step.${p.shared[h]}`)} <span class="muted">({p.shared[h]})</span></>}</td></tr>
            ))}
          </tbody>
        </table></div>
      </div>

      <div class="box">
        <h2>{t(l, 'sys.mig.title')}</h2>
        <p class="hint">{t(l, 'sys.mig.body')}</p>
      </div>
    </section>
  );
};
