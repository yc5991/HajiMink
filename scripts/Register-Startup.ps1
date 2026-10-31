[CmdletBinding()]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'AgentControl-UserGateway'
if ($Remove) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; Write-Output '已取消网关登录启动'; return }
$scriptPath = Join-Path $PSScriptRoot 'Start.ps1'
$userName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '"')
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description '当前用户登录后启动私人 Agent 网关，仅监听 127.0.0.1' -Force | Out-Null
Write-Output '已设置当前用户登录后启动网关；请保持 Codex 桌面应用运行'
