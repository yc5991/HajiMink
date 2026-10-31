[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$dataPath = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
$pidPath = Join-Path $dataPath 'tunnel.pid.json'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output '没有已登记的 Tunnel 进程'; return }
$record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.processId)" -ErrorAction SilentlyContinue
if ($process) {
    if ($process.ExecutablePath -ne $record.binaryPath -or -not $process.CommandLine.Contains($record.tokenPath)) { throw 'Tunnel 进程身份不匹配，已停止操作' }
    Stop-Process -Id $record.processId -ErrorAction Stop
}
Remove-Item -LiteralPath $pidPath -Force
Write-Output 'Tunnel 已停止，本地网关及 Codex 桌面任务继续运行'
