#Requires -RunAsAdministrator
<#
  Remove o Aurora Agent e o Aurora Touch: tarefas agendadas, regras de firewall e C:\ProgramData\Aurora.
  Uso: powershell -ExecutionPolicy Bypass -File .\agent\uninstall-agent.ps1
#>
$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:ProgramData 'Aurora'

foreach ($name in 'Aurora Agent', 'Aurora Touch') {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "  > Tarefa '$name' removida"
    }
}

foreach ($rule in 'AuroraAgent', 'AuroraTouch') {
    Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
}
Write-Host '  > Regras de firewall removidas'

if (Test-Path $InstallDir) {
    Remove-Item -Recurse -Force $InstallDir
    Write-Host "  > $InstallDir removido"
}

Write-Host '  Aurora Agent desinstalado.' -ForegroundColor Green
