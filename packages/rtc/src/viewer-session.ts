import type { ControlMessage, IceServer, SignalPayload, SourceKind } from '@junto/protocol'
import {
  CONTROL_CHANNEL_LABEL,
  FILM_CHANNEL_LABEL,
  MID_VOICE,
  parseControlMessage
} from '@junto/protocol'
import { FilmReceiver } from './film-transfer.js'
import { tuneOpus } from './sdp.js'
import { minimizePlayoutDelay } from './sender-tuning.js'
import { SignalingClient, type ConnectionStatus } from './signaling-client.js'
import { StatsCollector, type LinkStats } from './stats.js'

/**
 * Sessao do VIEWER: uma conexao com o host, so recebendo.
 *
 * O host sempre faz a oferta e o viewer sempre responde. Essa assimetria elimina
 * de vez o "glare" (os dois ofertando ao mesmo tempo), que e a causa mais comum
 * de negociacao travada em apps de WebRTC feitos a mao.
 */

export interface SourceInfo {
  kind: SourceKind
  title: string
  hasAudio: boolean
  preset?: string
}

/** Estado do filme original recebido no Modo Cinema. */
export interface FilmState {
  name: string
  size: number
  received: number
  bytesPerSecond: number
  ready: boolean
  /** objectURL do arquivo montado; so existe quando ready = true. */
  url: string | null
}

export interface PlayerState {
  state: 'playing' | 'paused' | 'ended'
  positionSec: number
  durationSec: number | null
  hostTimeMs: number
}

/**
 * O que sabemos sobre a tentativa de conexao em andamento.
 *
 * Existe porque "Conectando..." para sempre foi um sintoma real, num iPhone em
 * 4G, e nao havia em lugar nenhum a informacao que explicava: nenhum candidato
 * `relay` porque nao havia TURN configurado. Sem isso, a unica leitura possivel
 * do outro lado e "o app nao funciona".
 */
export interface ConnectionDiagnosis {
  /** Tipos de candidato ICE que conseguimos reunir: host, srflx, relay. */
  candidateTypes: string[]
  /** Existe TURN na lista que o servidor mandou. */
  turnAvailable: boolean
  /** Ja refizemos a conexao forcando o caminho por TURN. */
  triedRelay: boolean
  /** Passou do tempo de espera sem conectar. */
  timedOut: boolean
}

export interface ViewerState {
  status: ConnectionStatus
  connectionState: RTCPeerConnectionState
  diagnosis: ConnectionDiagnosis
  roomCode: string | null
  /** Tela + som do sistema. */
  stream: MediaStream | null
  /** Voz do host, separada para ter volume proprio. */
  voiceStream: MediaStream | null
  micOn: boolean
  source: SourceInfo | null
  player: PlayerState | null
  film: FilmState | null
  stats: LinkStats | null
  /** Diferenca estimada entre o relogio do host e o nosso (base do Modo Cinema). */
  clockOffsetMs: number
  error: string | null
  /**
   * Preenchido quando o host removeu esta pessoa. E um fim de linha, nao um erro
   * de rede: a interface precisa parar de prometer reconexao.
   */
  removed: 'kicked' | 'blocked' | null
}

export interface ViewerSessionOptions {
  signalingUrl: string
  roomCode: string
  displayName: string
  password?: string
  onState: (state: ViewerState) => void
  onChat?: (text: string, from: string) => void
}

const STATS_INTERVAL_MS = 1000
const REPORT_INTERVAL_MS = 2000
const CLOCK_PING_INTERVAL_MS = 5000

/**
 * Quanto tempo esperar a conexao fechar antes de mudar de estrategia.
 *
 * Doze segundos e generoso para qualquer rede que va funcionar, e curto o
 * bastante para nao virar espera indefinida. O navegador sozinho leva minutos
 * para declarar `failed` — e nesse meio tempo a tela so diz "Conectando...".
 */
const CONNECT_TIMEOUT_MS = 12_000

export class ViewerSession {
  private signaling: SignalingClient
  private pc: RTCPeerConnection | null = null
  private control: RTCDataChannel | null = null
  private statsCollector: StatsCollector | null = null
  private iceServers: IceServer[] = []
  private hostPeerId: string | null = null
  private pendingCandidates: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private clockPingId = 0
  private clockSamples: number[] = []
  private micTrack: MediaStreamTrack | null = null
  private voiceSender: RTCRtpSender | null = null
  private filmReceiver: FilmReceiver | null = null
  private filmUrl: string | null = null
  private lastFilmReport = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private forceRelay = false

