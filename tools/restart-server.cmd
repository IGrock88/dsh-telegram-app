@echo off
REM Restart `dsh web` with its startup log written to files next to this script.
REM Just double-click this file, or run it from your own cmd/PowerShell window.
REM
REM Do NOT ask the agent to run it: the agent lives inside the very server this
REM stops, so a restart from there kills the agent mid-command and no log appears.
REM
REM Output: dsh-web.log and dsh-web.err.log in this folder.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart-server.ps1"

echo.
echo Press any key to close this window.
pause >nul
