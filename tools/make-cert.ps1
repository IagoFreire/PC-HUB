<#
  Gera o HTTPS do Aurora (rodar NO NOTEBOOK que hospeda o servidor; não precisa de administrador).

  Cria:
    certs\aurora-ca.cer  autoridade certificadora só da sua casa — é ela que o iPhone vai confiar
    certs\aurora.pfx     certificado do servidor, assinado por essa CA, válido para os IPs do notebook
  e adiciona a seção "tls" no config.json.

  Uso:
    powershell -ExecutionPolicy Bypass -File .\tools\make-cert.ps1
    powershell -ExecutionPolicy Bypass -File .\tools\make-cert.ps1 -IpAddress 192.168.200.50

  Rodar de novo gera uma CA nova: aí é preciso instalar o perfil no iPhone outra vez.
#>
param(
    # IPs pelos quais o iPhone acessa o notebook; padrão: todos os IPv4 da máquina.
    [string[]]$IpAddress = @(),
    [int]$HttpsPort = 8443,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\certs'),
    [string]$ConfigPath = (Join-Path $PSScriptRoot '..\config.json'),
    [switch]$NoConfigUpdate
)

$ErrorActionPreference = 'Stop'

# O iOS recusa certificado de servidor com validade acima de 825 dias, mesmo de CA instalada à mão.
$LeafValidityDays = 800
$CaValidityYears = 10
$Store = 'Cert:\CurrentUser\My'

function Write-Step([string]$Text) { Write-Host "  > $Text" -ForegroundColor Cyan }

function New-RandomText([int]$Bytes) {
    $buffer = New-Object byte[] $Bytes
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

if (-not $IpAddress) {
    $IpAddress = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress
}
if (-not $IpAddress) { throw 'Não achei nenhum IPv4 neste computador. Informe com -IpAddress.' }

$hostName = $env:COMPUTERNAME.ToLowerInvariant()
$sanEntries = @($IpAddress + '127.0.0.1' | Select-Object -Unique | ForEach-Object { "IPAddress=$_" }) +
    @('DNS=localhost', "DNS=$hostName", "DNS=$hostName.local")
Write-Step "Certificado válido para: $(($IpAddress + "$hostName.local") -join ', ')"

$ca = $null
$leaf = $null
try {
    Write-Step 'Criando a autoridade certificadora local (Aurora Local CA)'
    $ca = New-SelfSignedCertificate -Type Custom -CertStoreLocation $Store `
        -Subject 'CN=Aurora Local CA, O=Aurora' -FriendlyName 'Aurora Local CA' `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
        -KeyUsage CertSign, CRLSign, DigitalSignature `
        -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=0') `
        -NotAfter (Get-Date).AddYears($CaValidityYears)

    Write-Step 'Criando o certificado do servidor'
    $leaf = New-SelfSignedCertificate -Type Custom -CertStoreLocation $Store -Signer $ca `
        -Subject "CN=Aurora ($hostName)" -FriendlyName 'Aurora HTTPS' `
        -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature, KeyEncipherment `
        -TextExtension @("2.5.29.17={text}$($sanEntries -join '&')", '2.5.29.37={text}1.3.6.1.5.5.7.3.1') `
        -NotAfter (Get-Date).AddDays($LeafValidityDays)

    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $pfxPath = Join-Path $OutDir 'aurora.pfx'
    $caPath = Join-Path $OutDir 'aurora-ca.cer'
    $passphrase = New-RandomText 24

    # AES-256: o Node (OpenSSL 3) não abre PFX com a criptografia antiga padrão do Windows.
    Export-PfxCertificate -Cert $leaf -FilePath $pfxPath `
        -Password (ConvertTo-SecureString $passphrase -AsPlainText -Force) `
        -CryptoAlgorithmOption AES256_SHA256 | Out-Null
    Export-Certificate -Cert $ca -FilePath $caPath -Type CERT | Out-Null
    $caFingerprint = (Get-FileHash -Algorithm SHA256 -Path $caPath).Hash -replace '(..)(?!$)', '$1 '
} finally {
    # Nada fica no repositório de certificados do Windows: a chave da CA existe só durante a geração.
    foreach ($cert in $leaf, $ca) {
        if ($cert) { Remove-Item -Path (Join-Path $Store $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue }
    }
}

if (-not $NoConfigUpdate) {
    if (Test-Path $ConfigPath) {
        Write-Step 'Atualizando a seção "tls" do config.json'
        $config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $tls = [ordered]@{
            port       = $HttpsPort
            pfx        = 'certs/aurora.pfx'
            passphrase = $passphrase
            ca         = 'certs/aurora-ca.cer'
        }
        $config | Add-Member -NotePropertyName tls -NotePropertyValue ([pscustomobject]$tls) -Force
        [IO.File]::WriteAllText((Resolve-Path $ConfigPath), ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
    } else {
        Write-Warning "config.json não encontrado. Adicione manualmente: `"tls`": { `"port`": $HttpsPort, `"pfx`": `"certs/aurora.pfx`", `"passphrase`": `"$passphrase`", `"ca`": `"certs/aurora-ca.cer`" }"
    }
}

$httpPort = if ((Test-Path $ConfigPath) -and $config.port) { $config.port } else { 8080 }
Write-Host ''
Write-Host '  HTTPS pronto. Agora, no iPhone:' -ForegroundColor Green
Write-Host "    1. Reinicie o servidor (npm start) e abra no Safari: http://$($IpAddress[0]):$httpPort/aurora-ca.cer"
Write-Host '    2. Ajustes > Perfil Baixado > Instalar'
Write-Host '    3. Ajustes > Geral > Sobre > Ajustes de Confiança de Certificados > ligar "Aurora Local CA"'
Write-Host "    4. Abra https://$($IpAddress[0]):$HttpsPort e adicione à Tela de Início de novo"
Write-Host ''
Write-Host '  Confira a impressão digital SHA-256 do perfil no iPhone antes de confiar:'
Write-Host "    $caFingerprint"
Write-Host ''
