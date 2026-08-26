# Verificação

O que dá para automatizar já está em `npm run test:signaling` e nos typechecks. O
caminho de mídia precisa de olho humano — abaixo está o roteiro, do mais rápido
ao mais chato.

## 0. O que já foi verificado em execução

Registrado para não ser refeito à toa:

| Item | Resultado medido |
|---|---|
| Captura de tela | 1920x1080 @ 60fps, `contentHint: motion` |
| Áudio do sistema | **estéreo (2 canais)**, 48 kHz, com AEC/AGC/NS **desligados** |
| Vídeo no viewer | 227 frames decodificados em 3s |
| Áudio no viewer | tom de 440 Hz reproduzido na máquina chegou medido a **445 Hz**, RMS 0,15 |
| Stats bidirecionais | host envia 1080p@57fps; viewer relata 1080p@56fps |
| Codec negociado | H264 (preferência do preset funcionou) |
| Encoder | `MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)` — GPU |
| GPU do Electron | `video_encode: enabled`, vendor NVIDIA |
| MKV real (Matroska test suite) | container abre e o **áudio toca**, mas vídeo fica `0x0` — recusado pelo app |
| Transferência do Modo Cinema | 12 MB byte a byte idênticos, buffer travado em 1,06 MB |
| Áudio isolado por processo | tom em outro app → saída em RMS 0,00001; janela que toca → 0,248 |
| Codec com AV1 nos presets | negocia AV1, mas encoda em `libaom` (CPU) — por isso H.264 segue padrão |
| Orçamento apertado a 150 kbps | áudio caiu para **48 kbps** e o vídeo sobreviveu em **360p** (427x240) |
| Volta do aperto | sozinho, subiu para **720p** com áudio em **192 kbps** |
| Autoplay do viewer | começa `muted=true`, `paused=false`, imagem em 1600x900 **antes** de qualquer clique |
| Queda do túnel (WebSocket cortado no meio da transmissão) | vídeo avançou **19,86 s em 19,8 s** de relógio; **zero** frames em branco; sala inalterada |
| Mesma medição sem cortar nada (controle) | pior congelamento **1,2 s** — a linha de base da tela parada; com o corte, 1,8 s |
| Retomada do Modo Cinema | host morto a 85% de um arquivo de 271 MB; retomou **em 85%** e o SHA-256 do arquivo montado bateu com o original |
| Silenciar vários apps | tom em 0,210 → **0,010** com 1 app mudo → **0,0016** com 2 |
| Eco da própria sala | tom tocando no app medido em **0,209**; o que sai para os espectadores: **0,0017** |
| Cadência do mixer | 4,99 s de áudio para 5,02 s de relógio (−0,6%) |

O teste de áudio vale a pena repetir do jeito que foi feito: tocar um tom puro
numa aba do navegador e medir a frequência dominante do outro lado prova o
caminho inteiro — loopback, Opus, WebRTC, decodificação — de uma vez só.

## 1. Fumaça do servidor (automatizado, ~2s)

```bash
npm run test:signaling
```

Cobre criar sala, entrar, relay de SDP/ICE, senha errada, token de host inválido,
mensagem malformada e — o mais importante para sessão longa — o host cair e
retomar a **mesma** sala.

## 2. Ponta a ponta na mesma máquina (~1 min)

Com os três serviços rodando (`dev:signaling`, `dev:web`, `dev:host`):

1. No app do host, clique em **Escolher tela ou janela** e escolha algo com som
   tocando (um vídeo no YouTube serve).
2. Deixe *Incluir o som do computador* marcado.
3. Abra `http://localhost:5173` no navegador, digite o código da sala e clique em
   **Entrar e ouvir**.

Você deve ver a imagem em menos de um segundo e ouvir o áudio. Se a imagem
aparecer e o som não, o culpado quase sempre é o passo 2.

**O que confirmar:**

- No app do host, o card *Quem está assistindo* mostra a pessoa como `conectado`,
  com números nas duas colunas (**Enviando** e **Recebendo — relato dele**).
