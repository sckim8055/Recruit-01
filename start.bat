@echo off
rem Recruit server (Node + PostgreSQL). Double-click to build and start. Ctrl+C to stop.
rem Normally the service manager starts the server. Use this file only for a manual start. See docs/DEPLOY.md
cd /d "%~dp0"
set "NODE_DIR=F:\works\node-v26.13.1-win-x64"
set "PATH=%NODE_DIR%;%PATH%"
if not exist .env (
  echo .env file is missing. Copy .env.example to .env and fill the values first. See docs\DEPLOY.md section 3.
  goto :fail
)
if not exist node_modules (
  echo [1/4] Installing packages...
  call npm ci || goto :fail
)
echo [2/4] Applying database migrations...
call npm run db:migrate || goto :fail
echo [3/4] Building...
call npm run build || goto :fail
echo [4/4] Starting server at http://127.0.0.1:8787 (Ctrl+C to stop)
call npm start
goto :eof
:fail
echo.
echo Failed. Read the message above.
pause
