[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$dataPath = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
$pidPath = Join-Path $dataPath 'gateway.pid.json'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output '没有已登记的网关进程'; return }
$record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.processId)" -ErrorAction SilentlyContinue
if ($process) {
    if ($process.ExecutablePath -ne $record.nodePath -or -not $process.CommandLine.Contains($record.entryPath)) { throw '进程身份不匹配，已停止操作' }
    Stop-Process -Id $record.processId -ErrorAction Stop
}
Remove-Item -LiteralPath $pidPath -Force
Write-Output 'Agent Control 网关已停止，Codex 桌面任务继续运行'
