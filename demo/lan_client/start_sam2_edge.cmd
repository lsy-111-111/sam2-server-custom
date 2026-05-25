@echo off
setlocal

set "SAM2_URL=http://192.168.111.4:7262"
set "SAM2_ORIGIN=http://192.168.111.4:7262"
set "PROFILE_DIR=%LOCALAPPDATA%\SAM2Lan\EdgeProfile"

set "BROWSER="
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo Edge was not found on this computer.
  echo Install Edge, or use start_sam2_chrome.cmd if Chrome is installed.
  pause
  exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>nul

start "SAM2 LAN Edge" "%BROWSER%" ^
  --user-data-dir="%PROFILE_DIR%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --new-window ^
  --unsafely-treat-insecure-origin-as-secure="%SAM2_ORIGIN%" ^
  "%SAM2_URL%"

endlocal
