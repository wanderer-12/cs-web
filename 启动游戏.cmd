@echo off
rem ---------------------------------------------------------------------------
rem  CSP 启动器 —— 双击 = 直接开玩（开发模式，热更新）
rem  用法: 启动游戏.cmd [模式] [选项]    模式 = dev(默认) | prod | menu
rem  只给选项也行，例: 启动游戏.cmd -NoBrowser   或   启动游戏.cmd -DryRun
rem  需要菜单（生产模式 / 构建 / 测试 / 启动参数）请双击 启动器菜单.cmd
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
title CSP - 启动游戏

rem %~dp0 必须在 shift 之前取：shift 会把 %0 一起移走
set "HERE=%~dp0"
rem 第一个参数是模式；以 - 开头说明只给了选项，模式取默认值
set "MODE=%~1"
if "%MODE:~0,1%"=="-" goto defaultmode
if "%MODE%"=="" goto defaultmode
shift
goto haveMode
:defaultmode
set "MODE=dev"
:haveMode

rem 优先用 PowerShell 7（pwsh），没有就退回系统自带的 Windows PowerShell 5.1
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%launcher\play.ps1" -Mode "%MODE%" %1 %2 %3 %4 %5 %6 %7 %8
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo. & echo 启动器以 exit code %CODE% 结束。 & pause
exit /b %CODE%