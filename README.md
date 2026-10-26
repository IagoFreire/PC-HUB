# Aurora ✦

**Seu PC na palma da mão.** Um PWA para iPhone que liga o PC por Wake-on-LAN, desliga/reinicia, mostra se ele está ligado e vira **trackpad e teclado** do PC — tudo pela rede de casa.

```
 iPhone (PWA)  ──HTTP/WebSocket──►  Notebook (servidor Aurora)  ──magic packet (UDP)──►  PC
                                            │
                                            ├──HTTP + segredo──►  Aurora Agent (desligar/reiniciar, status)
                                            └──TCP + HMAC─────►  Aurora Touch (mouse e teclado)
```

| Peça | Onde roda | O que faz |
|---|---|---|
| `server/` + `public/` | Notebook que fica ligado | Serve o app, envia o magic packet, consulta o PC, repassa o trackpad |
| `agent/aurora-agent.ps1` | PC, como SYSTEM, desde o boot | Responde "estou ligado" e executa desligar/reiniciar |
| `agent/aurora-touch.ps1` | PC, na sua sessão, após o login | Transforma toques do celular em mouse e teclado |

Sem dependências: só Node.js 18+ no notebook e o PowerShell que já vem no Windows.

---

## 1. Preparar o PC (uma vez)

### BIOS/UEFI
Ative **Wake on LAN** (às vezes chamado *Power On By PCI-E*, *Resume by LAN* ou *Wake on PCIe*). Se existir **ErP / EuP Ready**, deixe **desativado** — ele corta a energia da placa de rede.

### Agente + Windows
Abra o **PowerShell como Administrador** na pasta do projeto e rode:

```powershell
powershell -ExecutionPolicy Bypass -File .\agent\install-agent.ps1 -ConfigureWol
```

Isso:
- copia o agente para `C:\ProgramData\Aurora` (o segredo fica legível só por SYSTEM/Administradores — e pelo seu usuário, para o trackpad);
- libera as portas `7777` (agente) e `7778` (trackpad) no firewall **apenas para a rede local**;
- cria a tarefa **Aurora Agent**, que inicia junto com o Windows (antes do login);
- cria a tarefa **Aurora Touch**, que inicia quando você faz login (o trackpad precisa da sua sessão para mexer no mouse);
- com `-ConfigureWol`: ativa *Wake on Magic Packet* / *Shutdown Wake-On-Lan* na placa de rede e **desativa a Inicialização Rápida** (que impede o WoL depois de desligar).

O segredo e a porta vêm do `config.json` da raiz, então PC e servidor já ficam combinados. No fim ele mostra MAC e IP do PC e faz um autoteste.

> **Dica:** reserve o IP do PC no roteador (DHCP estático) para ele não mudar.

Para remover: `powershell -ExecutionPolicy Bypass -File .\agent\uninstall-agent.ps1`

## 2. Subir o servidor no notebook

