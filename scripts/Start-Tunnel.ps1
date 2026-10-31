[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$dataPath = if ($env:AGENT_CONTROL_DATA_DIR) { $env:AGENT_CONTROL_DATA_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) '.local\runtime' }
$binaryPath = Join-Path $dataPath 'bin\cloudflared.exe'
$tokenPath = Join-Path $dataPath 'tunnel-token'
$configPath = Join-Path $dataPath 'config.json'
if (-not (Test-Path -LiteralPath $binaryPath)) { throw '请先从 Cloudflare 官方发布页安装 cloudflared.exe 到本机数据目录的 bin 文件夹' }
if (-not (Test-Path -LiteralPath $tokenPath)) { throw '缺少本机 tunnel-token 文件，请在本机保存真实 Tunnel Token，不要放入代码仓库' }
if (-not (Test-Path -LiteralPath $configPath)) { throw '请先配置网关的正式登录模式' }
$config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($config.mode -notin @('access', 'owner') -or ([uri]$config.publicOrigin).Scheme -ne 'https') { throw '正式登录模式或 HTTPS 地址不正确，已阻止启动隧道' }
if ($config.mode -eq 'access' -and (-not $config.accessIssuer -or -not $config.accessAudience -or -not $config.allowedEmail)) { throw 'Access 正式配置不完整，已阻止启动隧道' }
$statusCode = 0
for ($attempt = 0; $attempt -lt 25 -and $statusCode -ne 401; $attempt++) {
    try { $response = Invoke-WebRequest ('http://127.0.0.1:' + $config.port + '/api/session') -Headers @{ Host = ([uri]$config.publicOrigin).Authority } -UseBasicParsing -TimeoutSec 1; $statusCode = [int]$response.StatusCode } catch { if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode } }
    if ($statusCode -ne 401) { Start-Sleep -Milliseconds 500 }
}
if ($statusCode -ne 401) { throw '后台网关的正式身份验证未生效，已阻止启动 Tunnel，请检查配置与日志' }
$pidPath = Join-Path $dataPath 'tunnel.pid.json'
if (Test-Path -LiteralPath $pidPath) {
    $record = Get-Content -LiteralPath $pidPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($record.processId)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.ExecutablePath -eq $binaryPath -and $existing.CommandLine.Contains($tokenPath)) { Write-Output 'Tunnel 已在后台运行'; return }
}
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $tokenPath /inheritance:r /grant:r "*${ownerSid}:(R)" '*S-1-5-18:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Token 文件权限设置失败，已阻止启动隧道' }
$process = Start-Process -FilePath $binaryPath -ArgumentList @('tunnel', '--protocol', 'http2', '--no-autoupdate', 'run', '--token-file', ('"' + $tokenPath + '"')) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'tunnel.stdout.log') -RedirectStandardError (Join-Path $dataPath 'tunnel.stderr.log') -PassThru
@{ processId = $process.Id; binaryPath = $binaryPath; tokenPath = $tokenPath } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8
Start-Sleep -Seconds 2
if ($process.HasExited) { throw 'Tunnel 启动失败，请查看本机 tunnel.stderr.log' }
Write-Output 'Tunnel 已在当前用户后台启动，Token 未放入进程命令行'
