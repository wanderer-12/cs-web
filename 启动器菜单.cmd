@echo off
rem ---------------------------------------------------------------------------
rem  CSP 启动器菜单 —— 生产模式 / 构建 / 测试 / 启动参数 / 重装依赖
rem  选项会原样转给 play.ps1，例: 启动器菜单.cmd -DryRun 只打印环境诊断
rem ---------------------------------------------------------------------------
chcp 65001 >nul
setlocal
title CSP - 启动器

set "HERE=%~dp0"
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%HERE%launcher\play.ps1" -Mode menu %1 %2 %3 %4 %5 %6 %7 %8
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" echo. & echo 启动器以 exit code %CODE% 结束。 & pause
exit /b %CODE%