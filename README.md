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

위 명령의 출력값을 `ENC_KEY=6enMSNs9EXmfM5w1+YH+cuEDss3ZFOTpJsGAgVUrSvo=` 뒤에 붙이고, `SESSION_PEPPER=6enMSNs9EXmfM5w1+YH+cuEDss3ZFOTpJsGAgVUrSvo=` 뒤에는 임의의 긴 문자열을 적는다.

```
npm run db:local
npx wrangler dev --var APP_ENV:dev
```

브라우저에서 http://localhost:8787 을 연다. 로그인 인증코드는 메일로 가지 않고 **터미널 창**에 출력된다.

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
