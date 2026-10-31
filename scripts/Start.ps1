[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$startupPhase = 'validate-runtime'
trap {
    # Record only a phase, never command lines, credentials or configuration.
    try {
        $diagnosticRoot = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
        if (Test-Path -LiteralPath $diagnosticRoot -PathType Container) {
            Add-Content -LiteralPath (Join-Path $diagnosticRoot 'startup-diagnostics.log') -Value ("{0} {1} failed" -f (Get-Date).ToString('o'), $startupPhase) -Encoding UTF8
        }
    } catch { }
    break
}
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$entryPath = Join-Path $projectRoot 'dist-server\index.js'
$dataPath = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
if (-not (Test-Path -LiteralPath $entryPath)) { throw '请先在项目目录运行 npm ci 和 npm run build' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = & $nodePath --version
if ([int]($nodeVersion -replace '^v(\d+).*$', '$1') -lt 24) { throw '需要 Node.js 24 或更高版本' }
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$configPath = if ($env:AGENT_CONTROL_CONFIG) { $env:AGENT_CONTROL_CONFIG } else { Join-Path $dataPath 'config.json' }
if (-not (Test-Path -LiteralPath $configPath)) { throw '找不到配置文件，请从 config.example.json 复制本地配置，远程模式参考 config.owner.example.json 或 config.access.example.json' }
@{ configPath=$configPath; configMode=(Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).mode; currentUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; startedAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataPath 'startup-state.json') -Encoding utf8
$startupPhase = 'gateway'
$pidPath = Join-Path $dataPath 'gateway.pid.json'
$gatewayRunning = $false
if (Test-Path -LiteralPath $pidPath) {
    $record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.processId)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.ExecutablePath -eq $nodePath -and $existing.CommandLine.Contains($entryPath)) { $gatewayRunning = $true }
}
if ($gatewayRunning) {
    # The gateway and the Tunnel have independent lifetimes. Do not skip the
    # Tunnel check when the gateway survived but the connector did not.
    Write-Output 'Agent Control 已在后台运行'
} else {
    $process = Start-Process -FilePath $nodePath -ArgumentList @( ('"' + $entryPath + '"'), '--config', ('"' + $configPath + '"'), '--data-dir', ('"' + $dataPath + '"') ) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'gateway.stdout.log') -RedirectStandardError (Join-Path $dataPath 'gateway.stderr.log') -PassThru
    @{ processId = $process.Id; entryPath = $entryPath; nodePath = $nodePath; startedAt = (Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8
    Start-Sleep -Seconds 2
    if ($process.HasExited) { throw "服务启动失败，请检查 $dataPath\gateway.stderr.log" }
    Write-Output "Agent Control 已在后台启动，进程 $($process.Id)"
}
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
if ($config -and $config.mode -in @('access', 'owner')) {
    Write-Output ('正式访问：' + $config.publicOrigin)
    if (Test-Path -LiteralPath (Join-Path $dataPath 'tunnel-token')) {
        $startupPhase = 'tunnel'
        try { & (Join-Path $PSScriptRoot 'Start-Tunnel.ps1') } catch { Write-Warning 'Tunnel 启动检查失败，网关保持运行'; throw }
    }
} else { Write-Output ('本机访问：' + $config.publicOrigin) }
