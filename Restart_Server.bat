@echo off
title Gold POS Server
color 0B

echo =========================================
echo       Gold POS Server Restarter
echo =========================================
echo.

echo [1/3] Searching for existing server on Port 5000...
for /f "tokens=5" %%a in ('netstat -aon ^| find ":5000" ^| find "LISTENING"') do (
    echo [2/3] Found existing server (PID: %%a). Shutting it down...
    taskkill /f /pid %%a >nul 2>&1
)

echo [3/3] Launching fresh Gold POS Server...
echo.
cd /d "%~dp0"
node backend/server.js

echo.
echo Server has stopped unexpectedly.
pause
