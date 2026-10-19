@echo off
chcp 65001 >nul
cd /d "%~dp0"
node install.mjs
if errorlevel 1 (
  echo.
  echo 安装失败，请查看上方错误信息。
) else (
  echo.
  echo 安装成功。请重启 DSH。
)
pause
