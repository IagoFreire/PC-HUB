<#
  Aurora Touch — roda na sessão do usuário logado e transforma os eventos do trackpad
  (repassados pelo servidor Aurora) em mouse e teclado de verdade, via SendInput.

  Precisa rodar na sessão do usuário: o agente principal roda como SYSTEM numa sessão
  isolada e não alcança a área de trabalho. Instalado pelo install-agent.ps1 como a
  tarefa "Aurora Touch", que inicia no logon com privilégios elevados (para também
  controlar janelas de administrador).

  Protocolo (TCP, uma linha por mensagem):
    PC -> servidor   AURORA1 <nonce hex>
    servidor -> PC   HMAC-SHA256(segredo, nonce) em hex
    PC -> servidor   OK
    servidor -> PC   {"t":"m","dx":3,"dy":-1}   (um evento JSON por linha)
#>
param(
    [int]$Port = 7778,
    [string]$SecretFile = (Join-Path $PSScriptRoot 'agent.secret')
)

$ErrorActionPreference = 'Stop'

$HelloDeadlineMs = 2000   # prazo TOTAL para o servidor provar o segredo (impede travar a porta)
$ReadTimeoutMs = 15000    # depois de autenticado: o servidor manda ping a cada 5 s; silêncio maior = conexão morta
$MaxHelloBytes = 128
$MaxEventChars = 2048
$MaxMove = 1000
$MaxScroll = 2400
$MaxText = 256
$MaxLogBytes = 256KB
$LogDir = Join-Path $env:LOCALAPPDATA 'Aurora'
$LogFile = Join-Path $LogDir 'touch.log'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AuroraInput
{
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
    const uint WHEEL = 0x0800, HWHEEL = 0x1000;
    const uint KEY_EXTENDED = 0x0001, KEY_UP = 0x0002, KEY_UNICODE = 0x0004;
    const ushort VK_RETURN = 0x0D;

    static void Send(params INPUT[] inputs)
    {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    static INPUT Mouse(uint flags, int dx, int dy, int data)
    {
        var input = new INPUT { type = INPUT_MOUSE };
        input.u.mi.dx = dx;
        input.u.mi.dy = dy;
        input.u.mi.mouseData = unchecked((uint)data);
        input.u.mi.dwFlags = flags;
        return input;
    }

    static INPUT Keyboard(ushort vk, ushort scan, uint flags)
    {
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki.wVk = vk;
        input.u.ki.wScan = scan;
        input.u.ki.dwFlags = flags;
        return input;
    }

    public static void Move(int dx, int dy) { Send(Mouse(MOVE, dx, dy, 0)); }

    public static void Button(bool right, bool down)
    {
        uint flags = right ? (down ? RIGHTDOWN : RIGHTUP) : (down ? LEFTDOWN : LEFTUP);
        Send(Mouse(flags, 0, 0, 0));
    }

    public static void Scroll(int horizontal, int vertical)
    {
        if (vertical != 0) Send(Mouse(WHEEL, 0, 0, vertical));
        if (horizontal != 0) Send(Mouse(HWHEEL, 0, 0, horizontal));
    }

    public static void Key(ushort vk, bool extended)
    {
        uint ext = extended ? KEY_EXTENDED : 0;
        Send(Keyboard(vk, 0, ext), Keyboard(vk, 0, ext | KEY_UP));
    }

    public static void Text(string text)
    {
        foreach (char c in text)
        {
            if (c == '\n') { Key(VK_RETURN, false); continue; }
            Send(Keyboard(0, c, KEY_UNICODE), Keyboard(0, c, KEY_UNICODE | KEY_UP));
        }
    }
}
'@

# tecla -> (virtual-key, é tecla estendida)
$Keys = @{
    enter     = @(0x0D, $false)
    backspace = @(0x08, $false)
    tab       = @(0x09, $false)
    esc       = @(0x1B, $false)
    left      = @(0x25, $true)
    up        = @(0x26, $true)
    right     = @(0x27, $true)
    down      = @(0x28, $true)
    delete    = @(0x2E, $true)
}

$script:Held = @{}

function Write-Log([string]$Message) {
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt $MaxLogBytes) {
            Move-Item $LogFile "$LogFile.old" -Force
        }
        Add-Content -Path $LogFile -Value ("[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Message) -Encoding UTF8
    } catch {
        Write-Warning "Falha ao gravar log: $_"
    }
}

function ConvertTo-Hex([byte[]]$Bytes) {
    return ([BitConverter]::ToString($Bytes) -replace '-', '').ToLowerInvariant()
}

# Comparação em tempo constante para não vazar a resposta esperada por timing.
function Test-SameText([string]$Given, [string]$Expected) {
    $a = [Text.Encoding]::ASCII.GetBytes([string]$Given)
    $b = [Text.Encoding]::ASCII.GetBytes($Expected)
    $diff = $a.Length -bxor $b.Length
    for ($i = 0; $i -lt $b.Length; $i++) {
        $byte = if ($i -lt $a.Length) { $a[$i] } else { 0 }
        $diff = $diff -bor ($byte -bxor $b[$i])
    }
    return $diff -eq 0
}