  private state: ViewerState = {
    status: 'idle',
    connectionState: 'new',
    diagnosis: {
      candidateTypes: [],
      turnAvailable: false,
      triedRelay: false,
      timedOut: false
    },
    roomCode: null,
    stream: null,
    voiceStream: null,
    micOn: false,
    source: null,
    player: null,
    film: null,
    stats: null,
    clockOffsetMs: 0,
    error: null,
    removed: null
  }

  constructor(private readonly options: ViewerSessionOptions) {
    this.signaling = new SignalingClient(options.signalingUrl)

    this.signaling.on('status', (status) => this.patch({ status }))

    this.signaling.on('welcome', (welcome) => {
      this.iceServers = welcome.iceServers
      const turnAvailable = welcome.iceServers.some((server) =>
        (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
          url.startsWith('turn')
        )
      )
      this.patch({
        roomCode: welcome.roomCode,
        error: null,
        diagnosis: { ...this.state.diagnosis, turnAvailable }
      })

      /**
       * Sem conexao deste lado, PEDE a oferta em vez de esperar.
       *
       * Antes o viewer era totalmente passivo: dependia de o host reparar no
       * `peer-joined` e ofertar. Isso quebrou no momento em que a identidade
       * passou a ser estavel — recarregar a aba devolve o MESMO id de peer, o
       * host reconhece alguem que ele acha que ja esta conectado, e nao oferta
       * nada. A pagina recarregada ficava esperando para sempre.
       *
       * `fresh` e a informacao que so este lado tem: "nao existe conexao aqui".
       */
      const host = welcome.peers.find((peer) => peer.role === 'host')
      if (host && !this.pc) {
        this.hostPeerId = host.id
        this.requestRenegotiate(this.forceRelay, true)
      }
    })

    this.signaling.on('signal', ({ from, payload }) => {
      void this.handleSignal(from, payload)
    })

    this.signaling.on('peer-left', (peerId) => {
      if (peerId !== this.hostPeerId) return

      /**
       * O socket de SINALIZACAO do host caiu — a midia nao passa por ali.
       *
       * Este era o erro que mais doia na pratica: um solucao no tunel derrubava
       * o WebSocket e o app respondia jogando fora uma RTCPeerConnection que
       * continuava entregando video perfeitamente. Quem assistia via a imagem
       * sumir e voltar alguns segundos depois, tendo perdido um pedaco do
       * filme, por um problema que nao tinha nada a ver com o video.
       *
       * Enquanto o par estiver conectado, nao se toca em nada. Se a conexao
       * tambem cair de verdade, o proprio `connectionState` avisa e a
       * recuperacao normal entra em acao.
       */
      if (this.pc?.connectionState === 'connected') {
        console.log('[viewer] host saiu da sinalizacao, mas a midia continua de pe')
        return
      }

      this.teardownPeer()
      this.patch({
        stream: null,
        source: null,
        connectionState: 'disconnected',
        error: 'o host saiu — aguardando ele voltar'
      })
    })

    this.signaling.on('error', ({ code, message }) => {
      if (code === 'kicked' || code === 'blocked') {
        // Fim de linha: derruba a midia para nao ficar imagem congelada na tela.
        this.teardownPeer()
        this.patch({ removed: code, error: message, stream: null, voiceStream: null })
        return
      }
      this.patch({ error: message })
    })
  }

  start(): void {
    this.signaling.joinRoom(
      this.options.roomCode,
      this.options.displayName,
      this.options.password
    )
  }

  stop(): void {
    this.teardownPeer()
    this.releaseFilmUrl()
    this.signaling.close()
  }

  sendChat(text: string): void {
    this.sendControl({ type: 'chat', text, at: Date.now() })
  }

  /**
   * Abre/fecha o microfone para falar com o host.
   *
   * Guardamos o track mesmo se a conexao ainda nao existir: quando a oferta
   * chegar, ele entra sozinho. Assim dar "falar" antes da conexao fechar nao
   * vira um botao que nao faz nada.
   */
  async setMicTrack(track: MediaStreamTrack | null): Promise<void> {
    this.micTrack = track
    if (this.voiceSender) {
      await this.voiceSender.replaceTrack(track).catch(() => undefined)
    }
    this.patch({ micOn: Boolean(track) })
  }

  // -- Modo Cinema -----------------------------------------------------------

