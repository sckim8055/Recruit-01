# 배포·운영 안내 (운영자용)

이 문서는 개발자가 아닌 운영자가 **테스트 서버**(recruit.kimbbob.xyz)와 나중의 **운영 서버**를 올리고, 백업하고, 문제가 생겼을 때 대처하는 방법을 순서대로 적은 것이다.
각 단계는 "할 일 → 보여야 하는 것 → 다르게 나오면" 으로 적었다.

**읽기 전에 꼭 알아 둘 것**

- 이 문서는 2026년 11월의 Cloudflare·Resend 공식 문서를 보고 썼지만, **실제 Cloudflare 계정에서는 아직 한 번도 해 보지 않은 절차다.** `【실제 환경에서 미확인】` 표시가 붙은 곳은 특히 화면·메시지가 다를 수 있다. 다르게 나오면 그 화면을 캡처해 개발자에게 보낸다(비밀값이 보이는 부분은 가린다).
- 명령은 **Windows PowerShell** 에 한 줄씩 그대로 붙여 넣는다. 여러 줄이 있으면 한 줄 실행 → 끝날 때까지 기다림 → 다음 줄.
- PowerShell 은 프로젝트 폴더에서 연다: 탐색기에서 프로젝트 폴더를 연 뒤 주소창에 `powershell` 을 입력하고 Enter.
- 비밀값(ENC_KEY·SESSION_PEPPER·API 키·백업 비밀문구)은 **대화창(Claude 포함)·메일·메신저·git·README 에 절대 붙여 넣지 않는다.**

목차: 1. 준비물과 비용 · 2. 테스트 서버 (한 번만) · 3. 운영 서버 (나중에) · 4. 배포할 때마다 · 5. 백업과 복구 · 6. 문제가 생겼을 때 · 7. 하지 말아야 할 것

---

## 1. 준비물과 비용

**준비물**

| 무엇 | 상태 | 비고 |
|---|---|---|
| Cloudflare 계정 | 있음 (다른 사이트에서 사용 중) | `kimbbob.xyz` 가 이 계정에 있어야 한다 |
| 도메인 `kimbbob.xyz` | 있음 | 테스트 서버 = `recruit.kimbbob.xyz` |
| 운영 도메인 (예: `kimbbob.com`) | 아직 없음 | 3장에서 |
| Node.js 22 이상, Git | PC 에 설치 | 로컬 실행(README)에 이미 쓰는 것 |
| Resend 계정 (메일 발송) | 아직 없음 | 2-6. **없으면 서버에서 아무도 로그인할 수 없다** |
| Claude API 키 (공고 자동 번역) | 있음 | 선택. 없으면 기업이 한국어를 직접 입력 |
| 비밀번호 관리 프로그램 또는 종이 | | ENC_KEY 등 보관 (2-4) |

