@echo off
setlocal EnableExtensions
title My Company AI
cd /d "%~dp0"

set "HQ_PORT=%MILWEB_HQ_PORT%"
if "%HQ_PORT%"=="" set "HQ_PORT=4777"

where node >nul 2>nul
if errorlevel 1 (
  echo [My Company AI] Node.js nao encontrado no PATH. Instale o Node 24 ou superior: https://nodejs.org
  pause
  exit /b 1
)
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [My Company AI] pnpm nao encontrado no PATH. Instale com: npm install -g pnpm
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo [My Company AI] Instalando dependencias...
  call pnpm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist "web\dist\index.html" (
  echo [My Company AI] Compilando a interface pela primeira vez...
  call pnpm --filter @milweb-hq/web build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

cd /d "%~dp0server"
if /i "%~1"=="--janela" (
  rem Modo antigo, para diagnostico: o servico roda NESTA janela e fechar a janela encerra a HQ.
  echo [My Company AI] Iniciando o servico nesta janela em http://127.0.0.1:%HQ_PORT% - feche esta janela para encerrar.
  node --import tsx src/main.ts --open --print-url
) else (
  rem Padrao: o servico sobe em segundo plano, sem janela; esta janela pode ser fechada.
  node launch.mjs --open
)
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo [My Company AI] O servico terminou com codigo %EXITCODE%. Log: %LOCALAPPDATA%\MilWebHQ\logs\server.log
  pause
)
endlocal & exit /b %EXITCODE%
