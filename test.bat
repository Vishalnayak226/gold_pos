@echo off
title Gold POS Test Runner
color 0B

echo =========================================
echo         Gold POS Test Runner
echo =========================================
echo.

cd /d "%~dp0"
set FAILED=0

echo [1/2] Integration suite (pricing, licensing, crypto envelope)...
echo.
node backend/test_suite.js
if errorlevel 1 set FAILED=1

echo.
echo [2/2] Billing arithmetic suite (discount, GST inclusive/exclusive, advances)...
echo.
node backend/test_billing_math.js
if errorlevel 1 set FAILED=1

echo.
echo =========================================
if %FAILED%==1 (
    color 0C
    echo   RESULT: FAILED - see the output above.
) else (
    color 0A
    echo   RESULT: ALL SUITES PASSED.
)
echo =========================================
echo.
pause
exit /b %FAILED%