  private handleFilmChunk(chunk: ArrayBuffer): void {
    const receiver = this.filmReceiver
    if (!receiver) return

    const progress = receiver.push(chunk)

    // Avisar o host a cada chunk inundaria o canal de controle; uma vez a cada
    // 400 ms ja da uma barra de progresso suave.
    const now = Date.now()
    if (now - this.lastFilmReport > 400) {
      this.lastFilmReport = now
      this.sendControl({
        type: 'film-progress',
        received: receiver.received,
        total: receiver.total
      })
    }

    if (!receiver.complete) {
      this.patch({
        film: {
          name: receiver.name,
          size: receiver.total,
          received: progress.sent,
          bytesPerSecond: progress.bytesPerSecond,
          ready: false,
          url: null
        }
      })
      return
    }

    const blob = receiver.finish()
    this.filmUrl = URL.createObjectURL(blob)
    this.sendControl({
      type: 'film-progress',
      received: receiver.received,
      total: receiver.total
    })
    this.sendControl({ type: 'film-ready' })
    this.patch({
      film: {
        name: receiver.name,
        size: receiver.total,
        received: receiver.received,
        bytesPerSecond: progress.bytesPerSecond,
        ready: true,
        url: this.filmUrl
      }
    })
  }

  private releaseFilmUrl(): void {
    if (this.filmUrl) URL.revokeObjectURL(this.filmUrl)
    this.filmUrl = null
  }

  private findVoiceTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | undefined {
    const transceivers = pc.getTransceivers()
    return transceivers.find((t) => t.mid === MID_VOICE) ?? transceivers[2]
  }

  private sendControl(message: ControlMessage): void {
    if (this.control?.readyState === 'open') {
      this.control.send(JSON.stringify(message))
    }
  }

  // -- negociacao ------------------------------------------------------------

  private async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    if (payload.kind === 'sdp' && payload.type === 'offer') {
      /**
       * Host com id diferente e sinal de sala nova (a antiga expirou). Mas so
       * derruba se a conexao atual ja nao estiver servindo: com identidade
       * estavel no servidor, o host que retoma volta com o MESMO id, e cair
       * aqui significa que algo realmente mudou.
       */
      if (this.hostPeerId && this.hostPeerId !== from) {
        if (this.pc?.connectionState === 'connected') {
          console.warn('[viewer] oferta de um host diferente com a midia de pe; ignorando')
          return
        }
        this.teardownPeer()
      }
      this.hostPeerId = from

      /**
       * Chegou oferta, entao o host esta de volta — o aviso de "o host saiu" tem
       * que sair da tela agora. Sem limpar aqui, a pessoa continuava lendo que o
       * host tinha ido embora enquanto a conexao ja estava restabelecida, e a
       * unica saida aparente era recarregar a pagina.
       */
      this.patch({ error: null, removed: null })

      const pc = this.ensurePeerConnection()
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      this.remoteDescriptionSet = true

      for (const candidate of this.pendingCandidates) {
        await pc.addIceCandidate(candidate).catch(() => undefined)
      }
      this.pendingCandidates = []

      // Quem responde recebe o transceiver de voz como recvonly. Sem forcar
      // sendrecv aqui, nosso microfone jamais chegaria no host — e o sintoma
      // seria "ele nao me ouve" sem nenhum erro em lugar nenhum.
      const voiceTransceiver = this.findVoiceTransceiver(pc)
      if (voiceTransceiver) {
        voiceTransceiver.direction = 'sendrecv'
        this.voiceSender = voiceTransceiver.sender
        if (this.micTrack) {
          await voiceTransceiver.sender.replaceTrack(this.micTrack).catch(() => undefined)
        }
      }

      // A partir daqui o relogio corre: ou a conexao fecha, ou mudamos de
      // estrategia. Nunca mais "Conectando..." indefinidamente.
      this.armConnectTimer()

      const answer = await pc.createAnswer()
      // Anunciar stereo=1 tambem na resposta e o que autoriza o host a enviar
      // audio estereo de verdade. Sem isto, o som chega mono mesmo com o host
      // configurado corretamente.
      const sdp = tuneOpus(answer.sdp ?? '', { stereo: true, useDtx: false })
      await pc.setLocalDescription({ type: 'answer', sdp })
      this.signaling.signal(from, { kind: 'sdp', type: 'answer', sdp })
      return
    }

