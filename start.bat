@echo off
cd /d "%~dp0"
start "" http://localhost:4311
node server.js
pause
