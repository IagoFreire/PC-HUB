#Requires -RunAsAdministrator
<#
  Instala o Aurora Agent neste PC:
    - copia o agente para C:\ProgramData\Aurora (segredo legível só por SYSTEM/Administradores)
    - libera a porta no firewall apenas para a rede local
    - registra uma tarefa que inicia com o Windows (antes do login), como SYSTEM

  Uso (PowerShell como Administrador):
    powershell -ExecutionPolicy Bypass -File .\agent\install-agent.ps1
    powershell -ExecutionPolicy Bypass -File .\agent\install-agent.ps1 -ConfigureWol

  O segredo e a porta são lidos do config.json da raiz do projeto, se existir.
  -ConfigureWol também liga o Wake-on-LAN na placa de rede e desativa a Inicialização Rápida.
#>
param(
    [int]$Port = 0,
    [string]$Secret = '',
    [switch]$ConfigureWol
)

$ErrorActionPreference = 'Stop'

$TaskName = 'Aurora Agent'
$RuleName = 'AuroraAgent'
$InstallDir = Join-Path $env:ProgramData 'Aurora'
$AgentPath = Join-Path $InstallDir 'aurora-agent.ps1'
$SecretPath = Join-Path $InstallDir 'agent.secret'
$ConfigPath = Join-Path $PSScriptRoot '..\config.json'

function Write-Step([string]$Text) { Write-Host "  > $Text" -ForegroundColor Cyan }

function New-Secret {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# --- segredo e porta ---
if (Test-Path $ConfigPath) {
    $config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $Secret) { $Secret = [string]$config.pc.agentSecret }
    if (-not $Port -and $config.pc.agentPort) { $Port = [int]$config.pc.agentPort }
    Write-Step "Usando segredo e porta do config.json"
}
if (-not $Port) { $Port = 7777 }
$generated = $false
if (-not $Secret) {
    $Secret = New-Secret
    $generated = $true
}
if ($Secret.Length -lt 16) { throw 'O segredo do agente precisa ter pelo menos 16 caracteres.' }

# --- para a versão anterior, se houver ---
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Step 'Parando a versão anterior'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# --- arquivos ---
Write-Step "Copiando o agente para $InstallDir"
# O agente roda como SYSTEM: a pasta é recriada do zero e trancada antes de receber qualquer arquivo,
# para que um usuário comum não consiga trocar o script nem ler o segredo.
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
New-Item -ItemType Directory -Path $InstallDir | Out-Null
# SIDs (SYSTEM e Administradores) funcionam em Windows de qualquer idioma.
& icacls.exe $InstallDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Não consegui restringir as permissões de $InstallDir." }
Copy-Item (Join-Path $PSScriptRoot 'aurora-agent.ps1') $AgentPath -Force
[IO.File]::WriteAllText($SecretPath, $Secret, (New-Object Text.UTF8Encoding $false))

# --- firewall ---
Write-Step "Liberando a porta TCP $Port para a rede local"
Get-NetFirewallRule -Name $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -Name $RuleName -DisplayName 'Aurora Agent' -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Profile Any | Out-Null

# --- tarefa agendada ---
Write-Step 'Registrando a tarefa que inicia com o Windows'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentPath`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Permite que o Aurora veja se o PC está ligado e o desligue pela rede.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

# --- Wake-on-LAN (opcional) ---
if ($ConfigureWol) {
    foreach ($adapter in Get-NetAdapter -Physical | Where-Object Status -eq 'Up') {
        Write-Step "Ativando Wake-on-LAN em '$($adapter.Name)'"
        try {
            Set-NetAdapterPowerManagement -Name $adapter.Name -WakeOnMagicPacket Enabled -ErrorAction Stop
        } catch {
            Write-Warning "Não deu para ativar 'Wake on Magic Packet' via energia: $_"
        }
        # *WakeOnMagicPacket é o padrão; S5WakeOnLan é o "Shutdown Wake-On-Lan" das placas Realtek.
        foreach ($keyword in '*WakeOnMagicPacket', 'S5WakeOnLan') {
            if (Get-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword $keyword -ErrorAction SilentlyContinue) {
                Set-NetAdapterAdvancedProperty -Name $adapter.Name -RegistryKeyword $keyword -RegistryValue 1
            }
        }
    }
    # A Inicialização Rápida desliga a placa por completo e impede o WoL a partir do desligamento.
    Write-Step 'Desativando a Inicialização Rápida do Windows'
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name HiberbootEnabled -Value 0 -Type DWord
}

# --- autoteste ---
Write-Step 'Testando o agente'
$healthy = $false
for ($attempt = 0; $attempt -lt 10 -and -not $healthy; $attempt++) {
    Start-Sleep -Milliseconds 700
    try {
        $health = Invoke-RestMethod "http://localhost:$Port/health" -Headers @{ Authorization = "Bearer $Secret" } -TimeoutSec 2
        $healthy = [bool]$health.ok
    } catch {
        $lastError = $_
    }
}

$adapterInfo = Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -First 1
$ip = if ($adapterInfo) {
    (Get-NetIPAddress -InterfaceIndex $adapterInfo.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
}

Write-Host ''
if ($healthy) {
    Write-Host '  Aurora Agent instalado e respondendo.' -ForegroundColor Green
} else {
    Write-Host "  O agente foi instalado, mas não respondeu ao teste: $lastError" -ForegroundColor Yellow
    Write-Host "  Veja o log em $InstallDir\agent.log" -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  Dados para o config.json do servidor:'
Write-Host "    mac:       $($adapterInfo.MacAddress -replace '-', ':')"
Write-Host "    ip:        $ip"
Write-Host "    agentPort: $Port"
if ($generated) { Write-Host "    agentSecret: $Secret" }
Write-Host ''