- No viewer, tecla <kbd>i</kbd> abre o diagnóstico. **Caminho** deve dizer
  `direto (host)` ou `direto (srflx)`. Se disser `via TURN (relay)` numa rede
  local, algo está errado na descoberta de rede.

## 2b. Filme do computador

1. No app do host, clique em **Arquivo do PC** (ou arraste o vídeo para a área de
   preview) e escolha um `.mp4`.
2. Dê play no player que aparece.

**O que confirmar:** o vídeo aparece para quem assiste; play, pause e seek feitos
no host valem para todo mundo; no viewer, aparece um contador de posição ao lado
do nome do arquivo, e ele anda suave (não aos saltos de 2 em 2 segundos).

Se o arquivo não abrir, o app diz por quê. MKV e HEVC falham por design — o
Chromium não traz esses demuxers. Converter para MP4 resolve.

## 2b-bis. Áudio isolado (o teste que exige cuidado)

Compartilhe **uma janela** e confirme que só o som dela sai.

**Como medir sem se enganar** — esta parte importa, porque na primeira tentativa
eu conclui errado: toque um tom puro num aplicativo, compartilhe a janela de
**outro**, e meça a energia do áudio recebido. Só que o app-alvo pode estar
emitindo som por conta própria (uma chamada, uma notificação), e aí a medição
acusa "vazamento" que não existe.

O controle correto é **ligar e desligar o tom** e ver se a medição muda:

```bash
node packages/native-audio/teste-discrimina.mjs <PID_QUE_TOCA> <PID_SILENCIOSO>
```

Esperado com o tom ligado: INCLUDE do que toca ≈ 0,25; INCLUDE do silencioso
≈ 0,00001; EXCLUDE do que toca ≈ 0. Com o tom desligado, os três vão a zero.

## 2b-ter. Trocar de fonte no meio da transmissão

Com alguém assistindo, troque de uma janela para a tela inteira (e vice-versa).

**O que confirmar:** a imagem do outro lado muda em ~1s e os frames continuam
chegando. Se ela congelar no último quadro da fonte antiga, voltou o bug de
soltar a captura antes de adquirir a nova.

**E o teste que importa mais:** feche o app do host e abra de novo com alguém
assistindo. O código da sala tem que ser **o mesmo** (o link já está com seus
amigos) e a tela do espectador deve sair de "o host saiu" sozinha.

## 2b-quater. O áudio não pode afogar o vídeo

O bug mais caro do projeto, e o mais fácil de reproduzir agora — sem precisar
estrangular a rede de verdade.

1. Com alguém assistindo, no card **Limite de upload** escolha *Eu digo quanto*.
2. Digite **0,15** (Mbps).

**O que confirmar** no card do espectador, em até ~10 s:

- a linha da decisão passa a dizer `360p — dentro do limite de upload que você
  definiu · audio 48 kbps`;
- **audio** cai para 48 kbps e o vídeo continua existindo.

Antes da correção, o mesmo aperto produzia ~88 kbps de som e **3 kbps** de
imagem, porque o áudio era fixo em 256 kbps e se servia primeiro.

Volte para *Automático* e confirme que, em ~20 s, a resolução e o áudio sobem de
novo — descer rápido é fácil; o que costuma faltar nos apps é voltar.

## 2b-quinquies. Conectar de qualquer rede (o teste do iPhone)

Este é o único teste que exige um segundo aparelho, e é o que mais importa: foi
um iPhone em 4G que ficou em "Conectando…" para sempre.

1. Publique o servidor (túnel ou VPS) e abra o link no celular **com o Wi-Fi
   desligado**.
2. Antes de entrar, toque em **Testar minha conexão**.

**O que confirmar:**

- o veredito menciona TURN com ✓ (com `CF_TURN_KEY_ID` configurado);
- a imagem aparece em poucos segundos, **muda**, com o botão *Toque para ativar o
  som*;
- no HUD (tecla `i` ou o botão *Stats*), **Caminho** pode dizer `via TURN
  (relay)` — e a sessão continua de pé.

