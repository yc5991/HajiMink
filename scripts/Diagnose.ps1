[CmdletBinding()]
param([string]$ThreadId)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $projectRoot
try {
    $dataPath = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
    $configPath = if ($env:AGENT_CONTROL_CONFIG) { $env:AGENT_CONTROL_CONFIG } else { Join-Path $dataPath 'config.json' }
    $config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    $processState = @{}
    foreach ($kind in @('gateway', 'tunnel')) {
        $pidPath = Join-Path $dataPath ($kind + '.pid.json')
        $record = if (Test-Path -LiteralPath $pidPath) { Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
        $processState[$kind] = [bool]($record -and (Get-Process -Id $record.processId -ErrorAction SilentlyContinue))
    }
    @{ mode = $(if ($config) { $config.mode } else { 'local' }); publicOrigin = $(if ($config) { $config.publicOrigin } else { 'http://127.0.0.1:3000' }); processes = $processState; dataDirectory = $dataPath } | ConvertTo-Json -Depth 3
    & node (Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs') (Join-Path $PSScriptRoot 'diagnose.ts') $ThreadId
}
finally { Pop-Location }
