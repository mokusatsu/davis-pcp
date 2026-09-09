@echo off
setlocal
rem DAVIS-PCP production launcher (bypasses PowerShell execution policy)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-production.ps1" %*
pause
endlocal
