// public/ 의 정적 파일 주소. 서버(src/server.ts)가 이 파일들을 앱 앞에서 바로 내보내지만 (T-19 전에는 Cloudflare 정적 파일),
// 요청이 앱으로 들어오더라도(테스트·없는 파일) 동의 확인(src/index.tsx)이 화면 모양을 깨뜨리지 않게 이 주소는 건너뛴다.
// public/ 에 파일을 추가하면 여기에도 적는다 (test/account-routes.test.ts 가 public/ 의 파일이 모두 들어 있는지 확인한다).
export const PUBLIC_FILES: ReadonlySet<string> = new Set(['/app.css', '/favicon.ico']);
