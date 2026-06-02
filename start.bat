@echo off
chcp 65001 >nul
title 🧙 Model Alchemist 🧙
cd /d "%~dp0"
echo Starting 🧙 Model Alchemist...
echo.
echo Model Alchemist opened in your browser.
echo Close this window to STOP the Model Alchemist.
echo.
node server.js
pause
