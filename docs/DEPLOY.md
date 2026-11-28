# 설치·운영 안내 (운영자용) — 내 PC 서버 (Node.js + PostgreSQL)

이 문서는 개발자가 아닌 운영자가 **recruit.kimbbob.xyz** 를 운영자 PC(Windows)에서 돌리고, 예전 Cloudflare 테스트 서버의 데이터를 옮기고, 백업하고,
문제가 생겼을 때 대처하는 방법을 순서대로 적은 것이다 (T-19). 각 단계는 "할 일 → 보여야 하는 것 → 다르게 나오면" 으로 적었다.

**읽기 전에 꼭 알아 둘 것**

- 이 서버는 **하나뿐**이다: `https://recruit.kimbbob.xyz` 를 개발·시연·시험에 함께 쓴다 (`.env` 의 `APP_ENV=test`, 메일은 Resend 로 실제 발송, 시연 계정 로그인 켬). 가짜 데이터만 넣는다.
- 이 문서의 명령은 개발 PC(리눅스)의 PostgreSQL 16 과 Node 26 으로 같은 순서를 해 보고 썼다. 하지만 **운영자의 Windows PC·서비스 관리 프로그램·Cloudflare Tunnel 에서는 아직 해 보지 않았다.**
  `【실제 환경에서 미확인】` 표시가 붙은 곳은 특히 화면·메시지가 다를 수 있다. 다르게 나오면 그 화면을 캡처해 개발자에게 보낸다 (비밀값이 보이는 부분은 가린다).
- 명령은 **Windows PowerShell** 에 **한 줄씩** 붙여 넣는다. 한 줄 실행 → 끝날 때까지 기다림 → 다음 줄.
- PowerShell 은 코드 폴더에서 연다: 탐색기에서 코드 폴더(예: `F:\works\Recruit-01`)를 연 뒤 주소창에 `powershell` 을 입력하고 Enter.
- 비밀값(ENC_KEY·SESSION_PEPPER·DB 비밀번호·API 키·백업 비밀문구)은 **대화창(Claude 포함)·메일·메신저·git·README 에 절대 붙여 넣지 않는다.** `.env` 파일 안에만 둔다.

목차: 1. 구성과 준비물 · 2. DB 만들기 · 3. .env 만들기 · 4. 처음 설치와 시험 실행 · 5. 서비스 관리 프로그램 등록 · 6. 예전 테스트 서버 데이터 가져오기 ·
7. 백업과 복구 · 8. 주소 전환 (Cloudflare Worker → 이 PC) · 9. 운영 중에 하는 일 · 10. Windows 보안 · 11. 운영 서버 (나중에) · 12. 하지 말아야 할 것

---

## 1. 구성과 준비물

```
브라우저 ──https──▶ Cloudflare (recruit.kimbbob.xyz) ──Cloudflare Tunnel──▶ 이 PC 의 127.0.0.1:8787 (Node 서버)
                                                                              ├─ PostgreSQL 16 (localhost:5433, DB recruit)
                                                                              ├─ 첨부파일 F:\works\Recruit-01-data\files
                                                                              ├─ 백업     F:\works\Recruit-01-data\backups
                                                                              └─ 바깥 API: Resend(메일) · Claude/Gemini(공고 번역) — 서버에서만
```

