@echo off
rem DAVIS-PCP dev launcher (bypasses PowerShell execution policy)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dev.ps1" %*
pause
