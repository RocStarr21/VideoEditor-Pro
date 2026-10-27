$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $appRoot "apps\web"
$logRoot = Join-Path $appRoot "logs"
$port = if ($env:VIDEOEDITOR_PRO_PORT) { $env:VIDEOEDITOR_PRO_PORT } else { "5173" }

New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
Set-Location $webRoot

$existingConnections = Get-NetTCPConnection -LocalPort ([int] $port) -State Listen -ErrorAction SilentlyContinue
foreach ($connection in $existingConnections) {
  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
  if ($process -and ($process.ProcessName -eq "node" -or $process.ProcessName -eq "npm")) {
    Stop-Process -Id $process.Id -Force
  }
}

$staleProcesses = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -match 'VideoEditor-Pro|vite.*preview|--port 5173' }
foreach ($staleProcess in $staleProcesses) {
  Stop-Process -Id $staleProcess.ProcessId -Force -ErrorAction SilentlyContinue
}

if (-not (Test-Path "node_modules")) {
  npm.cmd install *> (Join-Path $logRoot "install.log")
}

npm.cmd run preview -- --host 127.0.0.1 --port $port --strictPort *> (Join-Path $logRoot "videoeditor-pro.log")
