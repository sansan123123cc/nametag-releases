@echo off
cd /d "%~dp0"
if not exist venv\Scripts\python.exe ( echo 먼저 [1. 환경 설치] 를 해라. & pause & exit /b 1 )
venv\Scripts\python.exe train.py
pause