**E o teste que prova o conserto:** derrube o TURN de propósito (rode o servidor
sem as variáveis da Cloudflare) e tente de novo. Depois de ~12 s a tela precisa
dizer **"Não consegui conectar"**, listar os caminhos encontrados e explicar que
falta retransmissão — nunca ficar em "Conectando…" indefinidamente.

## 2b-sexies. Queda do túnel no meio da sessão

O teste que nasceu da pior sessão até agora: o `cloudflared` perdeu a conexão
QUIC duas vezes em 15 minutos, e cada queda custava um pedaço do filme e, na
segunda, o link inteiro.

**O detalhe que faz o teste valer:** o túnel **não derruba o servidor** — ele só
mata os WebSockets. Matar o processo do servidor testa outra coisa (as salas
vivem na memória dele, então elas somem e o host cria uma sala nova, o que é o
comportamento correto). Para reproduzir o caso real, corte só o socket:

```bash
node server/signaling/test/smoke.mjs
```

As três verificações que cobrem isso rodam aí dentro: *sala sobrevive quando
host e espectador caem juntos*, *quem volta com o mesmo token mantém o mesmo id
de peer* e *pessoa diferente ganha id diferente*.

**Para ver com os próprios olhos**, com alguém assistindo: reinicie o
`cloudflared` (Ctrl+C e rode de novo). Isso derruba os WebSockets dos dois lados
sem tocar no servidor — exatamente o que a queda de QUIC faz.

**O que confirmar:**

- a imagem **não pisca** e não volta ao início: o vídeo continua andando;
- o código da sala continua **o mesmo** no painel do host;
- ninguém vê "o host saiu", "Conectando…" nem "sala não encontrada";
- no painel do host, a pessoa continua listada como `conectado`.

Se a imagem piscar, voltou o bug de tratar queda de sinalização como queda de
mídia. Se o código mudar, voltou o `sala vazia` apagando a sala dentro da janela
de retomada.

**Dica para o túnel em si:** as quedas eram do transporte QUIC (UDP). Forçar
HTTP/2 deixa o túnel bem mais estável em redes que maltratam UDP:

```bash
npx cloudflared tunnel --url http://localhost:8787 --protocol http2
```

## 2b-septies. Retomada do Modo Cinema

Um filme de 2 GB leva minutos para transferir, e nesse tempo o host pode
reiniciar. Antes, tudo que já tinha chegado ia para o lixo.

1. No host, **Arquivo do PC**, escolha um vídeo grande e ligue o **Modo Cinema**.
2. Espere a barra do espectador passar de uns 30%.
3. **Mate o app do host** (fechar a janela serve).
4. Abra o app de novo e escolha **o mesmo arquivo**; ligue o Modo Cinema.

**O que confirmar:**

- ao reiniciar, a barra do espectador **continua onde estava** — se voltar a 0%,
  voltou o `film-cancel` vazio apagando o progresso de quem já baixou;
- ao recarregar o arquivo, a transferência **retoma daquele ponto**, não do zero;
- no console do host aparece `retomando o filme para <nome> em N%`.

**A verificação que fecha o caso** é comparar os bytes, porque retomar na posição
errada produz um arquivo do tamanho certo com o conteúdo embaralhado — que parece
sucesso. No espectador:

```js
const v = document.querySelector('video')
const buf = await (await fetch(v.src)).arrayBuffer()
const d = await crypto.subtle.digest('SHA-256', buf)
console.log(buf.byteLength, [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join(''))
```

E no computador do host:

```bash
node -e "const f=require('fs'),c=require('crypto'),h=c.createHash('sha256');f.createReadStream(process.argv[1]).on('data',d=>h.update(d)).on('end',()=>console.log(f.statSync(process.argv[1]).size,h.digest('hex')))" "CAMINHO/DO/FILME.mp4"
```

Os dois números precisam bater. **Aviso sobre falso negativo:** num Chrome
*headless* o vídeo montado pode aparecer como `0x0` mesmo estando perfeito — é
falta de codec proprietário, não corrupção. Foi o que aconteceu na medição
registrada acima, e só o hash desfez a dúvida.

