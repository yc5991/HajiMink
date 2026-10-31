# Disposable startup test. Process discovery/startup are mocked in a copied project.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'Start.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('hajimink-startup-test-' + [guid]::NewGuid().ToString('N'))
$scriptDir = Join-Path $root 'scripts'
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force -Path $scriptDir, $dataDir, (Join-Path $root 'dist-server') | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $scriptDir 'Start.ps1')
Set-Content -LiteralPath (Join-Path $root 'dist-server\index.js') -Value '// test fixture' -Encoding UTF8
Set-Content -LiteralPath (Join-Path $scriptDir 'Start-Tunnel.ps1') -Value 'Set-Content -LiteralPath (Join-Path $env:AGENT_CONTROL_DATA_DIR ''tunnel-checked'') -Value ''checked''' -Encoding UTF8
$previousData = $env:AGENT_CONTROL_DATA_DIR
$previousConfig = $env:AGENT_CONTROL_CONFIG
$env:AGENT_CONTROL_DATA_DIR = $dataDir
$env:AGENT_CONTROL_CONFIG = Join-Path $dataDir 'config.json'
$previousFake = $env:HAJIMINK_TEST_EXISTING
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) if ($env:HAJIMINK_TEST_EXISTING -eq '1') { return [pscustomobject]@{ ExecutablePath = (Get-Command node).Source; CommandLine = (Join-Path (Split-Path -Parent $env:AGENT_CONTROL_DATA_DIR) 'dist-server\index.js') } } }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru) Set-Content -LiteralPath (Join-Path $env:AGENT_CONTROL_DATA_DIR 'gateway-started') -Value 'started'; return [pscustomobject]@{ Id = 12345; HasExited = $false } }
function Start-Sleep { param($Seconds, $Milliseconds) }
function Assert-Condition([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
    $config = @{ mode = 'owner'; publicOrigin = 'https://fixture.example'; port = 3000 }
    $config | ConvertTo-Json | Set-Content -LiteralPath $env:AGENT_CONTROL_CONFIG -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $dataDir 'tunnel-token') -Value 'test-only'
    $node = (Get-Command node -ErrorAction Stop).Source
    $entry = Join-Path $root 'dist-server\index.js'
    @{ processId = 12345 } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $dataDir 'gateway.pid.json') -Encoding UTF8
    $env:HAJIMINK_TEST_EXISTING = '1'
    & (Join-Path $scriptDir 'Start.ps1') | Out-Null
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $dataDir 'gateway-started'))) 'Existing gateway should not be restarted'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $dataDir 'tunnel-checked')) 'Existing gateway must still check its Tunnel'
    Remove-Item -LiteralPath (Join-Path $dataDir 'tunnel-checked')
    $env:HAJIMINK_TEST_EXISTING = '0'
    & (Join-Path $scriptDir 'Start.ps1') | Out-Null
    Assert-Condition (Test-Path -LiteralPath (Join-Path $dataDir 'gateway-started')) 'Missing gateway should be started'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $dataDir 'tunnel-checked')) 'New gateway must check its Tunnel'
    Remove-Item -LiteralPath (Join-Path $dataDir 'tunnel-checked')
    $config.mode = 'local'; $config.publicOrigin = 'http://127.0.0.1:3000'
    $config | ConvertTo-Json | Set-Content -LiteralPath $env:AGENT_CONTROL_CONFIG -Encoding UTF8
    $env:HAJIMINK_TEST_EXISTING = '1'
    & (Join-Path $scriptDir 'Start.ps1') | Out-Null
    Assert-Condition (-not (Test-Path -LiteralPath (Join-Path $dataDir 'tunnel-checked'))) 'Local mode must not start a Tunnel'
    $config.mode = 'owner'; $config.publicOrigin = 'https://fixture.example'
    $config | ConvertTo-Json | Set-Content -LiteralPath $env:AGENT_CONTROL_CONFIG -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $scriptDir 'Start-Tunnel.ps1') -Value "throw 'fixture tunnel failure'" -Encoding UTF8
    $failed = $false
    try { & (Join-Path $scriptDir 'Start.ps1') | Out-Null } catch { $failed = $true }
    Assert-Condition $failed 'Tunnel startup failure must propagate to the scheduler'
    $diagnostics = Get-Content -LiteralPath (Join-Path $dataDir 'startup-diagnostics.log') -Raw
    Assert-Condition ($diagnostics -match 'tunnel failed') 'Failure phase must be recorded'
    Assert-Condition ($diagnostics -notmatch 'fixture tunnel failure|test-only') 'Diagnostics must not include error or token content'
    Write-Output 'PASS startup: existing gateway checks Tunnel, missing gateway starts, local mode skips Tunnel, failures reach scheduler with safe diagnostics'
} finally {
    $env:AGENT_CONTROL_DATA_DIR = $previousData; $env:AGENT_CONTROL_CONFIG = $previousConfig; $env:HAJIMINK_TEST_EXISTING = $previousFake
    $resolved = [IO.Path]::GetFullPath($root)
    $safeRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($safeRoot, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFileName($resolved).StartsWith('hajimink-startup-test-'))) { throw 'Unexpected startup fixture directory' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
