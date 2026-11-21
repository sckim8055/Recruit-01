# recruit

한국에 진출한 중국기업 전용 채용정보 사이트 (직업정보제공사업 형태). Cloudflare Workers + D1 + R2.

- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 경로·API: [docs/API.md](docs/API.md)
- 할 일 목록: [docs/TASKS.md](docs/TASKS.md)
- 개발 규칙: [CLAUDE.md](CLAUDE.md)

## 로컬에서 실행하기 (Windows)

Node.js 22 이상이 필요하다.

```
npm install
copy .dev.vars.example .dev.vars
```

`.dev.vars` 를 열어 두 값을 채운다.

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

위 명령의 출력값을 `ENC_KEY=` 뒤에 붙이고, `SESSION_PEPPER=` 뒤에는 임의의 긴 문자열을 적는다. (이 값들은 README 나 대화창에 적지 않는다.)

```
npm run db:local
npx wrangler dev --var APP_ENV:dev
```

Windows 에서는 위 두 줄 대신 폴더의 **`start.bat` 을 더블클릭**해도 된다 (패키지 설치 확인 → 로컬 DB 갱신 → 서버 시작을 한 번에 한다. 끝낼 때는 창에서 Ctrl+C).

브라우저에서 http://localhost:8787 을 연다. 로그인 인증코드는 메일로 가지 않고 **터미널 창**에 출력된다.

## 현지화 엔진 (공고 한국어 초안)

엔진 키가 없어도 사이트는 동작한다. 이때 기업은 한국어 초안을 직접 입력한다(수동 입력).
자동으로 만들려면 아래 중 하나 이상을 준비한다.

1. **Claude**: https://platform.claude.com 에서 API 키를 만든다.
2. **Gemini**: https://aistudio.google.com 에서 API 키를 만든다.
3. **Workers AI**: 키가 필요 없다. `npx wrangler login` 으로 Cloudflare 에 로그인한 뒤, `wrangler.jsonc` 맨 아래 `"ai"` 줄의 설명대로 켠다.

로컬에서는 `.dev.vars` 에 키를 한 줄씩 적는다 (이 파일은 git 에 올라가지 않는다).

```
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AIza...
```

테스트·운영 서버에는 `npx wrangler secret put ANTHROPIC_API_KEY` (또는 `GEMINI_API_KEY`) 를 실행하고 키를 붙여 넣는다.

어느 엔진을 먼저 쓸지는 `wrangler.jsonc` 의 `"LOCALIZE_ENGINE"` 에 `claude`, `gemini`, `workers_ai` 중 하나를 적어 정한다.
비워 두면 claude → gemini → workers_ai 순서로 키가 있는 것을 쓰고, 실패하면 다음 엔진으로 넘어간다.
모델을 바꾸려면 `LOCALIZE_CLAUDE_MODEL` · `LOCALIZE_GEMINI_MODEL` · `LOCALIZE_WORKERS_AI_MODEL` 에 모델 id 를 적는다(비우면 기본값).
키를 넣은 뒤 관리자 화면의 "현지화 엔진 비교"(`/admin/localize-test`)에서 엔진별 결과와 걸린 시간을 비교해 볼 수 있다.

## 확인 명령

```
npm run typecheck
npm test
```

## 테스트 서버(recruit.kimbbob.xyz)에 올리기

docs/TASKS.md 의 "운영자 설정" 항목을 먼저 끝낸 뒤 `npm run db:remote`, `npm run deploy` 를 실행한다.

## 채용정보 검색 조건 고르기

채용정보 목록(/jobs)의 검색 칸에 어떤 조건을 보일지는 관리자 화면 **관리자 → 사이트 설정**(`/admin/settings`)에서 체크해 저장한다. 코드를 고칠 필요가 없다.
처음에는 중국어 수준·보고 라인·근무지 세 개만 보인다. 숨긴 조건도 공고 내용에는 그대로 나오며, 로그인하지 않은 방문자 화면에는 최대 60초 뒤에 반영된다.

## 직무·업계·근무지 항목 고치기

