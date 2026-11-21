@echo off
rem Encrypted backup of the PRODUCTION database. Double-click to run. See docs/DEPLOY.md section 5.
rem You will type a backup passphrase twice. It is not shown on screen and not saved anywhere.
rem The file goes to the backups folder as production-YYYYMMDD-HHMM.sql.enc
cd /d "%~dp0"
if not exist node_modules (
  echo Installing packages...
  call npm install || goto :fail
)
call npm run backup:prod || goto :fail
echo.
echo Done. Copy the new file in the backups folder to a USB drive or cloud drive as well.
pause
goto :eof
:fail
echo.
echo Backup failed. Read the message above.
pause
