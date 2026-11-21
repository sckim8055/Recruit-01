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
