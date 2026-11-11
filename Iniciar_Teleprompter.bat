@echo off
chcp 65001 >nul
title AuditPrompter AI - Copiloto e Teleprompter de Auditoria Interna
cd /d "%~dp0"
echo ====================================================================
echo   Iniciando AuditPrompter AI (Teleprompter de Auditoria Interna)...
echo ====================================================================
if not exist "%~dp0node_modules\@anthropic-ai\sdk" (
  echo [1/2] Instalando dependencias Node.js pela primeira vez - aguarde...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo [ERRO] Nao foi possivel instalar as dependencias do Node.js. Verifique se o Node.js esta instalado.
    pause
    exit /b 1
  )
)

where python >nul 2>nul
if %errorlevel% equ 0 (
  python -c "import docx, openpyxl, speech_recognition, faster_whisper" >nul 2>nul
  if errorlevel 1 (
    echo [2/2] Instalando bibliotecas Python - exportacao Word/Excel e transcricao local Whisper - aguarde...
    python -m pip install -r "%~dp0requirements.txt" --quiet
  )
)

node "%~dp0server.js" --open
pause
