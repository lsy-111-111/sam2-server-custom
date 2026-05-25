@echo off
setlocal

set "SAM2_URL=http://192.168.111.4:7262"
set "SAM2_ORIGIN=http://192.168.111.4:7262"
set "PROFILE_DIR=%LOCALAPPDATA%\SAM2Lan\ChromeProfile"

set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"

if not defined BROWSER (
  echo Chrome was not found on this computer.
  echo Install Chrome, or use start_sam2_edge.cmd if Edge is installed.
  pause
  exit /b 1
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>nul

start "SAM2 LAN Chrome" "%BROWSER%" ^
  --user-data-dir="%PROFILE_DIR%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --new-window ^
  --unsafely-treat-insecure-origin-as-secure="%SAM2_ORIGIN%" ^
  "%SAM2_URL%"

endlocal
