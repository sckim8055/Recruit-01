// 메일 발송 (Resend). 원칙: 메일 본문에 이력서·연락처 같은 개인정보를 넣지 않는다. 링크만 보낸다.
import { now, type Env } from '../env';
import { sha256Hex } from './crypto';
import { insertEmailLog } from '../db/logs';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  template: string;      // email_log 에 남길 이름 (예: 'auth_code')
  replyTo?: string;      // 기업 → 구직자 메일은 기업 담당자 주소. 운영자 주소를 연락처로 쓰지 않는다
}

export async function sendMail(env: Env, mail: Mail): Promise<boolean> {
  let result = 'skipped';
  if (!env.RESEND_API_KEY) {
    // 키가 없으면 로컬 개발(APP_ENV = 'dev')에서만 콘솔에 출력한다 (가짜 데이터뿐). 테스트·운영 서버에서는 출력하지 않고 실패로 처리한다 —
    // 배포된 서버의 콘솔은 Workers Logs 에 남으므로 받는 주소·인증코드·본문이 기록에 남지 않게 (T-13).
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
