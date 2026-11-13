@echo off
chcp 65001 >nul
title 🧙 Model Alchemist 🧙
cd /d "%~dp0"
rem Tells server.js that this script offers to finish an unfinished update itself.
set "MODEL_ALCHEMIST_LAUNCHER=start.bat"
echo Starting 🧙 Model Alchemist...
echo Close this window to STOP the Model Alchemist.
echo.
rem server.js prints the address and opens the browser once it is listening.
node server.js
rem Exit code 3: installed packages are older than package-lock.json (lib/dependency-check.js).
if %ERRORLEVEL% neq 3 goto :end

echo.
choice /c YN /m "Finish the update now"
if errorlevel 2 goto :declined

echo.
echo Finishing the update. This takes about a minute...
echo.
call npm ci
if errorlevel 1 goto :failed
echo.
echo Update finished. Starting 🧙 Model Alchemist...
echo.
node server.js
goto :end

:declined
echo.
echo The update was not finished. Start Model Alchemist again and answer Y when you are ready.
goto :end

:failed
echo.
echo The update could not be finished. Check the internet connection, then start Model Alchemist again.
echo If it keeps failing, send the messages above with your bug report.
goto :end

:end
pause
