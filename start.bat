@echo off
chcp 65001 >nul
title 🧙 Model Alchemist 🧙
cd /d "%~dp0"
echo Starting 🧙 Model Alchemist...
echo Close this window to STOP the Model Alchemist.
echo.
rem server.js prints the address and opens the browser once it is listening.
node server.js
pause