function Write-Line($Stream, [string]$Text) {
    $bytes = [Text.Encoding]::ASCII.GetBytes("$Text`n")
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

# Lê uma linha com tamanho e prazo máximos — antes da autenticação ninguém pode prender a porta.
# O ReadTimeout reinicia a cada byte, por isso o prazo total é controlado à parte.
function Read-BoundedLine($Stream, [int]$Max, [int]$DeadlineMs) {
    $bytes = New-Object System.Collections.Generic.List[byte]
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($bytes.Count -le $Max) {
        $remaining = $DeadlineMs - [int]$clock.ElapsedMilliseconds
        if ($remaining -le 0) { return $null }
        $Stream.ReadTimeout = $remaining
        $value = $Stream.ReadByte()
        if ($value -lt 0) { return $null }
        if ($value -eq 10) { return [Text.Encoding]::ASCII.GetString($bytes.ToArray()).TrimEnd("`r") }
        $bytes.Add([byte]$value)
    }
    return $null
}

function Get-Limited($Value, [int]$Max) {
    $number = 0
    if (-not [int]::TryParse([string]$Value, [ref]$number)) { return 0 }
    return [Math]::Max(-$Max, [Math]::Min($Max, $number))
}

function Invoke-TouchEvent($TouchEvent) {
    $right = [string]$TouchEvent.b -eq 'r'
    switch ([string]$TouchEvent.t) {
        'm' { [AuroraInput]::Move((Get-Limited $TouchEvent.dx $MaxMove), (Get-Limited $TouchEvent.dy $MaxMove)) }
        's' { [AuroraInput]::Scroll((Get-Limited $TouchEvent.dx $MaxScroll), (Get-Limited $TouchEvent.dy $MaxScroll)) }
        'c' {
            [AuroraInput]::Button($right, $true)
            [AuroraInput]::Button($right, $false)
        }
        'd' {
            [AuroraInput]::Button($right, $true)
            $script:Held[$right] = $true
        }
        'u' {
            [AuroraInput]::Button($right, $false)
            $script:Held.Remove($right)
        }
        'k' {
            $text = [string]$TouchEvent.text
            if ($text.Length -le $MaxText) { [AuroraInput]::Text($text) }
        }
        'key' {
            $key = $Keys[[string]$TouchEvent.k]
            if ($key) { [AuroraInput]::Key([uint16]$key[0], [bool]$key[1]) }
        }
        default { }  # 'p' (ping) e desconhecidos: nada a fazer
    }
}

# Conexão caiu no meio de um arraste: não deixa o botão "preso" apertado.
function Clear-HeldButtons {
    foreach ($right in @($script:Held.Keys)) { [AuroraInput]::Button([bool]$right, $false) }
    $script:Held.Clear()
}

function Invoke-Session($Client) {
    $Client.NoDelay = $true
    $stream = $Client.GetStream()

    $nonceBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($nonceBytes)
    $nonce = ConvertTo-Hex $nonceBytes
    Write-Line $stream "AURORA1 $nonce"

    $expected = ConvertTo-Hex ($Hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes($nonce)))
    $answer = Read-BoundedLine $stream $MaxHelloBytes $HelloDeadlineMs
    if (-not (Test-SameText $answer $expected)) {
        Write-Log "Autenticação recusada de $($Client.Client.RemoteEndPoint)"
        return
    }
    $stream.ReadTimeout = $ReadTimeoutMs
    Write-Line $stream 'OK'
    Write-Log "Servidor conectado: $($Client.Client.RemoteEndPoint)"

    $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding $false))
    while ($null -ne ($line = $reader.ReadLine())) {
        if ($line.Length -gt $MaxEventChars) { continue }
        try {
            Invoke-TouchEvent ($line | ConvertFrom-Json)
        } catch {
            Write-Log "Evento ignorado: $($_.Exception.Message)"
        }
    }
}

$secret = (Get-Content -LiteralPath $SecretFile -Raw).Trim()
if ($secret.Length -lt 16) { throw "Segredo inválido em $SecretFile" }
$Hmac = New-Object Security.Cryptography.HMACSHA256 (, [Text.Encoding]::UTF8.GetBytes($secret))

$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Any, $Port)
# Ninguém mais consegue abrir a mesma porta "por cima" para interceptar conexões.
$listener.ExclusiveAddressUse = $true
$listener.Start()
Write-Log "Aurora Touch ouvindo na porta $Port (usuário $env:USERNAME)"

while ($true) {
    try {
        $client = $listener.AcceptTcpClient()
    } catch {
        Write-Log "Falha ao aceitar conexão: $_"
        Start-Sleep -Milliseconds 200
        continue
    }
    try {
        Invoke-Session $client
    } catch {
        Write-Log "Sessão encerrada: $($_.Exception.Message)"
    } finally {
        Clear-HeldButtons
        $client.Close()
    }
}
