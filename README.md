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

### Air mouse (apontar com o celular)
No trackpad, toque no ícone de **celular com ondas** (ao lado do teclado). Com o modo ligado:
- **Segure** a superfície e aponte/gire o celular: o cursor segue o movimento. **Soltou, parou** — dá para reposicionar a mão sem mexer o cursor.
- **Toque rápido** = clique; **dois dedos** continuam rolando; os botões Esquerdo/Direito funcionam igual.
- Funciona com o celular deitado na mão (como um controle remoto) ou em pé, sem calibrar.

O air mouse **precisa do Aurora em HTTPS** (próxima seção): o iPhone só libera o giroscópio para sites seguros. Na primeira vez ele pede permissão de "Movimento e Orientação".

O trackpad só funciona com você **logado no Windows**: na tela de bloqueio o Windows não aceita mouse/teclado simulado. Sua conta do Windows precisa ser **administradora** — o Aurora Touch roda elevado (para alcançar também janelas de administrador) e só assim lê o segredo, que fica fora do alcance de programas comuns.

### Segurança, em resumo
- O app inteiro confia na **rede de casa**: o tráfego é HTTP comum, então o que você digita pelo trackpad passa sem criptografia pela rede local. Não use em Wi-Fi compartilhado; para fora de casa, use o Tailscale (criptografado).
- Quem tiver o **código de acesso** controla o PC (inclusive teclado). Trate-o como uma senha.
- Notebook ↔ PC usam o `agentSecret`: o agente exige o segredo em cada pedido, e o Aurora Touch faz um desafio HMAC a cada conexão (o segredo nunca trafega). As portas `7777`/`7778` só aceitam a rede local.

---

## Nobreak (Ragtech Supervise)

Se o nobreak é monitorado pelo **Supervise** (Ragtech), o Aurora mostra os dados dele:
- **Selo de bateria** no cabeçalho com a carga — verde na rede, âmbar com ⚡ na bateria, vermelho em falha. Toque para ver tudo.
- **Tela do nobreak**: carga, modo (rede/bateria), alertas e tensões de entrada/saída, frequência, consumo (% e VA), bateria, temperatura, corrente e contagem de desligamento.
- **Avisos** quando falta energia (nobreak vai para a bateria) e quando ela volta.
- **Quedas de energia**: o histórico do Supervise vira uma lista de quedas — quando começou, quanto durou e até quanto a bateria desceu —, com um resumo ("Última queda: ontem às 22:10, durou 5 min") e o registro completo de eventos em "Todos os eventos".

Configure no `config.json`:
```jsonc
"ups": {
  "url": "http://127.0.0.1:4470",   // endereço do Supervise (127.0.0.1 se ele roda no mesmo notebook do Aurora)
  "id": "0001521C0A"                 // opcional: sem ele, usa o primeiro nobreak do Supervise
}
```
O Aurora só **lê** os dados — nunca usa os comandos de shutdown do Supervise. O nome mostrado é o que está cadastrado no Supervise.

## HTTPS (necessário para o air mouse)

O iPhone só entrega os sensores de movimento a páginas HTTPS. O Aurora usa uma **autoridade certificadora só da sua casa**: você gera no notebook e diz ao iPhone para confiar nela, uma vez.

1. **No notebook** (Windows, PowerShell normal, na pasta do projeto):
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\tools\make-cert.ps1
   ```
   Gera `certs\aurora-ca.cer` e `certs\aurora.pfx` e adiciona a seção `tls` no `config.json`. Reinicie o servidor (`npm start`).
2. **No iPhone, Safari:** abra `http://<ip-do-notebook>:8080/aurora-ca.cer` → **Permitir** o download.
3. **Ajustes → Perfil Baixado → Instalar.** (Confira se a impressão digital SHA-256 bate com a que o script mostrou.)
4. **Ajustes → Geral → Sobre → Ajustes de Confiança de Certificados** → ligue **Aurora Local CA**.
5. Abra `https://<ip-do-notebook>:8443`, entre com o código e **adicione à Tela de Início de novo** (remova o atalho antigo em `http://` — é outro endereço, por isso o código é pedido de novo).

Com HTTPS ligado, a porta `8080` só redireciona para o `https://…:8443` e serve o certificado. Se o IP do notebook mudar, rode o script de novo (e reinstale o perfil). O certificado do servidor vale 800 dias.

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
| Air mouse: "precisa do Aurora em HTTPS" | Siga a seção HTTPS e abra o app pelo endereço `https://…:8443` |
| Air mouse: "Acesso ao movimento negado" | Ajustes → Apps → Safari → Movimento e Orientação → ligar; depois feche e reabra o app |
| Safari diz "conexão não é privada" | O perfil da CA não foi instalado ou não foi marcado como confiável (passos 3 e 4) |
| Trackpad não mexe em janelas de administrador | O Aurora Touch precisa rodar elevado: reinstale com o PowerShell como Administrador |

## Desenvolvimento

```bash
npm test               # testes (node:test)
npm run test:coverage  # com cobertura
npm run icons          # regenera os PNGs a partir de public/icons/icon.svg (precisa de Chrome/Edge + Pillow)
```
