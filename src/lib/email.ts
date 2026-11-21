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
    // 키가 없으면 운영 외 환경에서만 콘솔에 출력한다. 운영에서는 실패로 처리한다.
    if (env.APP_ENV !== 'production') {
      console.log(`[mail:${mail.template}] to=${mail.to}\n${mail.subject}\n${mail.text}`);
      result = 'console';
    } else result = 'no_api_key';
  } else {
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
  }
  await insertEmailLog(env.DB, crypto.randomUUID(), await sha256Hex(mail.to.toLowerCase()), mail.template, result, now());
  return result === 'sent' || result === 'console';
}