공고 작성 폼과 검색 칸의 직무·업계·근무지 목록은 **관리자 → 직무·업계·근무지 항목**(`/admin/options`)에서 고친다. 코드를 고칠 필요가 없다.
- 추가: 해당 구역 아래 "새 항목 추가" 에 코드(영문 소문자, 예: `semiconductor`)·한국어 이름·중국어 이름·순서를 적고 추가한다. **코드는 나중에 바꿀 수 없다.**
- 그만 쓰기: 줄의 "사용 종료" 를 누른다. 새 공고와 검색 칸에서 빠지고, 이미 그 항목을 쓴 공고에는 이름이 그대로 보인다. 다시 쓰려면 "다시 사용". 항목은 지우지 않는다.
- 이름·순서는 줄에서 고쳐 "저장" 한다 (기존 공고에도 새 이름이 보인다). 로그인하지 않은 방문자 화면에는 최대 60초 뒤에 반영된다.

## 이력서와 ENC_KEY

구직자의 이력서 내용과 첨부파일은 `ENC_KEY` 로 암호화해 저장한다(DB·R2 어느 쪽을 열어도 내용이 보이지 않는다).
**`ENC_KEY` 를 잃거나 바꾸면 저장된 이력서와 첨부파일은 복구할 수 없다** — 화면에는 "열 수 없는 이력서" 로 나오고 삭제만 할 수 있다.
그래서 `ENC_KEY` 는 처음 넣을 때 오프라인(USB·종이 등)에 사본을 보관하고, 서버마다 넣은 값을 바꾸지 않는다.

## 관리자 계정 만들기

관리자는 화면에서 가입할 수 없다. 먼저 그 이메일로 일반 로그인을 한 번 한 뒤, DB 에서 역할을 바꾼다.

```
npx wrangler d1 execute DB --local --command "UPDATE users SET role='admin' WHERE email='내이메일@example.com'"
```

(테스트·운영 서버는 `--local` 대신 `--remote`.) 로그아웃한 뒤 다시 로그인하면 2단계 인증 등록 화면이 나온다.
휴대폰의 인증 앱(Google Authenticator, Microsoft Authenticator 등)에서 "설정 키 입력"을 골라 화면의 키를 입력하고,
앱에 나오는 6자리 번호를 입력하면 `/admin` 으로 들어간다. 다음 로그인부터는 이메일 인증코드 + 앱의 6자리 번호가 필요하다.

인증 앱을 잃어버렸을 때 초기화:

```
npx wrangler d1 execute DB --local --command "UPDATE users SET totp_secret=NULL, totp_last_step=NULL WHERE email='내이메일@example.com'"
```

## 이용약관·개인정보처리방침 (운영 전에 반드시 채울 것)

- 글이 있는 곳: `src/legal/terms.ts`(이용약관) · `src/legal/privacy.ts`(개인정보처리방침), 운영자 정보(상호·대표자·주소·문의 이메일·보호책임자)는 `src/legal/types.ts` 의 `OPERATOR`.
  한국어가 기준이고 중국어는 참고 번역이다. 화면은 `/terms`, `/privacy` (모든 화면 아래쪽에 링크).
- **운영 서버에 올리기 전에** 할 일:
  1. 위 세 파일에서 `【확인 필요` / `【待确认` 로 표시된 곳을 모두 채운다 (상호·대표자·주소·문의 이메일·보호책임자·신고번호·시행일·동의 기록 보관 기간·위탁 계약 여부).
  2. 문서를 노무·개인정보 전문가에게 검토받는다. 문서에 적힌 내용(수집 항목·보관 기간·국외 보관·탈퇴 때 지워지는 것)이 실제 동작과 같아야 한다.
  3. 시행일을 정해 `effective` 줄에 적는다.
  4. 모두 채웠으면 `test/account.test.ts` 의 마지막 테스트("운영자가 채워야 할 표시가 남아 있다")를 `toBe(0)` 으로 바꾼다.
- **글을 고칠 때마다** `src/lib/consent.ts` 의 `TERMS_VERSION`(약관) 또는 `PRIVACY_VERSION`(방침)을 새 값(예: `2026-12-1`)으로 올린다.
  올리면 로그인한 회원은 다음 요청 때 동의 화면(`/consent`)으로 가서 바뀐 문서에 다시 동의한다. 오타만 고친 경우에도 올릴지는 운영자가 정한다.