    if (payload.kind === 'ice') {
      if (!payload.candidate) return
      const candidate = payload.candidate as RTCIceCandidateInit
      if (!this.pc || !this.remoteDescriptionSet) {
        this.pendingCandidates.push(candidate)
        return
      }
      await this.pc.addIceCandidate(candidate).catch(() => undefined)
    }
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
      // Segunda tentativa: ir direto pelo TURN. Em CGNAT o caminho direto nunca
      // fecha, e insistir nele so gasta o tempo de quem esta esperando.
      ...(this.forceRelay ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {})
    })
    this.pc = pc

    const incoming = new MediaStream()
    const voice = new MediaStream()

    pc.ontrack = (event) => {
      // Buffer de reproducao no minimo: queremos tempo real, nao suavidade.
      minimizePlayoutDelay(event.receiver)

      // Duas trilhas de audio chegam nesta conexao: o som do sistema e a voz do
      // host. Sem separar, nao daria para baixar o filme e continuar ouvindo
      // alguem falar. O mid vem da ordem fixa que o host cria (ver MID_* no
      // protocolo); o indice e uma rede de seguranca para quando o mid ainda
      // nao foi associado.
      const index = pc.getTransceivers().indexOf(event.transceiver)
      const isVoice =
        event.transceiver.mid === MID_VOICE ||
        (event.transceiver.mid === null && index === 2)

      if (isVoice) {
        voice.addTrack(event.track)
        this.patch({ voiceStream: voice })
        return
      }

      incoming.addTrack(event.track)
      this.patch({ stream: incoming })
    }

    pc.onicecandidate = (event) => {
      const tipo = event.candidate?.type
      if (tipo && !this.state.diagnosis.candidateTypes.includes(tipo)) {
        this.patch({
          diagnosis: {
            ...this.state.diagnosis,
            candidateTypes: [...this.state.diagnosis.candidateTypes, tipo]
          }
        })
      }
      if (!this.hostPeerId) return
      this.signaling.signal(this.hostPeerId, {
        kind: 'ice',
        candidate: event.candidate ? event.candidate.toJSON() : null
      })
    }

    pc.onconnectionstatechange = () => {
      this.patch({ connectionState: pc.connectionState })

      if (pc.connectionState === 'connected') {
        this.clearConnectTimer()
        this.patch({
          error: null,
          diagnosis: { ...this.state.diagnosis, timedOut: false }
        })
        return
      }

      // `failed` e o unico estado em que o navegador ja desistiu de verdade;
      // `disconnected` costuma se resolver sozinho em poucos segundos.
      if (pc.connectionState === 'failed') this.escalate()
    }

    pc.ondatachannel = (event) => {
      if (event.channel.label === CONTROL_CHANNEL_LABEL) {
        this.control = event.channel
        this.control.onmessage = (msg) => this.handleControl(String(msg.data))
        this.control.onopen = () => this.startReporting()
        this.control.onclose = () => this.stopReporting()
        return
      }

      if (event.channel.label === FILM_CHANNEL_LABEL) {
        const channel = event.channel
        channel.binaryType = 'arraybuffer'
        channel.onmessage = (msg) => this.handleFilmChunk(msg.data as ArrayBuffer)
      }
    }

    this.statsCollector = new StatsCollector(pc, 'recv')
    this.statsCollector.start(STATS_INTERVAL_MS, (stats) => this.patch({ stats }))

    return pc
  }

  // -- recuperacao de conexao ------------------------------------------------

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  /** Rearma o relogio de paciencia a cada oferta nova. */
  private armConnectTimer(): void {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (this.pc?.connectionState === 'connected') return
      this.patch({ diagnosis: { ...this.state.diagnosis, timedOut: true } })
      this.escalate()
    }, CONNECT_TIMEOUT_MS)
  }

  /**
   * A conexao nao fechou. Uma tentativa a mais, pelo caminho que costuma
   * funcionar em 4G — e depois disso, dizer o que aconteceu em vez de ficar
   * prometendo "Conectando...".
   */
  private escalate(): void {
    this.clearConnectTimer()

    const { turnAvailable, triedRelay } = this.state.diagnosis

    if (turnAvailable && !triedRelay) {
      this.forceRelay = true
      this.teardownPeer(true)
      // Conexao descartada: o que vem a seguir precisa ser construido do zero.
      // `timedOut` volta a false: ainda estamos TENTANDO, e a tela nao deve
      // anunciar derrota enquanto ha uma estrategia em andamento.
      this.patch({
        diagnosis: {
          ...this.state.diagnosis,
          triedRelay: true,
          timedOut: false,
          candidateTypes: []
        },
        error: 'conexao direta nao fechou — tentando pelo servidor de retransmissao'
      })
      // A oferta e sempre do host; so ele pode reiniciar o ICE.
      this.requestRenegotiate(true, true)
      return
    }

    this.patch({
      error: turnAvailable
        ? 'nao foi possivel conectar, nem direto nem pelo servidor de retransmissao'
        : 'sua rede exige um servidor de retransmissao (TURN) e ele nao esta configurado'
    })
  }

  private requestRenegotiate(relay: boolean, fresh = false): void {
    if (!this.hostPeerId) return
    this.signaling.signal(this.hostPeerId, { kind: 'renegotiate', relay, fresh })
  }

  /** Nova tentativa a pedido de quem esta assistindo (botao na tela). */
  retry(): void {
    this.forceRelay = this.state.diagnosis.turnAvailable
    this.teardownPeer(true)
    this.patch({
      error: null,
      diagnosis: { ...this.state.diagnosis, timedOut: false, candidateTypes: [] }
    })
    // Sem host conhecido ainda, reentrar na sala e o unico caminho.
    if (this.hostPeerId) this.requestRenegotiate(this.forceRelay, true)
    else this.start()
  }

  /**
   * `keepHost` existe para o caso de reconstruir a conexao com o MESMO host —
   * ao escalar para TURN, por exemplo. Esquecer quem era o host ali significaria
   * nao ter para quem pedir a oferta nova, e a recuperacao morreria calada.
   */
  private teardownPeer(keepHost = false): void {
    this.clearConnectTimer()
    this.stopReporting()
    this.statsCollector?.stop()
    this.statsCollector = null
    this.control?.close()
    this.control = null
    this.voiceSender = null
    this.pc?.close()
    this.pc = null
    this.remoteDescriptionSet = false
    this.pendingCandidates = []
    if (!keepHost) this.hostPeerId = null
  }

  // -- canal de controle -----------------------------------------------------

  private handleControl(raw: string): void {
    const message = parseControlMessage(raw)
    if (!message) return

    switch (message.type) {
      case 'source-state':
        this.patch({
          source: {
            kind: message.kind,
            title: message.title,
            hasAudio: message.hasAudio,
            preset: message.preset
          }
        })
        return
      case 'player-state':
        this.patch({
          player: {
            state: message.state,
            positionSec: message.positionSec,
            durationSec: message.durationSec,
            hostTimeMs: message.hostTimeMs
          }
        })
        return
      case 'clock-pong': {
        // Offset estilo NTP: (t1 - t0) - rtt/2.
        const now = Date.now()
        const rtt = now - message.t0
        const offset = message.t1 - message.t0 - rtt / 2
        this.clockSamples.push(offset)
        if (this.clockSamples.length > 9) this.clockSamples.shift()
        // Mediana descarta os pings que pegaram um pico de rede.
        const sorted = [...this.clockSamples].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0
        this.patch({ clockOffsetMs: Math.round(median) })
        return
      }
      case 'chat':
        this.options.onChat?.(message.text, message.from ?? 'host')
        return

      case 'film-offer': {
        // Recomecar do zero se a oferta mudou; aceitar duas vezes o mesmo filme
        // duplicaria os bytes recebidos e corromperia o arquivo montado.
        if (this.filmReceiver?.name === message.name) return
        this.releaseFilmUrl()
        this.filmReceiver = new FilmReceiver(message.name, message.size, message.mimeType)
        this.patch({
          film: {
            name: message.name,
            size: message.size,
            received: 0,
            bytesPerSecond: 0,
            ready: false,
            url: null
          }
        })
        this.sendControl({ type: 'film-accept' })
        return
      }

      case 'film-cancel':
        this.filmReceiver = null
        this.releaseFilmUrl()
        this.patch({ film: null })
        return
      default:
        return
    }
  }

  private startReporting(): void {
    this.stopReporting()

    // Devolver ao host o que estamos REALMENTE recebendo e o que torna o HUD
    // dele util: ele passa a ver o gargalo do outro lado, nao so o proprio.
    this.reportTimer = setInterval(() => {
      const stats = this.state.stats
      if (!stats) return
      this.sendControl({
        type: 'viewer-stats',
        fps: Math.round(stats.video.fps),
        width: stats.video.width,
        height: stats.video.height,
        kbps: stats.video.kbps + stats.audio.kbps,
        packetsLostPct: stats.network.packetsLostPct,
        jitterMs: Math.round(stats.network.jitterMs),
        freezeCount: stats.video.freezeCount
      })
    }, REPORT_INTERVAL_MS)

    this.clockTimer = setInterval(() => {
      this.sendControl({ type: 'clock-ping', id: ++this.clockPingId, t0: Date.now() })
    }, CLOCK_PING_INTERVAL_MS)
  }

  private stopReporting(): void {
    if (this.reportTimer) clearInterval(this.reportTimer)
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.reportTimer = null
    this.clockTimer = null
  }

  private patch(partial: Partial<ViewerState>): void {
    this.state = { ...this.state, ...partial }
    this.options.onState(this.state)
  }
}