1. Instale o [Node.js LTS](https://nodejs.org).
2. Copie a pasta do projeto **inteira** (incluindo o `config.json`) para o notebook. A pasta `agent/` não é usada lá.
3. Rode:
   ```bash
   npm start
   ```
   Ele mostra o endereço para abrir no iPhone, tipo `http://192.168.200.50:8080`.

### Deixar rodando sempre

**Notebook com Windows** — PowerShell como Administrador, na pasta do projeto:
```powershell
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "server\index.js" -WorkingDirectory (Get-Location)
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Aurora Server" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest
New-NetFirewallRule -DisplayName "Aurora Server" -Direction Inbound -Protocol TCP -LocalPort 8080 -RemoteAddress LocalSubnet -Action Allow
Start-ScheduledTask "Aurora Server"
```
E em *Opções de energia*, configure **"Ao fechar a tampa: Não fazer nada"** e desative a suspensão.

**Notebook com Linux** — `/etc/systemd/system/aurora.service`:
```ini
[Unit]
Description=Aurora
After=network-online.target

[Service]
WorkingDirectory=/opt/aurora
ExecStart=/usr/bin/node server/index.js
Restart=always
User=aurora

[Install]
WantedBy=multi-user.target
```
`sudo systemctl enable --now aurora` — e `HandleLidSwitch=ignore` em `/etc/systemd/logind.conf`.

## 3. Instalar no iPhone

1. No **Safari**, abra o endereço do servidor (ex.: `http://192.168.200.50:8080`).
2. Digite o **código de acesso** (campo `accessToken` do `config.json`).
3. Toque em **Compartilhar → Adicionar à Tela de Início**.

Pronto: a Aurora abre em tela cheia, com ícone próprio.

### Usando
- **Toque no botão** com o PC desligado → envia o magic packet e acompanha até ele acordar.
- **Toque com o PC ligado** → abre a confirmação para **Desligar** ou **Reiniciar** (o Windows recebe 5 s de aviso).
- O céu muda com o estado: aurora acesa = ligado, noite = desligado, tons quentes = desligando.

### Trackpad e teclado
Com o PC ligado, toque em **Trackpad e teclado** no cartão de baixo.

| Gesto | Ação no PC |
|---|---|
| Um dedo arrastando | Move o cursor (mais rápido = vai mais longe) |
| Toque | Clique esquerdo |
| Toque com dois dedos | Clique direito |
| Dois dedos arrastando | Rola a página (o conteúdo segue o dedo) |
| Toque duplo e arraste | Segura o clique e arrasta (selecionar, mover janelas) |
| Botões **Esquerdo / Direito** | Segurar = botão apertado, para arrastar com outro dedo |
| Ícone de teclado | Abre o teclado do iPhone e digita no PC; aparecem também Esc, Tab, setas, ⌫ e Enter |

O trackpad só funciona com você **logado no Windows**: na tela de bloqueio o Windows não aceita mouse/teclado simulado. Sua conta do Windows precisa ser **administradora** — o Aurora Touch roda elevado (para alcançar também janelas de administrador) e só assim lê o segredo, que fica fora do alcance de programas comuns.

### Segurança, em resumo
- O app inteiro confia na **rede de casa**: o tráfego é HTTP comum, então o que você digita pelo trackpad passa sem criptografia pela rede local. Não use em Wi-Fi compartilhado; para fora de casa, use o Tailscale (criptografado).
- Quem tiver o **código de acesso** controla o PC (inclusive teclado). Trate-o como uma senha.
- Notebook ↔ PC usam o `agentSecret`: o agente exige o segredo em cada pedido, e o Aurora Touch faz um desafio HMAC a cada conexão (o segredo nunca trafega). As portas `7777`/`7778` só aceitam a rede local.

---

## `config.json`

```jsonc
{
  "port": 8080,                    // porta do servidor no notebook
  "accessToken": "XXXX-XXXX-XXXX", // código digitado no iPhone
  "pc": {
    "name": "PC do Iago",          // nome exibido no app
    "mac": "B0:82:E2:4C:1F:EF",    // MAC da placa de rede do PC
    "ip": "192.168.200.108",       // IP do PC
    "broadcast": "192.168.200.255",// broadcast da rede (opcional, deduzido do IP)
    "agentPort": 7777,             // porta do agente
    "touchPort": 7778,             // porta do Aurora Touch (trackpad), opcional
    "agentSecret": "…"             // segredo compartilhado servidor ↔ agente
  }
}
```

O `config.json` deste projeto já foi gerado com os dados deste PC e com código/segredo aleatórios. Use `config.example.json` como modelo se precisar recriar. Se trocar o `agentSecret`, rode o `install-agent.ps1` de novo no PC.

## Acesso fora de casa (opcional)

Não exponha a porta no roteador. Use o [Tailscale](https://tailscale.com) no notebook e no iPhone e abra o app pelo IP do Tailscale do notebook (`http://100.x.y.z:8080`). O notebook continua mandando o magic packet na rede local normalmente.

> Evite colocar o servidor atrás de proxy/túnel (`tailscale serve`, cloudflared, nginx): o bloqueio anti-força-bruta é por IP, e atrás de um proxy todo mundo vira o mesmo IP.

## Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Não liga depois de **desligar** pelo Iniciar, mas liga depois de suspender | Inicialização Rápida ativa ou "Shutdown Wake-On-Lan" desligado → rode o instalador com `-ConfigureWol` |
| Não liga de jeito nenhum | WoL desativado na BIOS, ErP ativo, ou o notebook está no Wi-Fi de outra rede/VLAN |
| "Agente: Não responde" com o PC ligado | Tarefa *Aurora Agent* parada ou firewall — veja `C:\ProgramData\Aurora\agent.log` |
| "Agente: Segredo não confere" | `agentSecret` diferente entre `config.json` e o PC → rode o instalador de novo |
| "Muitas tentativas erradas" | 10 códigos errados seguidos; espere 15 minutos |
| Trackpad: "Não consegui conectar ao Aurora Touch" | Ninguém logado no Windows, ou a tarefa *Aurora Touch* não está rodando — veja `%LOCALAPPDATA%\Aurora\touch.log` |
| Trackpad: "recusou o segredo" | `agentSecret` diferente entre `config.json` e o PC → rode o instalador de novo |
| Trackpad não mexe em janelas de administrador | O Aurora Touch precisa rodar elevado: reinstale com o PowerShell como Administrador |

## Desenvolvimento

```bash
npm test               # testes (node:test)
npm run test:coverage  # com cobertura
npm run icons          # regenera os PNGs a partir de public/icons/icon.svg (precisa de Chrome/Edge + Pillow)
```