## 2b-octies. Silenciar vários apps, e não ecoar a si mesmo

Duas coisas que a API do Windows não deixa pedir de frente: os parâmetros de
ativação carregam **um** `TargetProcessId`, então "tudo menos o Junto **e** o
Discord" não existe como pedido. O som passa a ser montado — uma captura por
aplicativo que **não** foi silenciado, somadas.

```bash
node packages/native-audio/teste-mixagem.mjs
```

**Como medir sem se enganar:** a medição só vale com som tocando. Abra uma aba
com um tom puro (WebAudio, 440 Hz) e meça a energia do que sai:

| Silenciado | RMS esperado |
|---|---|
| nada | alto (~0,2 com o tom) |
| o app do tom | ~0,01 |
| o app do tom + outro | ~0,001 |

Se silenciar o app do tom **não** derrubar o número, o casamento por nome de
executável quebrou — e ele é essencial: o Discord roda com **dois processos**, e
marcar "Discord" precisa pegar os dois.

**O teste do eco**, que é o mais fácil de esquecer: faça o **próprio app** tocar
um tom (no console do renderer: um `AudioContext` com oscilador) e meça o que
sai. Os dois números precisam ser muito diferentes — o tom alto medido dentro do
processo, e silêncio na saída. Se forem iguais, o app está capturando a si mesmo,
e quem assiste vai se ouvir com atraso.

**A armadilha específica:** o processo que segura a sessão de áudio **não é** o
processo principal do Electron. O Chromium renderiza som num processo filho de
serviço — medido aqui: o app roda com 4 processos, e o dono da sessão era um
quinto que só aparece quando há som. Excluir só `currentProcessId()` não resolve;
é preciso a árvore inteira.

**A cadência também merece um olhar.** O mixer emite um bloco a cada 10 ms, e o
lado que recebe monta o timestamp da trilha pela contagem de amostras — então
emitir rápido demais faz o áudio adiantar progressivamente em relação ao vídeo.
Compare segundos de áudio produzidos com segundos de relógio: têm que bater
dentro de ~1%. Já deu 30% de excesso, porque a resolução padrão de timer do
Windows (~15,6 ms) fazia o laço disparar em rajada para recuperar atraso.

## 2c. Voz e chat

1. Clique em **Microfone** no host e em **Microfone** no viewer.
2. Fale dos dois lados.

**O que confirmar:**

- O slider **Voz** no viewer controla só a voz; o slider **Tela** só o
  filme/jogo. Baixar um não afeta o outro — é para isso que as trilhas são
  separadas.
- Com o som do sistema alto e o microfone aberto no host, quem assiste **não**
  deve ouvir eco do próprio filme voltando. Se ouvir, o cancelamento de eco do
  microfone não está ativo.
- Com dois espectadores na mesma sala, uma mensagem de chat de um deve aparecer
  para o outro, com o nome de quem escreveu (o host retransmite).

## 2d. Modo Cinema

Com um arquivo carregado, clique em **Modo Cinema** no host.

**O que confirmar:**

- No host, cada espectador ganha uma barra de progresso do download.
- No viewer, aparece "Recebendo o filme… X%" e, ao terminar, o vídeo começa
  sozinho na posição certa.
- No topo do viewer, o indicador `cinema · ±0.0Xs` mostra o desvio em relação ao
  host. Deve ficar abaixo de 0,1s na maior parte do tempo.
- Pause no host: o viewer pausa. Dê um seek de 10 minutos: o viewer pula junto.
- **O teste que prova o ponto:** com o Modo Cinema ligado, o upload do host cai
  para quase zero depois da transferência (confira em *Enviando* no painel). É a
  diferença entre mandar 8 Mbps por duas horas e mandar o arquivo uma vez.

## 2d-bis. Testar TURN de verdade, localmente

Com o Docker Desktop rodando:

```bash
npm run turn:local
```

Em outro terminal, aponte o servidor para ele:

