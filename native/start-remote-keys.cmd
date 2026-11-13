@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0RemoteKeysBridge.ps1" %*
if errorlevel 1 (
  echo.
  echo 助手已退出。请查看上方错误信息。
  pause >nul
)
