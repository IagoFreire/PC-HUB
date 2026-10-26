<#
  Aurora Agent — roda no PC e atende o servidor Aurora (no notebook).

    GET  /health                       -> { ok, hostname, uptimeSec }
    POST /power  { "action": "..." }   -> shutdown | restart

  Toda requisição precisa de "Authorization: Bearer <segredo>".
  É instalado como tarefa agendada (conta SYSTEM) pelo install-agent.ps1.
#>
param(
    [int]$Port = 7777,
    [string]$SecretFile = (Join-Path $PSScriptRoot 'agent.secret')
)

$ErrorActionPreference = 'Stop'

$MaxBodyBytes = 1024
$MaxLogBytes = 512KB
$LogFile = Join-Path $PSScriptRoot 'agent.log'

$Commands = @{
    shutdown = @('/s', '/t', '5', '/c', 'Desligado pelo Aurora')
    restart  = @('/r', '/t', '5', '/c', 'Reiniciado pelo Aurora')
}

function Write-Log([string]$Message) {
    try {
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt $MaxLogBytes) {
            Move-Item $LogFile "$LogFile.old" -Force
        }
        Add-Content -Path $LogFile -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message) -Encoding UTF8
    } catch {
        Write-Warning "Falha ao gravar log: $_"
    }
}

$secret = (Get-Content -LiteralPath $SecretFile -Raw).Trim()
if ($secret.Length -lt 16) { throw "Segredo inválido em $SecretFile" }
$expectedBytes = [Text.Encoding]::UTF8.GetBytes("Bearer $secret")

# Comparação em tempo constante para não vazar o segredo por timing.
function Test-Authorization([string]$Header) {
    $given = [Text.Encoding]::UTF8.GetBytes([string]$Header)
    $diff = $given.Length -bxor $expectedBytes.Length
    for ($i = 0; $i -lt $expectedBytes.Length; $i++) {
        $byte = if ($i -lt $given.Length) { $given[$i] } else { 0 }
        $diff = $diff -bor ($byte -bxor $expectedBytes[$i])
    }
    return $diff -eq 0
}

function Send-Json($Context, [int]$Status, $Body) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
    $response = $Context.Response
    $response.StatusCode = $Status
    $response.ContentType = 'application/json; charset=utf-8'
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.Close()
}

function Read-JsonBody($Request) {
    if ($Request.ContentLength64 -gt $MaxBodyBytes) { return $null }
    $reader = New-Object IO.StreamReader($Request.InputStream, [Text.Encoding]::UTF8)
    try {
        $text = $reader.ReadToEnd()
        if ($text.Length -gt $MaxBodyBytes) { return $null }
        return $text | ConvertFrom-Json
    } catch {
        return $null
    } finally {
        $reader.Dispose()
    }
}

$bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://+:$Port/")
$listener.Start()
Write-Log "Agente iniciado na porta $Port"

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
    } catch {
        Write-Log "Falha ao aceitar conexão: $_"
        Start-Sleep -Milliseconds 200
        continue
    }
    try {
        $request = $context.Request
        if (-not (Test-Authorization $request.Headers['Authorization'])) {
            Write-Log "Acesso negado de $($request.RemoteEndPoint)"
            Send-Json $context 401 @{ error = 'unauthorized' }
            continue
        }

        switch ("$($request.HttpMethod) $($request.Url.AbsolutePath)") {
            'GET /health' {
                Send-Json $context 200 @{
                    ok        = $true
                    hostname  = $env:COMPUTERNAME
                    uptimeSec = [int64]((Get-Date) - $bootTime).TotalSeconds
                }
            }
            'POST /power' {
                $payload = Read-JsonBody $request
                $action = if ($payload) { [string]$payload.action } else { '' }
                if (-not $Commands.ContainsKey($action)) {
                    Send-Json $context 400 @{ error = 'invalid action' }
                    break
                }
                Write-Log "Executando '$action' a pedido de $($request.RemoteEndPoint)"
                # O operador & põe aspas nos argumentos com espaço (o Start-Process não);
                # shutdown.exe só agenda e retorna na hora, então dá para checar o resultado antes de responder.
                & "$env:SystemRoot\System32\shutdown.exe" @($Commands[$action]) | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "shutdown.exe falhou com código $LASTEXITCODE"
                    Send-Json $context 500 @{ error = "shutdown failed ($LASTEXITCODE)" }
                    break
                }
                Send-Json $context 202 @{ ok = $true; action = $action }
            }
            default {
                Send-Json $context 404 @{ error = 'not found' }
            }
        }
    } catch {
        Write-Log "Erro atendendo requisição: $_"
        try { Send-Json $context 500 @{ error = 'internal' } } catch { Write-Log "Cliente desconectou antes da resposta: $_" }
    }
}