```bash
TURN_URLS=turn:localhost:3478 TURN_SECRET=junto-local npm run dev:signaling
```

Agora **Testar minha conexao** deve marcar TURN com ✓. Se marcar ✗, o problema
está no coturn (portas UDP, firewall) e não no app — que é exatamente a
separação que esse teste existe para fazer.

## 2e. Diagnóstico de rede

Na tela de entrada, clique em **Testar minha conexao**. Ele responde três
perguntas antes de a sessão começar:

- Conexão direta funciona?
- STUN descobre seu IP público?
- TURN está configurado **e respondendo**?

O teste do TURN força `iceTransportPolicy: 'relay'` — sem isso o navegador nem
tentaria o TURN quando já achou um caminho direto, e um TURN quebrado passaria
despercebido até alguém em 4G tentar entrar.

## 3. Latência real (glass-to-glass)

O número que importa não é o RTT do HUD — é o tempo entre a coisa acontecer na
sua tela e aparecer na tela do outro.

1. Abra um cronômetro com milissegundos na tela transmitida
   (`https://www.google.com/search?q=stopwatch` serve).
2. Coloque a janela do viewer ao lado da fonte.
3. Fotografe as duas ao mesmo tempo (celular, ou <kbd>Win</kbd>+<kbd>PrtScn</kbd>).
4. A diferença entre os dois cronômetros é a latência real.

**Metas:** menos de 200 ms na mesma rede, menos de 400 ms pela internet.

## 4. Redes diferentes (o teste que importa)

Os testes acima passam mesmo com bugs de rede, porque `localhost` esconde tudo.
O teste de verdade é o host numa rede e o viewer em **outra** — celular em 4G,
sem Wi-Fi, é o cenário mais duro.

Se falhar aí e funcionar na LAN, o diagnóstico é quase certo: falta TURN. Confira
com `curl https://seu-dominio/ice` — se a resposta só tiver `stun:`, é isso.

## 5. Áudio — teste com música, não com voz

Voz mascara os defeitos que estamos evitando. Transmita **música** e ouça:

- O volume oscila sozinho? → controle automático de ganho ficou ligado.
- O som "some" nos trechos baixos? → supressão de ruído ou DTX.
- Parece mono? → o `stereo=1` não entrou no SDP dos dois lados.

Para inspecionar: abra `chrome://webrtc-internals` no viewer, procure a linha do
Opus e confirme `stereo=1` e `maxaveragebitrate`.

## 6. Sessão longa (o caso de uso principal)

Transmita por 3 horas seguidas acompanhando o Gerenciador de Tarefas: uso de CPU
e memória do processo do Electron devem ficar estáveis, sem crescer aos poucos.
É exatamente aqui que apps como o Kast falham, e é o cenário que motivou o
projeto.

Durante a sessão, teste a resiliência:

- Desligue o Wi-Fi do host por ~20s e ligue de novo. A sala deve continuar e a
  imagem voltar sozinha, **sem trocar o link**.
- Deixe a máquina ociosa 15 min. A tela não pode apagar (`powerSaveBlocker`).

## 7. Instrumentação

`chrome://webrtc-internals` no viewer é a fonte da verdade:

| Procure | O que significa |
|---|---|
| `qualityLimitationReason` | `cpu` = o encoder do host não dá conta; `bandwidth` = upload saturado |
| Bitrate do Opus em `outbound-rtp` | deve **acompanhar** a decisão do painel; se ficar fixo em 256 kbps num link ruim, o governor do áudio parou de agir |
| `hardware H.264 encoder only supports even sized frames` no log do Chromium | dimensão ímpar chegou ao encoder: a GPU recusou e caiu para software. Não aparece na interface — só aqui |
| `encoderImplementation` | Nomes com `External`, `NvEnc`, `QuickSync` = GPU. `libvpx`/`OpenH264` = software |
| `framesDropped` / `freezeCount` | Crescendo = congestionamento real, não impressão |
| `candidate-pair` selecionado | `relay` de um dos lados = passando por TURN |