**무료 플랜에서 이 사이트에 중요한 한도** (Cloudflare 요금 문서 https://developers.cloudflare.com/workers/platform/pricing/ , 2026-11 확인)

| 항목 | Workers Free | Workers Paid (계정당 최소 월 5달러) |
|---|---|---|
| 요청 | 하루 10만 | 월 1천만 포함 |
| 요청당 CPU 시간 | 10ms | 월 3천만 ms 포함 (요청당 한도가 넉넉함) |
| D1 읽기 / 쓰기 | 하루 500만 행 / 하루 10만 행 | 월 250억 / 5천만 행 포함 |
| D1 저장 | 5GB | 5GB 포함 |
| D1 Time Travel(되돌리기) | **7일** | **30일** (https://developers.cloudflare.com/d1/reference/time-travel/) |
| Workers Logs | 하루 20만 줄, 3일 보관 | 월 2천만 줄, 7일 보관 (https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| R2 (파일) | 월 10GB 저장, 쓰기 100만·읽기 1천만 회 무료 | 같음 + 초과분 과금 |

**유료 플랜(월 5달러)으로 바꿀 때:** 운영 서버에서 **실제 이력서를 받기 시작하기 전**(되돌리기 기간 30일, CPU 여유 — 이력서 첨부 암호화가 10ms 를 넘을 수 있다), 또는 테스트 중에 대시보드에서 CPU 초과 오류가 보일 때. 테스트 서버는 무료로 충분하다.

**Resend 무료 플랜** (https://resend.com/pricing , https://resend.com/docs/knowledge-base/resend-sending-limits , 2026-11 확인): **하루 100통**, 월 3,000통, 도메인 3개, 초당 10건.
하루 100통을 넘으면 그날은 메일이 나가지 않는다(로그인 코드 포함). 사이트의 하루 기업 메일 한도 `MAIL_SITE_DAY` 기본값은 1000 이라 무료 플랜보다 크다 —
무료 플랜으로 운영하는 동안은 `wrangler.jsonc` 의 `"MAIL_SITE_DAY": ""` 를 `"60"` 정도로 바꿔 로그인 코드 몫을 남겨 두기를 권한다(README "남용 방지 한도"). 유료(Pro)는 월 20달러, 하루 한도 없음.
조건 알림 메일(T-10)은 따로 `ALERT_MAIL_SITE_DAY`(기본 40, 0 = 끔)로 센다 — 위 60 과 합치면 100 이 되어 **인증코드 몫이 남지 않을 수 있다.** 무료 플랜 동안은 둘의 합이 70 정도가 되게(예: `MAIL_SITE_DAY` 40 + `ALERT_MAIL_SITE_DAY` 30) 정한다.
`ALERT_SEND_PER_RUN`(기본 8, 최대 10)은 예약 작업 한 번에 처리하는 알림 수다(무료 플랜 하위 요청 50개 안 — ARCHITECTURE 17-5).

**Claude API:** 공고 현지화 한 번에 호출 2번(초안 + 대조본). 비용은 Anthropic 콘솔에서 본다. 사이트 전체 하루 호출 한도 `LOCALIZE_SITE_DAY`(기본 500)가 비용 차단기다.

---

## 2. 한 번만 하는 설정 — 테스트 서버 (recruit.kimbbob.xyz)

테스트 서버에는 **가짜 데이터만** 넣는다. 실제 구직자·기업을 초대하지 않는다.

### 2-1. 최신 코드 받기

```
git checkout main
git pull
npm install
```

보여야 하는 것: 오류 없이 끝남. `npm install` 이 경고(WARN)를 보이는 것은 괜찮다.

### 2-2. Cloudflare 로그인

```
npx wrangler login
```

보여야 하는 것: 브라우저가 열리고 Cloudflare 로그인 → "Allow" 버튼 → PowerShell 에 `Successfully logged in`.
다르면: 브라우저가 안 열리면 PowerShell 에 나온 주소를 복사해 브라우저에 붙여 넣는다. **kimbbob.xyz 가 들어 있는 계정**으로 로그인해야 한다.

확인:

```
npx wrangler whoami
```

보여야 하는 것: 내 이메일과 계정 이름. 계정이 여러 개면 kimbbob.xyz 가 있는 계정의 Account ID 를 적어 둔다 (wrangler 가 계정을 고르라고 하면 그것을 고른다).

### 2-3. D1(데이터베이스)과 R2(파일 저장소) 만들기

```
npx wrangler d1 create recruit-test
```

보여야 하는 것: `database_id = "xxxxxxxx-xxxx-…"` 같은 줄(형식은 버전에 따라 다를 수 있다). wrangler 가 "설정 파일에 추가할까요?" 라고 물으면 **No** 로 답한다(아래처럼 손으로 바꾼다).

메모장으로 `wrangler.jsonc` 를 열어 **맨 위 구역**의 `"database_id": "REPLACE_WITH_D1_ID"` 에서 `REPLACE_WITH_D1_ID` 만 방금 나온 id 로 바꾸고 저장한다.
(아래쪽 `"production"` 구역의 `REPLACE_WITH_PROD_D1_ID` 는 건드리지 않는다.)
참고: 이 값을 바꾸면 내 PC 의 로컬 개발 DB 도 새로 만들어진다(로컬 DB 는 이 id 로 저장된다). 로컬 데이터는 가짜뿐이라 괜찮다 — start.bat 이 표를 다시 만든다.

R2 는 계정에서 한 번 켜야 쓸 수 있다. 켜지 않았으면 아래 명령이 `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` 로 실패한다.
켜는 법: https://dash.cloudflare.com → 왼쪽 메뉴 **Storage & databases → R2 → Overview** → 화면의 안내대로 R2 를 신청(결제 수단 등록을 요구한다. 무료 범위: 저장 10GB·월, 그 안이면 청구되지 않는다). 그다음 아래 명령을 다시 실행한다.

```
npx wrangler r2 bucket create recruit-test-files
```

보여야 하는 것: `Created bucket 'recruit-test-files'` 비슷한 줄. 【실제 환경에서 미확인】 R2 를 처음 쓰는 계정이면 대시보드에서 R2 사용을 먼저 켜라는(결제 정보 등록) 안내가 나올 수 있다 — 무료 한도 안에서는 요금이 나오지 않는다.

### 2-4. 비밀값 만들기와 보관 (가장 중요)

서버마다 **새 값**을 만든다. 내 PC 의 `.dev.vars` 값을 다시 쓰지 않는다.

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

→ 나온 한 줄이 **테스트 서버의 ENC_KEY**. 

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

→ 나온 한 줄이 **테스트 서버의 SESSION_PEPPER**.

**어디에 보관하나**
- 비밀번호 관리 프로그램(1Password, Bitwarden, KeePass 등)에 "recruit 테스트 ENC_KEY", "recruit 테스트 SESSION_PEPPER" 로 저장한다. 그리고 **종이에 한 부 인쇄**해 안전한 곳에 둔다 (운영 서버 키는 반드시).
- **ENC_KEY 를 잃으면 그 서버의 이력서·지원서 첨부는 영원히 열 수 없다.** 백업(5장)이 있어도 ENC_KEY 없이는 이력서를 읽을 수 없다. 한 번 넣은 뒤에는 바꾸지 않는다.
- SESSION_PEPPER 는 잃어도 데이터는 그대로다(바꾸면 모두 다시 로그인할 뿐).
- 대화창(Claude 포함)·메일·메신저·git·README·스크린샷에 넣지 않는다.

서버에 넣기 (명령마다 `Enter a secret value:` 가 나오면 값을 붙여 넣고 Enter — PowerShell 에서는 마우스 오른쪽 클릭이 붙여넣기다. 화면에 보이지 않는 것이 정상):

```
npx wrangler secret put ENC_KEY
npx wrangler secret put SESSION_PEPPER
```

보여야 하는 것: `Success! Uploaded secret ENC_KEY` 비슷한 줄.
다르면: 【실제 환경에서 미확인】 아직 한 번도 배포하지 않은 Worker 라서 "recruit-test 라는 Worker 가 없는데 새로 만들까요?" 같은 질문이 나오면 **y** 로 답한다. 오류로 끝나면 2-8 의 첫 배포를 먼저 하고 이 단계를 다시 한다.

확인 (값은 보이지 않고 이름만 나온다):

```
npx wrangler secret list
```

### 2-5. 공고 자동 번역 키 (선택)

Claude API 키가 있으면 같은 방법으로 넣는다 (Anthropic 콘솔에서 이 서버 전용 키를 새로 만드는 것을 권한다 — 문제가 생기면 그 키만 끌 수 있다):

```
npx wrangler secret put ANTHROPIC_API_KEY
```

넣지 않으면 기업이 한국어를 직접 입력한다. 넣은 뒤 관리자 → "현지화 엔진 비교"(`/admin/localize-test`)에서 시험한다 (TASKS T-05b).

### 2-6. Resend (메일 발송) 설정

테스트 서버는 메일 키가 없으면 **메일을 보내지도, 화면·기록에 출력하지도 않는다** → 로그인 인증코드를 받을 길이 없어 **아무도 로그인할 수 없다.** 그래서 첫 로그인 전에 이 단계가 필요하다.

1. https://resend.com 에서 가입한다 (무료).
2. 대시보드의 **Domains → Add Domain** 에서 `kimbbob.xyz` 를 추가한다.
   보여야 하는 것: 추가해야 할 DNS 레코드 몇 줄(종류 TXT·MX 등, 이름, 값).
3. 다른 탭에서 Cloudflare 대시보드 → `kimbbob.xyz` → **DNS → Records → Add record** 로 Resend 가 보여 준 레코드를 **하나씩 그대로** 넣는다.
   종류(Type)·이름(Name)·값(Content)·우선순위(Priority, MX 만)를 Resend 화면에서 **복사해 붙여 넣는다** (손으로 치지 않는다). 이 문서에 값을 적어 두지 않은 것은 계정마다 다르기 때문이다.
   【실제 환경에서 미확인】 Resend 화면에 Cloudflare 자동 연결 버튼이 있으면 그것을 써도 된다. 레코드에 "Proxy status(주황 구름)" 칸이 보이면 **DNS only(회색)** 로 둔다.
   **이미 있는 레코드(다른 사이트의 메일 등)는 지우거나 고치지 않는다.** 같은 이름의 TXT 레코드(SPF, `v=spf1 …`)가 이미 있다고 Cloudflare 가 알리면 멈추고 개발자에게 묻는다 (SPF 는 합쳐야 한다).
4. Resend 에서 **Verify** 를 누른다. 몇 분~몇 시간 걸릴 수 있다. 보여야 하는 것: 도메인 상태 `Verified`.
5. Resend → **API Keys → Create API Key** (권한: Sending access, 도메인: kimbbob.xyz). 키는 한 번만 보인다. 바로 서버에 넣는다:

```
npx wrangler secret put RESEND_API_KEY
```

6. 보내는 주소는 `wrangler.jsonc` 맨 위 구역의 `"MAIL_FROM": "Recruit <no-reply@kimbbob.xyz>"` 로 이미 적혀 있다. Resend 에서 다른 주소(예: 하위 도메인 `mail.kimbbob.xyz`)를 인증했다면 그 도메인으로 바꾼다.

### 2-7. 주소(recruit.kimbbob.xyz) 연결

`wrangler.jsonc` 에 이미 적혀 있다: `"routes": [{ "pattern": "recruit.kimbbob.xyz", "custom_domain": true }]`.
Custom Domain 방식이라 **배포할 때 Cloudflare 가 DNS 레코드와 인증서를 자동으로 만든다** (https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). 운영자가 DNS 를 손으로 만들 필요가 없다.

미리 확인할 것: Cloudflare 대시보드 → kimbbob.xyz → DNS 에 **`recruit` 라는 이름의 레코드(특히 CNAME)가 없어야 한다.** 있으면 Custom Domain 을 만들 수 없다(문서). 있으면 무엇에 쓰는지 확인한 뒤 지운다.

`workers_dev` 와 `preview_urls` 는 꺼 두었다 — 켜 두면 `…workers.dev` 라는 두 번째 주소로 Access 잠금(2-12) 없이 들어올 수 있다.

### 2-8. 첫 배포와 DB 표 만들기

```
npm run db:test:migrate
```

보여야 하는 것: 적용할 마이그레이션 목록(0001 ~ 0011)과 "적용할까요?" → **y** → 모두 ✅.
다르면: `REPLACE_WITH_…` 이야기가 나오면 2-3 을 다시 본다. 로그인 오류면 2-2.

```
npm run deploy:test
```

또는 탐색기에서 **`deploy-test.bat` 더블클릭**.
하는 일: 형식 검사 → 테스트(1~2분) → 설정 점검 → `wrangler deploy`.
노란 `Multiple environments are defined … no target environment was specified` 경고는 정상이다(맨 위 = 테스트 서버를 뜻한다).
보여야 하는 것: `[OK] 테스트 서버 배포 전 점검을 모두 통과했습니다.` → wrangler 출력 끝에 `recruit.kimbbob.xyz (custom domain)` 비슷한 줄 → `[OK] 배포했습니다.`
다르면: `[X]` 로 시작하는 줄이 고칠 것이다. 테스트 실패는 개발자에게 보낸다.

브라우저에서 https://recruit.kimbbob.xyz/api/health 를 연다. 보여야 하는 것: `{"ok":true,"env":"test"}`.
【실제 환경에서 미확인】 처음에는 인증서 발급에 몇 분 걸릴 수 있다. 10분이 지나도 안 열리면 대시보드 → Workers & Pages → recruit-test → Settings → Domains & Routes 에서 상태를 본다.

### 2-9. 관리자 계정 만들기 (+ 2단계 인증)

1. https://recruit.kimbbob.xyz/login 에서 내 이메일로 로그인(구직자 유형)한다. 인증코드 메일이 와야 한다(2-6).
2. PowerShell 에서 (이메일을 내 것으로 바꿔서):

```
npx wrangler d1 execute DB --remote --command "UPDATE users SET role='admin' WHERE email='내이메일@example.com'"
```

3. 사이트에서 로그아웃 → 다시 로그인 → 2단계 인증 등록 화면 → 휴대폰의 TOTP 인증 앱(Microsoft Authenticator, Google Authenticator, 1Password, 腾讯身份验证器 등 아무 앱)으로 QR 코드를 찍거나 "설정 키 입력" 으로 화면의 키 입력 → 6자리 입력
   → **복구 코드 8개가 한 번 표시된다. 종이·비밀번호 관리 프로그램에 저장**한 뒤 "저장했습니다 → 계속" → `/admin` 이 보이면 성공.
   인증 앱과 복구 코드를 모두 잃어버리면 README "관리자 계정 만들기" 의 DB 명령으로만 초기화할 수 있다. (자세히: README "관리자 계정 만들기")

### 2-10. /admin/system 에서 빨간 항목 고치기

https://recruit.kimbbob.xyz/admin/system 을 연다 (관리자 첫 화면 아래 "시스템 점검" 링크).

- 맨 위 상자가 초록(모든 항목 정상) 또는 노랑(알아 둘 항목)이면 된다. **빨강(문제)이 있으면 그 줄의 "고치는 법" 대로 고치고** 다시 배포(필요하면)한 뒤 이 화면을 다시 연다.
- 테스트 서버에서 노랑으로 남아도 되는 것: "약관·개인정보처리방침의 【확인 필요】"(운영 전까지 채우면 됨), "공고 현지화 엔진 없음"(키를 안 넣었을 때).
- 비밀값은 "설정됨/없음" 과 길이만 보인다. 값은 어디에도 나오지 않는다.

### 2-11. 확인 목록 (가짜 데이터로, 10분)

이메일은 내가 받을 수 있는 주소를 쓰되 **이름·전화번호·이력서는 가짜**로 쓴다. Gmail 이라면 `내아이디+seeker1@gmail.com` 처럼 `+` 를 붙이면 같은 메일함으로 온다 【Resend·Gmail 에서 실제로 확인하지 않음】.

1. 구직자 가입: 로그인 코드 메일이 1분 안에 온다 → 약관·개인정보 동의 화면이 나오고 체크해야 넘어간다.
2. 구직자: 이력서 만들기 (가짜 이름, 작은 PDF 첨부) → 첨부를 내려받아 열린다.
3. 다른 이메일로 기업 담당자 가입 → 기업 등록 → 검증 서류(가짜 PDF) 올리기.
4. 관리자: `/admin/companies` 에서 그 기업 승인.
5. 기업: 공고 작성(중국어) → 한국어 초안 만들기(엔진 키가 있으면 자동, 없으면 직접 입력) → 승인 → **게재**.
6. 비로그인 창(시크릿 창)에서 `/jobs` 에 그 공고가 보인다 (60초 걸릴 수 있다).
7. 구직자: 그 공고에 지원 → 기업 담당자에게 "새 지원자" 메일이 온다.
8. 기업: 지원자 목록 → 지원서 열기 → 구직자의 "지원 현황" 에 "기업이 열람함".
9. 관리자: `/admin/access-log` 에 열람 기록 한 줄.
10. 구직자: 계정 → 탈퇴 → 다시 로그인하면 새 계정(동의 다시)으로 시작한다.

다 되면 TASKS.md 의 O-항목에 표시한다. 어느 단계에서 막히면 그 화면을 캡처해 개발자에게.

### 2-12. 운영자만 들어오게 잠그기 (Cloudflare Access) — 권장

테스트 서버는 가짜 데이터만 있지만, 공개되면 검색엔진이나 다른 사람이 들어올 수 있다. Cloudflare Zero Trust → Access → Applications 에서 `recruit.kimbbob.xyz` 를 "내 이메일만 허용" 으로 잠근다.
【실제 환경에서 미확인 — 이 단계는 Cloudflare 문서를 따로 확인하지 않았다】 잠근 뒤에도 예약 작업(cron)은 그대로 돈다(외부 요청이 아니므로). 잠그면 Access 로그인을 먼저 거친 뒤 사이트 로그인을 한다.

---

## 3. 운영 서버 (나중에)

**먼저 모두 참이어야 한다** (하나라도 아니면 올리지 않는다):

- [ ] 운영 도메인(예: `kimbbob.com`)을 사서 **같은 Cloudflare 계정**에 추가했다 (대시보드 → Add a domain, 네임서버 변경까지 끝나 "Active").
- [ ] 직업정보제공사업 **신고를 마치고 신고번호**를 받았다 → `wrangler.jsonc` 의 production → `"REGISTRATION_NO"` 에 적는다. (비어 있으면 공고를 게재할 수 없다 — 코드가 막는다.)
- [ ] `src/legal/types.ts`·`terms.ts`·`privacy.ts` 의 `【확인 필요】`·`【待确认】` 을 모두 채우고 노무·개인정보 전문가 검토를 받았다 → `test/account.test.ts` 마지막 테스트와 `test/config-check.test.ts`·`test/deploy-checks.test.ts` 의 "지금 문서에는 표시가 남아 있다" 줄을 개발자가 `0` 기준으로 바꿨다 (README "이용약관·개인정보처리방침").
- [ ] Resend 에 **운영 도메인**을 추가해 Verified (2-6 과 같은 방법). 무료 플랜은 도메인 3개까지.
- [ ] 운영용 **새 ENC_KEY·SESSION_PEPPER** 를 만들어 보관했다 (2-4 와 같은 방법, 테스트 값과 다른 값, 종이 사본 필수).
- [ ] 유료 플랜(월 5달러)을 켰다 (1장, 권장).
- [ ] `npm run predeploy:prod` 가 `[OK]` (아래 3-1 다음).

### 3-1. 설정 파일 고치기

메모장으로 `wrangler.jsonc` 를 열고:
1. **바꾸기(Ctrl+H)** 로 `REPLACE_WITH_PRODUCTION_DOMAIN` 을 운영 도메인(예: `kimbbob.com`, `https://` 없이)으로 **모두 바꾸기**. (주소·보내는 사람·운영자 도메인이 한 번에 바뀐다.)
2. D1 만들기:

```
npx wrangler d1 create recruit-prod
```

   나온 id 로 production 구역의 `REPLACE_WITH_PROD_D1_ID` 를 바꾼다.
3. `"REGISTRATION_NO": ""` 에 신고번호를 적는다.
4. 저장 → git 에 커밋하고 main 에 올린다 (`predeploy:prod` 는 main 이고 저장하지 않은 변경이 없을 때만 통과한다 — 개발자에게 부탁해도 된다).

```
npx wrangler r2 bucket create recruit-prod-files
```

### 3-2. 비밀값 (운영)

운영 서버는 `ENC_KEY`·`SESSION_PEPPER`·`RESEND_API_KEY` 가 **없으면 배포 자체가 실패**하게 해 두었다 (`secrets.required`, https://developers.cloudflare.com/workers/configuration/secrets/ ). 그래서 배포 전에 넣는다. 모든 명령 끝에 `--env production` 이 붙는다 — **빠뜨리면 테스트 서버에 들어간다.**

```
npx wrangler secret put ENC_KEY --env production
npx wrangler secret put SESSION_PEPPER --env production
npx wrangler secret put RESEND_API_KEY --env production
npx wrangler secret put ANTHROPIC_API_KEY --env production
```

【실제 환경에서 미확인】 아직 없는 Worker(`recruit`)라 "새로 만들까요?" 라고 물으면 **y**. 만약 secret put 이 "Worker 가 없다" 는 오류로 끝나고 배포는 "비밀값이 없다" 로 실패해 서로 막히면, 멈추고 개발자에게 알린다(배포 때 비밀값을 같이 올리는 다른 방법이 있지만 비밀값을 파일로 만들어야 해서 이 문서에 적지 않았다).

### 3-3. DB 표 → 배포

```
npm run db:prod:migrate
npm run deploy:prod
```

- `db:prod:migrate`: 백업 안내 → 운영 도메인을 직접 입력해야 진행 → wrangler 가 목록을 보여 주고 한 번 더 묻는다.
- `deploy:prod`: 배포 전 점검(설정·약관 표시·git·형식·테스트) → 운영 도메인을 직접 입력 → 배포.
- 운영 서버에서는 Workers AI(현지화 엔진의 마지막 순서)도 켜져 있다 (`"ai"` 바인딩, 요금은 Cloudflare 계정에 청구 — Workers AI 무료 한도는 확인하지 않았다).

그다음 2-9(관리자, `--remote` 뒤에 `--env production` 을 붙인다), 2-10(`/admin/system`, 빨강 0), 2-11(확인 목록 — **운영 서버에서는 가짜 계정을 만든 뒤 반드시 탈퇴**)을 똑같이 한다.

```
npx wrangler d1 execute DB --remote --env production --command "UPDATE users SET role='admin' WHERE email='내이메일@example.com'"
```

---

## 4. 배포할 때마다

1. 최신 코드:

```
git checkout main
git pull
npm install
```

2. 테스트 서버에 먼저: **`deploy-test.bat` 더블클릭** (또는 `npm run deploy:test`). 새 마이그레이션 파일이 생겼다고 개발자가 알려 주면 먼저 `npm run db:test:migrate`.
3. https://recruit.kimbbob.xyz/admin/system — 빨강 없음, 바뀐 기능을 2-11 목록 중 관련된 것으로 확인.
4. (운영) **백업**: `backup-prod.bat` 더블클릭 (5-1).
5. (운영) 새 마이그레이션이 있으면 `npm run db:prod:migrate`.
6. (운영) `npm run deploy:prod`.
7. (운영) `/admin/system` 확인 → 다음 정각이 지난 뒤 로그에서 `maint: step=… ok` 한 줄을 본다 (6-3).

---

## 5. 백업과 복구

### 5-1. 매주 할 일 (운영 서버, 그리고 배포 전마다)

**`backup-prod.bat` 더블클릭** (또는 `npm run backup:prod`, 테스트 서버는 `npm run backup:test`).

1. 백업 비밀문구를 두 번 입력한다 (12자 이상, **영문·숫자**로 — 한글 입력기는 이 창에서 문제가 날 수 있다). 화면에 아무것도 보이지 않는 것이 정상이다.
2. wrangler 가 "내보내는 동안 DB 가 요청을 처리하지 못한다, 계속할까요?" 라고 물으면 y. (내보내는 동안 사이트가 잠깐 느리거나 오류가 날 수 있다 — https://developers.cloudflare.com/d1/best-practices/import-export-data/ . 사용자가 적은 시간에 한다.)
3. 보여야 하는 것: `[OK] 백업 파일: backups\production-YYYYMMDD-HHMM.sql.enc` 와 "임시 평문 파일은 지웠습니다".
4. 그 파일을 USB 나 클라우드 드라이브에도 복사한다. `backups` 폴더는 git 에 올라가지 않는다.

- **비밀문구는 ENC_KEY 와 같은 곳에 보관한다.** 잃으면 그 백업은 열 수 없다. 저장되거나 화면에 나오지 않는다.
- 파일은 AES-256-GCM 으로 암호화된다(키는 비밀문구에서 scrypt 로 만든다). 비밀문구가 틀리거나 파일이 바뀌면 풀리지 않는다.
- 이 백업은 **D1(DB)만** 담는다. 이력서 내용·첨부는 DB·R2 안에서도 ENC_KEY 로 암호화된 채라, 백업을 풀어도 ENC_KEY 없이는 읽을 수 없다.

### 5-2. 첫 번째 복구 수단: D1 Time Travel (되돌리기)

D1 은 따로 켜지 않아도 **지난 7일(무료) / 30일(유료)** 안의 아무 시점으로 DB 를 되돌릴 수 있다 (https://developers.cloudflare.com/d1/reference/time-travel/). 실수로 지웠거나 마이그레이션이 잘못됐을 때 먼저 이것을 쓴다.

```
npx wrangler d1 time-travel info DB --env production
```

(되돌릴 시각의 기록 확인. 테스트 서버는 `--env production` 을 뺀다.)

```
npx wrangler d1 time-travel restore DB --env production --timestamp=2026-12-01T09:00:00+09:00
```

- **DB 전체가 그 시각으로 덮어써진다.** 그 뒤에 들어온 지원·가입은 사라진다. 진행 중이던 요청은 오류가 난다. 먼저 점검 모드(6-2)를 켠다.
- 되돌린 뒤에도 출력에 나오는 "이전 bookmark" 로 다시 되돌릴 수 있다(문서). 그 값을 적어 둔다.
- R2 파일은 되돌려지지 않는다 → 5-4.
- 【실제 환경에서 미확인】 시각 형식은 문서의 예(RFC3339 또는 Unix 초)를 따랐다.

### 5-3. 백업 파일로 복구 (Time Travel 기간이 지났을 때) — **해 보지 않은 절차**

이 절차는 아직 한 번도 실제로 해 보지 않았다. **테스트 서버에서 한 번 연습(5-5)하기 전까지는 운영 서버에 쓰지 않는다.**

1. 풀기:

```
node scripts/restore-decrypt.mjs backups/production-20261201-0930.sql.enc
```

   → 같은 폴더에 `.sql` 이 생긴다. **개인정보가 평문으로 들어 있다** — 끝나면 바로 지운다.
2. 내보낸 파일은 `CREATE TABLE IF NOT EXISTS` 와 데이터 `INSERT` 로 되어 있어서, **이미 데이터가 있는 DB 에 넣으면 겹치는 행 때문에 실패**한다. 그래서 **새 빈 DB** 에 넣는다:

```
npx wrangler d1 create recruit-prod-restore
npx wrangler d1 execute recruit-prod-restore --remote --file=backups/production-20261201-0930.sql
```

   【실제 환경에서 미확인】 `cannot start a transaction` 이나 `Statement too long` 오류가 나면 멈추고 개발자에게 (문서: https://developers.cloudflare.com/d1/best-practices/import-export-data/ ).
3. 점검 모드(6-2)를 켠다 → `wrangler.jsonc` production 구역의 `database_name`·`database_id` 를 새 DB 로 바꾼다 → 배포 → `/admin/system`·확인 목록 → 점검 모드를 끈다.
4. 예전 DB 는 며칠 두었다가 개발자와 확인한 뒤 지운다(7장: DB 삭제는 하지 않는 것이 기본).

### 5-4. 이 백업에 없는 것: R2 파일

이력서·지원서 첨부(`rfiles/`)와 사업자 서류(`vdocs/`)는 R2 에 있고 **위 백업에 들어 있지 않다.** D1 을 되돌려도 R2 는 되돌려지지 않는다.

- R2 에는 D1 Time Travel 같은 시점 복구가 없다 (2026-11 R2 변경 기록에 버킷 버전 관리·시점 복구가 보이지 않았다 — https://developers.cloudflare.com/changelog/product/r2/ . 완전히 확인한 것은 아니다).
- 이력서 첨부는 ENC_KEY 로 암호화된 파일이라, 복사본이 새어도 내용은 보이지 않는다.
- 파일을 잃으면: 구직자 화면에 첨부를 열 수 없다고 나오고, 구직자가 다시 올리면 된다. 사업자 서류는 기업에 다시 요청한다. 이 서비스는 파일을 오래 두지 않는다(보관 기간 후 삭제) — 그래서 지금은 **R2 백업을 하지 않는 것**을 기본으로 둔다.
- (선택, 해 보지 않음) 따로 사본이 필요하면 `rclone` 같은 도구로 R2 를 S3 방식으로 PC 에 복사할 수 있다(R2 API 토큰 필요). 사본에도 보관 기간이 지나면 지우는 원칙이 적용되므로 개발자·개인정보 전문가와 먼저 상의한다.

### 5-5. 복구 연습 (테스트 서버에서 한 번)

1. `npm run backup:test` → 2. 테스트 서버에서 가짜 공고 하나 삭제·수정 → 3. 5-2 를 `--env production` 없이 해 본다 → 4. 5-3 을 `recruit-test-restore` 이름으로 해 본다(바인딩은 바꾸지 말고 `npx wrangler d1 execute recruit-test-restore --remote --command "SELECT COUNT(*) FROM users"` 로 행 수만 확인) → 5. 연습용 DB 를 지운다(이 연습용 DB 만, 이름을 두 번 확인).
해 본 날짜와 결과를 TASKS.md 에 적으면 이 장의 "해 보지 않은 절차" 표시를 지운다.

---

## 6. 문제가 생겼을 때

### 6-1. 방금 배포한 것을 되돌리기 (Worker 롤백)

대시보드: **Workers & Pages → recruit (또는 recruit-test) → Deployments → 되돌릴 버전 줄의 … → Rollback** (https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
명령:

```
npx wrangler rollback --env production
```

(테스트 서버는 `--env production` 을 뺀다. 버전을 고르라고 하면 문제가 생기기 전 버전을 고른다. 버전 id 를 안다면 `npx wrangler rollback <버전id> --env production`.)

- 최근 100개 버전까지 되돌릴 수 있다(문서). **코드만 되돌린다** — DB 표(마이그레이션)·데이터·R2 는 그대로다. 새 마이그레이션을 적용한 배포를 되돌리면 예전 코드가 새 표 모양에서 오류를 낼 수 있다 → 개발자에게.
- 롤백한 뒤 git 의 코드는 그대로이므로, 다음 배포 전에 개발자가 고친다.

### 6-2. 사이트 잠시 멈추기 (점검 모드)

`MAINTENANCE` 가 `"on"` 이면 관리자(2단계 인증 통과)·로그인 화면·`/api/health` 말고 모든 화면이 "점검 중입니다"(한국어·중국어, 503)가 된다. 저장된 공개 화면 캐시도 나가지 않는다. 예약 작업(cron)은 계속 돈다.

급할 때 (지금 코드 그대로, 점검 모드만 켜서 다시 배포 — main 에서 `git pull` 한 상태로):

```
npx wrangler deploy --env production --var MAINTENANCE:on
```

끄기:

```
npx wrangler deploy --env production --var MAINTENANCE:off
```

(테스트 서버는 `--env production` 을 뺀다.) 이 두 명령은 배포 전 점검을 건너뛰는 비상용이다. 오래 켜 둘 것이면 `wrangler.jsonc` 의 `"MAINTENANCE"` 를 `"on"` 으로 바꿔 커밋하고 평소대로 배포한다 — 그러지 않으면 다음 평소 배포 때 `"off"` 로 돌아간다.
【실제 환경에서 미확인】 `--var` 는 wrangler 4.166 의 `deploy` 에 있는 옵션이고 dry-run 으로 값이 들어가는 것만 확인했다.

### 6-3. 로그 보기 (`maint:` 줄 등)

- 대시보드: Workers & Pages → recruit-test(또는 recruit) → **Logs** (Workers Logs, 무료 3일 보관). 검색에 `maint:` 를 넣으면 매시 한 줄 `maint: step=<단계> ok counts={…}` 이 보인다. `failed` 가 있으면 개발자에게.
- 실시간: 

```
npx wrangler tail --env production
```

  (Ctrl+C 로 끝. 테스트 서버는 `--env production` 을 뺀다.)
- 개인정보 보호를 위해 **요청마다의 자동 기록(주소 등)은 끄고**(`invocation_logs: false`), 코드가 남기는 줄(`maint:`, `error:` 등)만 남긴다. 그 줄에는 이메일·이름·키가 없다.
- 【실제 환경에서 미확인】 cron 실행의 console 줄이 Workers Logs 에 보이는지는 문서에 명시되어 있지 않았다. 안 보이면 `wrangler tail` 을 정각 전에 켜 두고 본다.

### 6-4. 누구에게 연락하나

- 코드·배포 오류: 개발자 (오류 화면 캡처 + 실행한 명령, 비밀값은 가림).
- Cloudflare 계정·요금: Cloudflare 대시보드 → Support.
- 메일이 안 감: Resend 대시보드 → Emails/Logs 에서 실패 이유(하루 한도 `daily_quota_exceeded` 등) 확인.
- 개인정보 유출이 의심될 때: 점검 모드(6-2)를 켜고, 개발자와 개인정보 전문가에게 바로 연락한다 (신고 의무 여부는 전문가가 판단).

### 6-5. 테스트 서버에서도 Workers AI 를 쓰고 싶을 때

Workers AI 바인딩은 **운영 구역에만** 켰다. 맨 위(테스트) 구역은 로컬 개발(start.bat)도 같이 쓰는데, AI 바인딩은 로컬에서도 항상 Cloudflare 로 원격 연결하므로(https://developers.cloudflare.com/workers/local-development/) **로그인하지 않은 PC 에서 `wrangler dev` 가 시작되지 않는다** (이 저장소에서 직접 시험해 확인: "Failed to start the remote proxy session").
테스트 서버의 번역은 Claude API 키로 충분하다. 꼭 필요하면 개발자에게 "테스트 구역에 ai 바인딩 추가 + start.bat 은 로그인 필요" 로 바꿔 달라고 한다.

---

## 7. 하지 말아야 할 것

- **기능 플래그(`FLAG_…`)를 켜지 않는다.** 켜기 전 조건(고용노동부 1350 확인 등)이 docs/ARCHITECTURE.md 5장에 있다. `/admin/system` 이 켜진 플래그를 노랑으로 보인다.
- **테스트 서버·내 PC 에 실제 개인정보를 넣지 않는다.** 실제 이력서·실제 구직자 이메일은 운영 서버에만.
- **로컬(.dev.vars)의 키를 서버에 다시 쓰지 않는다. 테스트 키를 운영에 쓰지 않는다.** 서버마다 새로 만든다. `/admin/system` 은 로컬 예시 SESSION_PEPPER 를 빨강으로 보인다.
- **운영 서버의 ENC_KEY 를 바꾸지 않는다** (바꾸면 저장된 이력서를 열 수 없다).
- **`migrations/` 의 예전 파일을 고치지 않는다.** 바꿀 것이 있으면 개발자가 새 번호 파일을 만든다.
- **D1 데이터베이스를 지우지 않는다** (`wrangler d1 delete`, 대시보드 Delete). 지우면 Time Travel 로도 되돌릴 수 없다(문서에서 확인하지 않음 — 그래서 하지 않는다). 연습용 `…-restore` DB 만 예외.
- 명령 끝의 `--env production` 을 확인하지 않고 실행하지 않는다. 빠지면 테스트 서버, 붙으면 운영 서버다.
- 비밀값·백업 비밀문구를 대화창·메일·git 에 붙여 넣지 않는다. 풀어 놓은 `.sql` 파일을 남겨 두지 않는다.
