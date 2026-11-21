@echo off
rem Deploy to the TEST server (recruit.kimbbob.xyz). Double-click to run. See docs/DEPLOY.md section 4.
rem Runs typecheck + tests + config check first (npm run predeploy:test), then wrangler deploy.
cd /d "%~dp0"
if not exist node_modules (
  echo [1/2] Installing packages...
  call npm install || goto :fail
)
echo [2/2] Checking and deploying to the TEST server...
call npm run deploy:test || goto :fail
echo.
echo Done. Open https://recruit.kimbbob.xyz/admin/system and check that nothing is red.
pause
goto :eof
:fail
echo.
echo Failed. Read the message above. Nothing was deployed if the check failed.
pause
