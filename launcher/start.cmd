@echo off
rem ---------------------------------------------------------------------------
rem  CSP launcher - ASCII entry point, for terminals / non-CJK shells
rem      start.cmd                 -> dev mode  (hot reload, port 5174)
rem      start.cmd prod            -> build if stale, then preview on port 4173
rem      start.cmd menu|build|test|params
rem      start.cmd dev -NoBrowser -UrlParams "perf=1"
rem  The Chinese-named .cmd files in the project root do the same thing; use
rem  whichever is easier to type. Everything lives in play.ps1.
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
title CSP - launcher

rem NOTE: %~dp0 must be captured before `shift`, which moves %0 as well.
set "HERE=%~dp0"
rem First argument is the mode (dev/prod/menu); a leading - means options only.
set "MODE=%~1"
if "%MODE:~0,1%"=="-" goto defaultmode
if "%MODE%"=="" goto defaultmode
shift
goto haveMode
:defaultmode
set "MODE=dev"
:haveMode

set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%play.ps1" -Mode "%MODE%" %1 %2 %3 %4 %5 %6 %7 %8
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo. & echo Launcher exited with code %CODE%. & pause
exit /b %CODE%