#Requires -RunAsAdministrator
<#
  Remove o Aurora Agent: tarefa agendada, regra de firewall e C:\ProgramData\Aurora.
  Uso: powershell -ExecutionPolicy Bypass -File .\agent\uninstall-agent.ps1
#>
$ErrorActionPreference = 'Stop'

$TaskName = 'Aurora Agent'
$InstallDir = Join-Path $env:ProgramData 'Aurora'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host '  > Tarefa removida'
}

Get-NetFirewallRule -Name 'AuroraAgent' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host '  > Regra de firewall removida'

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "  > $InstallDir removido"
}

Write-Host '  Aurora Agent desinstalado.' -ForegroundColor Green