- 지원할 때 받는 중국 본사 담당자 열람(국외 이전) 동의 문구는 `src/locales/ko.ts`·`zh.ts` 의 `apply.consent.*` 이고, 방침 5항과 같은 내용이어야 한다. 바꾸면 `src/lib/application.ts` 의 `CROSS_BORDER_VERSION` 을 올린다.

## 회원 탈퇴

회원은 **계정**(`/my/account`) → "탈퇴 절차 보기" 에서 로그인 이메일을 입력해 스스로 탈퇴한다. 무엇이 지워지고 남는지는 docs/ARCHITECTURE.md 13절.
- 다른 담당자가 있는 기업의 대표 담당자는 탈퇴할 수 없다(대표를 넘기는 화면이 아직 없다). 다른 담당자를 내보낸 뒤 탈퇴하게 안내한다.
- 관리자 계정은 화면에서 탈퇴할 수 없다. 꼭 지워야 하면 먼저 역할을 구직자로 바꾼 뒤(아래 명령), 그 계정으로 로그인해 계정 화면에서 탈퇴한다.

```
npx wrangler d1 execute DB --remote --command "UPDATE users SET role='seeker', totp_secret=NULL WHERE email='지울관리자@example.com'"
```

## 자동 정리 작업 (매시 정각)

서버는 매시 정각에 정리 작업을 하나씩 자동으로 한다. 운영자가 따로 켤 것은 없다 (자세한 내용은 docs/ARCHITECTURE.md 14절).
- 마감일이 지난 공고를 마감하고, 마감일이 없는 공고는 마지막 저장 후 30일이 지나면 마감한다. 마감 3일 전에 기업 담당자에게 안내 메일(한국어+중국어)을 한 번 보낸다.
- 마감된 공고의 지원서는 180일 뒤 내용과 첨부파일을 지운다(개인정보처리방침 3항). 마감 후 30일이 지나도 처리되지 않은 지원은 "채용 종료" 상태가 된다.
- 확인 후 1년이 지난 사업자 서류, 2년이 지난 열람 기록, 만료된 로그인 정보 등을 지운다. 어느 기록도 가리키지 않는 첨부파일(삭제 실패로 남은 것)도 하루 뒤에 지운다.
- 한 번에 조금씩만 하고(무료 플랜 한도), 남은 것은 다음 차례에 이어서 한다.

**잘 돌았는지 보는 법**
1. Cloudflare 대시보드 → Workers & Pages → `recruit-test` → **Logs**(또는 `npx wrangler tail`)에서 매시 한 줄 `maint: step=<단계> ok counts={…}` 를 본다. `failed` 가 보이면 개발자에게 알린다.
   이 줄에는 숫자만 있다(이메일·파일 이름·id 없음).
2. (선택) 매일 아침 9시(한국 시간)에 전날 처리 수를 메일로 받으려면 `wrangler.jsonc` 의 `"OPS_EMAIL": ""` 에 받을 주소를 적고 다시 배포한다. 비워 두면 보내지 않는다.
   메일에는 개수만 들어 있다. (메일 발송에는 Resend 키가 필요하다 — O-6.)

**로컬에서 직접 실행해 보기 (개발자용)**

```
npx wrangler dev --var APP_ENV:dev --test-scheduled
```

다른 창에서 (wrangler 4.166 에서 확인):

```
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=maint:closeJobs"
curl "http://localhost:8787/__scheduled?cron=maint:closeJobs"
```

`maint:` 뒤에는 `closeJobs` · `markApplications` · `purgeApplications` · `dropOldRows` · `purgeVerificationDocs` · `sweepOrphans` · `report` 중 하나를 쓴다.
단계를 고르는 이 방법은 `APP_ENV` 가 `dev` 일 때만 된다. `cron=0+*+*+*+*` 로 보내면 지금 시각(UTC)의 단계가 돌고, `&time=<밀리초>` 를 붙이면 그 시각으로 실행한다.
결과는 wrangler 창의 `maint:` 줄과 `npx wrangler d1 execute DB --local --command "…"` 로 확인한다. 정리 작업을 실행하는 웹 주소는 없다.
