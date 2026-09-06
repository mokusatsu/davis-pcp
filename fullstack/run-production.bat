@echo off
rem DAVIS-PCP production launcher (bypasses PowerShell execution policy)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-production.ps1" %*
pause