| 무엇 | 어디 | 비고 |
|---|---|---|
| Node.js 26 | `F:\works\node-v26.13.1-win-x64` | 서비스 관리 프로그램이 이 Node 를 쓴다 |
| PostgreSQL 16.16 | 이 PC, 포트 **5433** | 설치 때 정한 `postgres` 관리자 비밀번호가 필요하다 |
| 코드 폴더 | 예: `F:\works\Recruit-01` (git) | 데이터 폴더와 **다른** 곳이어야 한다 |
| 데이터 폴더 | `F:\works\Recruit-01-data` (`files\`, `backups\`) | 서버가 없으면 만든다. 코드 폴더 안이면 서버가 시작하지 않는다 |
| 서비스 관리 프로그램 | 운영자가 쓰는 프로그램 | 서버를 켜고 Cloudflare Tunnel 을 붙인다 (5장) |
| Resend 키 | Resend 대시보드 | **없으면 아무도 로그인할 수 없다** (인증코드 메일) |
| 예전 테스트 서버의 ENC_KEY·SESSION_PEPPER | 비밀번호 관리 프로그램·종이 (예전 DEPLOY.md 2-4 대로 보관한 것) | 데이터를 가져오려면 **같은 값**이어야 한다 (3-1) |

**Resend 무료 플랜:** 하루 100통(로그인 인증코드 포함). 관리자 화면 → 사이트 설정 → "사용량 한도" 에서 "기업 메일 — 사이트 전체 하루" 40, "조건 알림 메일 — 사이트 전체 하루" 30 을 권한다 (README "남용 방지 한도").

---

## 2. DB 만들기 (한 번만)

PostgreSQL 에 이 사이트만 쓰는 계정 `recruit` 와 DB `recruit` 를 만든다. `recruit` 계정은 관리자 권한 없이 자기 DB 만 쓴다 (가장 작은 권한).

1. 새 비밀번호를 만든다 (영문·숫자만 나오게 해서 접속 문자열에 그대로 쓸 수 있게):

```
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

   → 나온 한 줄을 비밀번호 관리 프로그램에 "recruit DB 비밀번호" 로 저장한다.

2. PostgreSQL 관리자(`postgres`)로 접속한다 (설치 때 정한 비밀번호를 묻는다):

```
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U postgres
```

   보여야 하는 것: `postgres=#` 로 끝나는 줄.

3. `postgres=#` 뒤에 한 줄씩 넣는다 (`새비밀번호` 를 1의 값으로 바꾼다. 따옴표는 그대로):

```
CREATE ROLE recruit LOGIN PASSWORD '새비밀번호';
CREATE DATABASE recruit OWNER recruit ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE recruit FROM PUBLIC;
\q
```

   보여야 하는 것: `CREATE ROLE`, `CREATE DATABASE`, `REVOKE`. 다르면: `already exists` 는 이미 만든 것 — 넘어간다.
   `recruit` 계정에는 SUPERUSER·CREATEDB·CREATEROLE 을 주지 않는다. 표는 4장의 `npm run db:migrate` 가 `recruit` 계정으로 만든다 (DB 주인이라 할 수 있다).

4. 확인 (비밀번호를 묻는다 — 1의 값):

```
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U recruit -d recruit -c "select current_user"
```

   보여야 하는 것: `recruit`.

---

## 3. .env 만들기

서버 설정은 코드 폴더의 **`.env`** 파일 하나에 있다. git 에 올라가지 않는다(`.gitignore`). 예시 파일을 복사해서 만든다:

```
Copy-Item .env.example .env
notepad .env
```

메모장에서 아래 값을 채우고 저장한다 (한 줄에 `이름=값`, 값에 공백이 있으면 큰따옴표로 감싼다).

### 3-1. 비밀값 (가장 중요)

| 이름 | 무엇을 넣나 |
|---|---|
| `ENC_KEY` | **예전 Cloudflare 테스트 서버에 넣었던 ENC_KEY 그대로.** 이력서·지원서 첨부·2단계 인증 비밀키가 이 키로 암호화되어 있다 |
| `SESSION_PEPPER` | **예전 테스트 서버의 SESSION_PEPPER 그대로.** 복구 코드·알림 해지 링크의 해시가 이 값에 묶여 있다 |
| `DATABASE_URL` | `postgres://recruit:2장의비밀번호@localhost:5433/recruit` |
| `RESEND_API_KEY` | Resend 키 (3-2) |
| `ANTHROPIC_API_KEY` | (선택) Claude 키 — 공고 한국어 초안. 기본 엔진 |
| `GEMINI_API_KEY` | (선택) Gemini 키 |

- Cloudflare 는 비밀값을 다시 보여 주지 않는다 (`wrangler secret list` 는 이름만). 예전에 비밀번호 관리 프로그램·종이에 보관한 값을 쓴다.
- **두 값을 찾을 수 없으면:** 데이터를 가져와도 이력서·첨부를 열 수 없다 (6장의 가져오기가 ENC_KEY 를 확인하고 멈춘다). 그때는 가져오지 말고 새 값으로 빈 DB 에서 시작한다 — 새 값 만들기:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

  (첫 줄 = ENC_KEY, 둘째 줄 = SESSION_PEPPER.)
- **ENC_KEY 를 잃으면 이력서·지원서 첨부는 영원히 열 수 없다.** 백업(7장)이 있어도 마찬가지다. 한 번 넣은 뒤에는 바꾸지 않는다. 비밀번호 관리 프로그램 + 종이 한 부.
- `DATABASE_URL` 의 비밀번호에 `@ : / # ?` 가 있으면 `%40 %3A %2F %23 %3F` 로 바꿔 적는다 (2장의 명령으로 만들면 생기지 않는다).

### 3-2. Resend (메일 발송)

예전 테스트 서버에서 쓰던 Resend 계정·도메인(`kimbbob.xyz`) 인증을 그대로 쓴다. 키만 `.env` 의 `RESEND_API_KEY=` 뒤에 붙인다
(Resend → API Keys → Create API Key, 권한 Sending access, 도메인 kimbbob.xyz — 이 PC 전용 키를 새로 만드는 것을 권한다. 문제가 생기면 그 키만 끈다).
보내는 주소는 `MAIL_FROM="Recruit <no-reply@kimbbob.xyz>"` (예시 파일에 이미 있다).

### 3-3. 그 밖의 값 (예시 파일에 기본값이 있다)

| 이름 | 값 | 비고 |
|---|---|---|
| `APP_ENV` | `test` | 이 서버 하나 (가짜 데이터만). 나중의 운영 서버만 `production` |
| `APP_ORIGIN` | `https://recruit.kimbbob.xyz` | 끝에 `/` 없이 |
| `PORT` | `8787` | 서버는 127.0.0.1 에서만 듣는다 |
| `DATA_DIR` | `F:\works\Recruit-01-data` | 첨부파일은 그 아래 `files\` |
| `BACKUP_DIR` | (비움) | 비우면 `DATA_DIR\backups` |
| `PG_BIN` | (비움) | 비우면 `C:\Program Files\PostgreSQL\16\bin` (백업의 pg_dump) |
| `MAIL_FROM` | `"Recruit <no-reply@kimbbob.xyz>"` | |
| `OPERATOR_DOMAINS` | `kimbbob.xyz,kimbbob.com,nexthub.me` | 공고 연락처로 쓸 수 없는 운영자 도메인 |
| `REGISTRATION_NO` | (비움) | 직업정보제공사업 신고번호 — 운영 서버에서만 |
| `FLAG_PRODUCTION_JOBS` · `FLAG_HEADHUNTER_POSTING` · `FLAG_RESUME_ZH_SUMMARY` · `FLAG_PAID_LABEL` | `off` | **켜지 않는다** (ARCHITECTURE 5장) |
| `MAINTENANCE` | `off` | 점검 모드 (9-1) |
| `DEMO_LOGIN` | `on` | 시연 계정 로그인 (이 서버만. 운영은 off) |
| `LOCALIZE_ENGINE` · `LOCALIZE_CLAUDE_MODEL` · `LOCALIZE_GEMINI_MODEL` | (비움) | 비우면 claude → gemini, 코드의 기본 모델 |
| `OPS_EMAIL` | (선택) | 매일 09시 정리 작업 보고(개수만)를 받을 주소 |
| `LOCALIZE_PER_COMPANY_DAY` … `ALERT_SEND_PER_RUN` | (비움) | 남용 방지 한도. 보통은 관리자 화면에서 바꾼다 |
| `SCHEDULER` | `on` | 매시 정각의 정리 작업. 끄지 않는다 |
| `BACKUP_AUTO` · `BACKUP_PASSPHRASE` · `BACKUP_KEEP` | `off` · (비움) · `14` | 자동 백업 (7-4) |

---

## 4. 처음 설치와 시험 실행

코드 폴더의 PowerShell 에서 (Node 26 을 이 창에서 먼저 쓰게 한다):

```
$env:Path = "F:\works\node-v26.13.1-win-x64;" + $env:Path
node --version
npm ci
npm run db:migrate
npm run build
npm start
```

보여야 하는 것:
- `node --version` → `v26.13.1`
- `npm run db:migrate` → `적용: 0001_init.sql` → `[OK] 1개 적용, 0개는 이미 적용됨.` (두 번째부터는 `새로 적용할 것이 없습니다`)
- `npm run build` → `[OK] dist/server.mjs, dist/maint.mjs`
- `npm start` → `server: env=test listen=127.0.0.1:8787 origin=https://recruit.kimbbob.xyz scheduler=on auto_backup=off`

다르면:
- `[X] .env 에 … 없습니다` → 3장. `PostgreSQL 에 연결하지 못했습니다` → PostgreSQL 서비스가 켜져 있는지(Windows "서비스" 앱의 `postgresql-x64-16`)와 `DATABASE_URL`.
- `서버를 열 수 없습니다 (EADDRINUSE)` → 8787 을 다른 프로그램(예: 예전 `wrangler dev`)이 쓰고 있다. 그것을 끈다.
- `DATA_DIR 가 코드 폴더 안에 있습니다` → `DATA_DIR` 을 코드 폴더 밖으로.

브라우저(이 PC)에서 http://127.0.0.1:8787/api/health → `{"ok":true,"env":"test"}`. 끄려면 PowerShell 창에서 **Ctrl+C** (`server: stopped`).
【실제 환경에서 미확인】 `APP_ENV=test` 는 로그인 쿠키에 Secure 표시를 붙인다. http://127.0.0.1 에서 로그인이 안 되면 터널 주소(https)로 시험한다 — 서버 자체의 문제가 아니다.

`start.bat` 을 더블클릭해도 같은 순서(설치 → db:migrate → build → start)로 켜진다 (손으로 켤 때만. 평소에는 5장의 서비스 관리 프로그램).

---

## 5. 서비스 관리 프로그램 등록

운영자의 서비스 관리 프로그램에 아래 값으로 하나 등록한다. 【실제 환경에서 미확인 — 프로그램의 칸 이름은 다를 수 있다】

| 칸 | 값 |
|---|---|
| 이름 | `recruit` |
| 작업 폴더 | 코드 폴더 (예: `F:\works\Recruit-01`) |
| Node 경로 | `F:\works\node-v26.13.1-win-x64\node.exe` (npm 은 같은 폴더의 `npm.cmd`) |
| 빌드 명령 | `npm run build` |
| 시작 전 명령 | `npm run db:migrate` (실패하면 서버를 켜지 않게 — 종료 코드 1) |
| 시작 명령 | `npm start` (= `node --env-file=.env dist/server.mjs`) |
| 포트 | `8787` |
| 듣는 주소 | `127.0.0.1` (서버가 스스로 127.0.0.1 에만 연다) |
| 서브도메인 (터널) | `recruit` → `https://recruit.kimbbob.xyz` → `http://127.0.0.1:8787` |
| 디버거 / inspect | **끔** (켜 두면 서버가 시작하지 않는다 — 디버거 포트는 PC 의 모든 것을 열 수 있다) |
| 자동 재시작 | 켬 (서버가 죽으면 다시) |
| 끄는 방법 | Ctrl+C(SIGINT) 또는 종료 신호 — 서버가 돌고 있는 정리 작업을 기다린 뒤 끝난다 (최대 30초) |
| 로그 | 서버 출력(`server:`, `maint:`, `error:` 줄)을 남긴다. 이메일·비밀값은 찍히지 않는다 |

코드를 고친 뒤(git pull)에는 서비스 관리 프로그램에서 **다시 시작** → 빌드 → 시작 전 명령(마이그레이션) → 시작 순서로 돈다.
같은 DB 로 서버를 두 개 켜지 않는다 (켜도 정리 작업은 DB 잠금으로 한쪽만 돌지만, 공개 화면 캐시는 서버마다 따로다).

---

## 6. 예전 테스트 서버 데이터 가져오기 (한 번만)

예전 Cloudflare 테스트 서버(D1 `recruit-test` + R2 `recruit-test-files`)의 데이터를 이 PC 로 옮긴다. **세션·로그인 대기는 옮기지 않는다** → 모두 다시 로그인한다.
【실제 환경에서 미확인 — 가짜 내보내기와 가짜 wrangler 로만 시험했다 (test/import.test.ts). 실제 Cloudflare 계정으로는 해 보지 않았다】

준비: 4장까지 끝남 (`npm run db:migrate` 를 한 빈 DB), `.env` 의 ENC_KEY·SESSION_PEPPER 가 예전 서버의 값, 이 PC 에서 `npx wrangler login` 이 되어 있음.
가져오는 동안 서버는 꺼 두기를 권한다 (서비스 관리 프로그램에서 멈춤).

1. 미리 보기 (아무것도 바꾸지 않는다):

```
npm run import:cloudflare -- --dry-run
```

   보여야 하는 것: `1) Cloudflare 에서 D1 을 내려받습니다` → `2) … [OK] 암호문 N개가 풀립니다.` → 표마다 `내보내기 N · 새로 N · 이미 있음 0` → `[미리 보기] 되돌렸습니다` → 파일 `받을 것 N`.
   다르면:
   - `ENC_KEY 가 예전 테스트 서버의 키와 다릅니다` → 3-1. **그대로 가져오지 않는다.**
   - `충돌: users id=… (users_email_key)` → PostgreSQL 에 같은 이메일로 먼저 만든 계정(예: 시험 로그인)이 있다. 개발자와 함께 그 계정을 정리한 뒤 다시.
   - `D1 내려받기가 실패했습니다` → `npx wrangler login` 을 다시 하고, 계정이 여러 개면 개발자에게 (`--d1-id` 로 DB id 를 줄 수 있다).
2. 실제로 가져오기:

```
npm run import:cloudflare
```

   보여야 하는 것: `[OK] DB 에 넣었습니다.` → `이미 있음 0 · 받음 N · 없음 0` → `[끝]`. 중간에 끊겨도 **같은 명령을 다시 실행**하면 된다 (이미 있는 행·파일은 건너뛴다).
   `R2 에 없음: rfiles/…` 은 예전 서버에서도 파일이 없던 것이다 (그 지원서는 첨부 없이 보인다). 목록을 개발자에게 보낸다.
   `R2 목록 명령이 없어 …` 는 정상이다 (DB 가 가리키지 않는 남은 파일은 옮길 필요가 없다).
3. 서버를 켜고 `/admin/system` → 관리자 로그인(예전 인증 앱 번호 그대로) → 구직자·기업 시험 계정으로 로그인 → 이력서 첨부 내려받기가 열리는지 본다.
4. 가져오기에 쓴 임시 파일(내보낸 .sql)은 스크립트가 지운다. 다 끝나면 wrangler 는 더 필요 없다 (T-20 에서 지운다).

---

## 7. 백업과 복구

백업 파일 하나에 **DB 전체(pg_dump) + 첨부파일 폴더**가 들어 있고, 비밀문구(scrypt) + AES-256-GCM 으로 암호화된다. 평문은 디스크에 쓰지 않는다.
**`.env`(ENC_KEY 등)는 백업에 들어 있지 않다** — 따로 보관한다 (3-1). ENC_KEY 없이는 백업을 풀어도 이력서를 읽을 수 없다.

### 7-1. 손으로 백업 (매주, 그리고 코드를 크게 바꾸기 전)

```
npm run backup
```

비밀문구를 두 번 입력한다 (12자 이상, 화면에 보이지 않는다). 비밀문구를 잃으면 백업을 풀 수 없다 — 비밀번호 관리 프로그램에 "recruit 백업 비밀문구" 로.
보여야 하는 것: `[OK] 백업 파일: F:\works\Recruit-01-data\backups\recruit-20261128-0930.enc (DB … KB, 첨부파일 N개)`.
다르면: `pg_dump 를 실행할 수 없습니다` → `.env` 의 `PG_BIN` 을 `C:\Program Files\PostgreSQL\16\bin` 으로.

### 7-2. PC 밖 사본

그 `.enc` 파일을 USB·클라우드 드라이브에도 한 부 복사한다. PC 디스크가 망가지면 PC 안의 백업도 같이 없어진다.

### 7-3. 복구 — **해 보지 않은 절차 (개발 PC 에서 pg_restore 까지만 확인)**

```
npm run restore -- "F:\works\Recruit-01-data\backups\recruit-20261128-0930.enc"
```

비밀문구를 넣으면 같은 폴더에 `…-restored` 폴더가 생긴다: `db.dump`(DB) · `files\`(첨부파일) · **`RESTORE-STEPS.txt`(복구 순서)**.
그 파일의 순서대로 한다: 서버 멈춤 → 지금 DB 를 `recruit_old` 로 이름 바꾸기 → 빈 `recruit` DB → `pg_restore` → 첨부파일 폴더 바꾸기 → ENC_KEY 확인 → 서버 켜기 → 확인 → 옛것 지우기.
**풀린 폴더에는 개인정보가 평문으로 들어 있다.** 끝나면 바로 지운다.
예전 Cloudflare 백업(`….sql.enc`)도 같은 명령으로 풀린다 (SQLite 문법이라 6장의 `--sql <파일>` 로 가져온다).

### 7-4. 자동 백업 (선택) — 장단점

`.env` 에 `BACKUP_AUTO=on` 과 `BACKUP_PASSPHRASE=…`(12자 이상)를 넣으면 서버가 **매일 한국 시간 03시**에 백업하고 최근 `BACKUP_KEEP`(14)개만 남긴다.
- 좋은 점: 잊지 않는다.
- 나쁜 점: **비밀문구가 `.env` 에 평문으로 남는다.** 이 PC 를 손에 넣은 사람은 `.env`(ENC_KEY 포함)와 백업을 모두 가진다 → 자동 백업은 "PC 고장" 에는 도움이 되지만 "PC 도난" 에는 도움이 되지 않는다.
  BitLocker(10장)를 켜고, PC 밖 사본(7-2)은 손으로 한 백업(다른 비밀문구)을 쓰기를 권한다.

### 7-5. 복구 연습 (한 번)

시험용 DB 이름(예: `recruit_restoretest`)으로 RESTORE-STEPS 의 3·4 단계만 해 보고, 표가 들어갔는지 본 뒤 그 DB 를 지운다:

```
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U postgres -c "CREATE DATABASE recruit_restoretest OWNER recruit ENCODING 'UTF8' TEMPLATE template0"
& "C:\Program Files\PostgreSQL\16\bin\pg_restore.exe" -h localhost -p 5433 -U recruit -d recruit_restoretest --no-owner --exit-on-error db.dump
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U postgres -d recruit_restoretest -c "select count(*) from users"
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U postgres -c "DROP DATABASE recruit_restoretest"
```

---

## 8. 주소 전환: recruit.kimbbob.xyz 를 Cloudflare Worker 에서 이 PC 로 (T-20) — 【실제 환경에서 미확인】

지금은 예전 Worker(`recruit-test`)가 이 주소를 쓰고 있다. 6장의 가져오기가 끝난 **뒤에** 한다. 전환하는 동안 몇 분 사이트가 열리지 않을 수 있다.

1. 예전 서버에 쓰기가 더 생기지 않게: 가능하면 가져오기 직전에 예전 테스트 서버를 점검 모드로 두거나(예전 방법), 사용자에게 "잠시 멈춤" 을 알린다. 가져오기를 한 번 더 실행해 그사이의 데이터를 받는다 (6-2, 다시 실행해도 된다).
2. Cloudflare 대시보드 → **Workers & Pages → recruit-test → Settings → Domains & Routes** 에서 `recruit.kimbbob.xyz` (Custom Domain) 를 **지운다** (Worker 자체는 지우지 않는다 — 되돌릴 수 있게).
   그러면 Cloudflare 가 만들었던 DNS 레코드도 없어진다. kimbbob.xyz → DNS 에 `recruit` 레코드가 남아 있지 않은지 본다.
3. 서비스 관리 프로그램에서 터널 이름(호스트) `recruit.kimbbob.xyz` → `http://127.0.0.1:8787` 로 연결한다 (5장). 터널이 DNS 레코드(CNAME `…cfargotunnel.com`)를 만든다.
4. 확인: 다른 기기(휴대폰 LTE)에서 https://recruit.kimbbob.xyz/api/health → `{"ok":true,"env":"test"}` → 로그인 메일이 오는지 → 관리자 `/admin/system` 에 빨간 줄이 없는지.
5. 되돌리기: 터널 호스트를 끄고 2에서 지운 Custom Domain 을 Worker 에 다시 추가한다 (예전 Worker 는 예전 데이터로 그대로 돈다).
6. 며칠 문제가 없으면 Cloudflare 정리 (T-20): Worker `recruit-test` 삭제, D1 `recruit-test`·R2 `recruit-test-files` 는 **백업을 한 번 더 받은 뒤** 지운다, `npx wrangler logout`, `npm uninstall wrangler`.
   Cloudflare Access 로 이 주소를 잠가 두었다면 그 설정은 터널 주소에도 그대로 쓸 수 있다 (같은 호스트 이름).

---

## 9. 운영 중에 하는 일

### 9-1. 사이트 잠시 멈추기 (점검 모드)

`.env` 의 `MAINTENANCE=on` 으로 바꾸고 서비스 관리 프로그램에서 **다시 시작**. 관리자(2단계 인증 통과)·로그인 화면·`/api/health` 말고 모두 "점검 중입니다"(503)가 된다. 정리 작업은 계속 돈다.
끝나면 `MAINTENANCE=off` → 다시 시작.

### 9-2. 로그 보기 (`maint:` 줄)

서비스 관리 프로그램의 로그 창에서 본다. 매시 정각 `maint: step=<단계> ok counts={…}` 한 줄씩 (실패면 `failed`). 겹쳐서 건너뛰면 `maint: skipped reason=…`.
`/admin/system` 의 "예약 작업" 줄에 마지막 실행이 몇 분 전인지 보인다 (2시간이 넘으면 빨강). 이메일·이름·키는 로그에 찍히지 않는다.

### 9-3. 정리 작업 단계 하나를 지금 실행 (시험·문제 확인용)

```
npm run maint -- closeJobs
```

(단계 이름: closeJobs · markApplications · purgeApplications · dropOldRows · purgeVerificationDocs · sweepOrphans · report · sendAlerts.)
서버의 정각 실행과 같은 DB 잠금을 잡는다 — 정각 실행과 겹치면 "다른 예약 작업이 돌고 있습니다" 로 끝난다. HTTP 로 실행하는 길은 없다.

### 9-4. 코드 업데이트

```
git pull
```

→ 서비스 관리 프로그램에서 다시 시작 (빌드·마이그레이션·시작이 차례로 돈다). 큰 변경 전에는 7-1 백업.

### 9-5. 관리자 계정 만들기

1. https://recruit.kimbbob.xyz/login 에서 내 이메일로 한 번 로그인(구직자 유형)한다.
2. PowerShell (이메일을 내 것으로):

```
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -p 5433 -U recruit -d recruit -c "UPDATE users SET role='admin' WHERE email='내이메일@example.com'"
```

3. 로그아웃 → 다시 로그인 → 인증 앱 등록(QR 또는 키) → 6자리 → **복구 코드 8개 보관** → `/admin`. 자세히: README "관리자 계정 만들기".

### 9-6. 문제가 생겼을 때 · 연락

- 사이트가 안 열림: 서비스 관리 프로그램에서 서버가 돌고 있는지 → PostgreSQL 서비스 → 터널 상태 → `/api/health`.
- 코드·설치 오류: 개발자 (오류 화면 캡처 + 실행한 명령, 비밀값은 가림).
- 메일이 안 감: Resend 대시보드 → Emails/Logs (하루 한도 `daily_quota_exceeded` 등).
- 개인정보 유출이 의심될 때: 점검 모드(9-1)를 켜고 개발자와 개인정보 전문가에게 바로 연락한다.

### 9-7. 대량 테스트 데이터 넣기·지우기 (T-21 — 테스트 서버·개발 PC 전용)

목록·필터·페이지·지원자 화면·관리자 화면을 공고 약 500건 규모로 시험해 볼 때 쓴다. 넣는 데이터는 모두 지어낸 것이다
(기업·구직자 이름에 "(가상)", 메일 주소는 받는 사람이 없는 `@bulk.demo.example` — 메일이 나가지 않는다). 시연 계정 데이터와 운영자가 만든 데이터는 건드리지 않는다.

```
npm run build
npm run seed:bulk                    (기본: 공고 500 · 기업 60 · 구직자 300 · 지원 1200, 개발 PC 에서 약 5초)
npm run seed:bulk -- --dry-run       (무엇을 만들지 개수만 보기)
npm run seed:bulk -- --remove        (대량 테스트 데이터만 지우기, 첨부파일 포함)
npm run seed:bulk -- --jobs 200 --companies 20 --seekers 100 --applications 400   (개수 바꾸기)
```

- `seed:bulk` 는 빌드된 파일(`dist/bulk-seed.mjs`)을 실행한다 — 코드를 받은 뒤 한 번 `npm run build` (서비스 관리 프로그램이 시작할 때 빌드하므로 보통은 이미 있다).
- 같은 조건으로 다시 실행하면 아무것도 바꾸지 않는다. 개수를 바꿔 실행하면 대량 데이터만 지우고 다시 만든다.
- 대량 공고에 다른 회원(예: 시연 구직자, 직접 만든 계정)이 지원했다면 `--remove` 때 그 지원도 공고와 함께 지워지고 개수가 안내된다.
- 대량 계정(기업·구직자)으로는 **로그인할 수 없다** (인증코드 메일이 가지 않는 주소). 화면은 비로그인 목록·관리자 화면으로 보거나, 시연 계정(로그인 화면의 시연 칸)을 쓴다.
- 출력에는 개수와 걸린 시간만 나온다.
- **운영 서버에서는 절대 실행하지 않는다.** `APP_ENV=production` 이면 DB 에 연결하기 전에 거절하고 끝난다. 그래도 운영 PC 의 `.env` 로는 실행하지 않는다.

---

## 10. Windows 보안

- **포트 5433(PostgreSQL)·8787(서버)를 방화벽에서 열지 않는다.** 바깥에서는 Cloudflare Tunnel 로만 들어온다. 서버는 스스로 127.0.0.1 에만 연다.
  PostgreSQL 의 `postgresql.conf` 는 `listen_addresses = 'localhost'` 로 두고, `pg_hba.conf` 는 `127.0.0.1/32`·`::1/128` 에서 `scram-sha-256` 만 둔다 【실제 환경에서 미확인 — 설치 기본값을 확인한다】.
- 서버는 요청의 IP 로 판단하지 않는다. 앞으로 IP 가 필요하면 터널이 붙이는 `CF-Connecting-IP` 만 믿는다 (`X-Forwarded-For` 는 누구나 꾸밀 수 있다) — 그래서 8787 이 바깥에 열리면 안 된다.
- **BitLocker** 로 `F:`(코드·데이터·백업) 와 PostgreSQL 데이터 폴더가 있는 디스크를 암호화한다. `.env` 에 비밀값이 평문으로 있기 때문이다.
- DB 계정: 사이트는 `recruit` 계정만 쓴다 (2장, 관리자 권한 없음). `postgres` 관리자 비밀번호는 사이트 설정에 넣지 않는다.
- `.env`·`F:\works\Recruit-01-data` 는 이 PC 의 Windows 계정만 읽게 한다 (공유 폴더로 두지 않는다).
- Windows 업데이트·백신은 켜 둔다. 원격 데스크톱을 쓰면 강한 비밀번호 + 2단계 인증.

---

## 11. 운영 서버 (나중에)

실제 구직자를 받는 운영 서버는 **다른 PC 또는 다른 DB·폴더·`.env`** 로 따로 둔다 (지금 서버의 데이터·키를 쓰지 않는다). 올리기 전에:

```
npm run predeploy:prod -- --env-file "운영서버의\.env"
```

점검: `APP_ENV=production` · 필수 값 · `REPLACE_WITH_…` 없음 · 신고번호(`REGISTRATION_NO`) · https 주소 · `DEMO_LOGIN=off` · 약관·방침의 【확인 필요】 0개 · git main·저장하지 않은 변경 없음 · 형식 검사 · 테스트.
그 밖에 할 일: 운영 도메인, Resend 운영 도메인, 새 ENC_KEY(종이 보관), 약관·방침 전문가 검토, 개인정보처리방침의 국외 이전·보관 위치 문구 확인 (Cloudflare 에 데이터를 두지 않게 바뀌었다 — TASKS T-20).

---

## 12. 하지 말아야 할 것

- **기능 플래그(`FLAG_…`)를 켜지 않는다.** 켜기 전 조건이 docs/ARCHITECTURE.md 5장에 있다.
- **실제 개인정보를 넣지 않는다.** 이 서버(recruit.kimbbob.xyz)는 가짜 데이터만.
- **운영 서버에서 `npm run seed:bulk` 를 실행하지 않는다** (9-7 — 프로그램도 거절한다).
- **ENC_KEY 를 바꾸지 않는다** (바꾸면 저장된 이력서를 열 수 없다).
- **`migrations/` 의 파일을 고치지 않는다** (예전 SQLite 파일도, `migrations/pg/` 의 적용한 파일도). 바꿀 것이 있으면 개발자가 새 번호 파일을 만든다.
- **`recruit` DB 를 지우지 않는다.** 복구 연습은 다른 이름의 DB 로.
- 디버거(inspect)를 켠 채로 서버를 돌리지 않는다. 8787·5433 을 방화벽에서 열지 않는다.
- 비밀값·백업 비밀문구·`.env` 내용을 대화창·메일·git 에 붙여 넣지 않는다. 풀어 놓은 백업 폴더를 남겨 두지 않는다.
