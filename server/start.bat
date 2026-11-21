@echo off
title BhoomiNex — Land Records Server
color 0A
echo.
echo  ============================================
echo   BhoomiNex Land Records Dashboard
echo  ============================================
echo.

cd /d "%~dp0"

REM Use bundled portable Node.js
set "NODE_DIR=%~dp0node"
set "NODE_CMD=%NODE_DIR%\node.exe"
set "NPM_CMD=%NODE_DIR%\npm.cmd"
set "PATH=%NODE_DIR%;%PATH%"

if not exist "%NODE_CMD%" (
    echo  [ERROR] Bundled Node.js not found in %NODE_DIR%
    echo  Please re-download or install Node.js from: https://nodejs.org
    pause
    exit /b 1
)

echo  [OK] Node.js found: %NODE_CMD%

REM Install dependencies if missing
if not exist "%~dp0node_modules\express" (
    echo  Installing dependencies (first time only, please wait)...
    call "%NPM_CMD%" install
    if errorlevel 1 (
        echo  [ERROR] npm install failed!
        pause
        exit /b 1
    )
)

echo  [OK] Dependencies ready.
echo.
echo  ============================================
echo   Open Chrome and go to:
echo   http://localhost:3000
echo  ============================================
echo.

"%NODE_CMD%" server.js
pause
