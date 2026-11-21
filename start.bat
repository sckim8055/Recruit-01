@echo off
rem Recruit local test server. Double-click to start, Ctrl+C to stop.
cd /d "%~dp0"
if not exist node_modules (
  echo [1/3] Installing packages...
  call npm install || goto :fail
)
if not exist .dev.vars (
  echo .dev.vars file is missing. Copy .dev.vars.example to .dev.vars and fill ENC_KEY and SESSION_PEPPER first. See README.md
  goto :fail
)
echo [2/3] Updating local database...
set CI=1
call npm run db:local || goto :fail
set CI=
echo [3/3] Starting server at http://localhost:8787
call npx wrangler dev --var APP_ENV:dev
goto :eof
:fail
echo.
echo Failed. Read the message above.
pause
