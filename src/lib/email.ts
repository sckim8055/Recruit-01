// 메일 발송 (Resend). 원칙: 메일 본문에 이력서·연락처 같은 개인정보를 넣지 않는다. 링크만 보낸다.
import { now, type Env } from '../env';
import { sha256Hex } from './crypto';
import { insertEmailLog } from '../db/logs';
import { isDemoAddress } from './demo';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  template: string;      // email_log 에 남길 이름 (예: 'auth_code')
  replyTo?: string;      // 기업 → 구직자 메일은 기업 담당자 주소. 운영자 주소를 연락처로 쓰지 않는다
  /**
   * 메일 머리글 (선택, T-10). Resend API 의 `headers` (이름 → 문자열) 로 그대로 넘긴다 — 조건 알림의 List-Unsubscribe·List-Unsubscribe-Post.
   * https://resend.com/docs/dashboard/emails/add-unsubscribe-to-transactional-emails · https://resend.com/docs/api-reference/emails/send-email
   */
  headers?: Record<string, string>;
}

export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  let result = 'skipped';
  if (isDemoAddress(mail.to)) {
    // 시연 계정의 주소(@demo.example)는 받는 사람이 없다. 실제로 보내지 않고 기록만 남긴다 (반송으로 보내는 도메인의 평판이 깎이지 않게).
    // 테스트 서버·로컬에서는 "보냄" 으로 처리해 면접 요청 같은 흐름을 끝까지 볼 수 있게 하고, 운영에서는 실패로 처리한다.
    result = 'demo_address';
    await insertEmailLog(env.DB, crypto.randomUUID(), await sha256Hex(mail.to.toLowerCase()), mail.template, result, now());
    return env.APP_ENV !== 'production';
  }
  if (!env.RESEND_API_KEY) {
    // 키가 없으면 로컬 개발(APP_ENV = 'dev')에서만 콘솔에 출력한다 (가짜 데이터뿐). 테스트·운영 서버에서는 출력하지 않고 실패로 처리한다 —
    // 서버의 콘솔은 로그(서비스 관리 프로그램, T-19 전에는 Workers Logs)에 남으므로 받는 주소·인증코드·본문이 기록에 남지 않게 (T-13).
    if (env.APP_ENV === 'dev') {
      console.log(`[mail:${mail.template}] to=${mail.to}\n${mail.subject}\n${mail.text}`);
      result = 'console';
    } else result = 'no_api_key';
  } else {
    // 연결 실패(예외)도 "보내지 못함" 으로 처리하고 기록을 남긴다 — 예외가 밖으로 나가면 호출부마다 따로 잡아야 하고 기록도 빠진다.
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          ...(mail.headers && Object.keys(mail.headers).length ? { headers: mail.headers } : {}),
        }),
      });
      result = res.ok ? 'sent' : `error_${res.status}`;
    } catch {
      result = 'error_network';
    }
  }
  await insertEmailLog(env.DB, crypto.randomUUID(), await sha256Hex(mail.to.toLowerCase()), mail.template, result, now());
  return result === 'sent' || result === 'console';
}
