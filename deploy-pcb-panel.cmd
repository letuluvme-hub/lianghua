@echo off
setlocal EnableDelayedExpansion
cd /d %~dp0

if not exist .env (
  echo [ERROR] .env not found in %CD%
  pause
  exit /b 1
)

REM Load env vars from .env (skip comments and blanks)
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
  set "k=%%a"
  if not "!k:~0,1!"=="#" (
    if not "%%a"=="" set "%%a=%%b"
  )
)

echo === Step 1/2: Deploy subscription-worker.js ===
call node deploy-subscription-worker.js
if errorlevel 1 (
  echo.
  echo [ERROR] Worker deploy failed. Stopping.
  pause
  exit /b 1
)

echo.
echo === Step 2/2: Deploy Cloudflare Pages (includes new pcb.html) ===
call node deploy-cloudflare-pages.js
if errorlevel 1 (
  echo.
  echo [ERROR] Pages deploy failed.
  pause
  exit /b 1
)

echo.
echo === Done. ===
echo Home:    https://cambricon-boll-midline.pages.dev/
echo Sectors: https://cambricon-boll-midline.pages.dev/sectors.html
echo API:     https://cambricon-boll-midline.pages.dev/api/sector-bollinger?bk=BK0877
echo Force:   https://cambricon-boll-midline.pages.dev/api/sector-bollinger?bk=BK0877^&refresh=1
echo.
pause
