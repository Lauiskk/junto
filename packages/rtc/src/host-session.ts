import type {
  ControlMessage,
  IceServer,
  Peer,
  SignalPayload,
  SourceKind
} from '@junto/protocol'
import {
  CONTROL_CHANNEL_LABEL,
  FILM_CHANNEL_LABEL,
  parseControlMessage
} from '@junto/protocol'
import { FilmSender } from './film-transfer.js'
import { getPreset, type QualityPreset } from './presets.js'
import { tuneOpus, tuneVideoBitrate } from './sdp.js'
import {
  applyAudioBitrate,
  applyContentHint,
  applyPresetToSender,
  applyQualityDecision,
  preferCodecs
} from './sender-tuning.js'
import { MIN_VIDEO_KBPS, QualityGovernor, type QualityDecision } from './bitrate-budget.js'
import { SignalingClient, type ConnectionStatus } from './signaling-client.js'
import { StatsCollector, type LinkStats } from './stats.js'
import type {
  Broadcaster,
  ViewerConnection,
  ViewerFilmProgress,
  ViewerReport
} from './transport.js'

/**
 * Sessao do HOST: uma RTCPeerConnection por espectador (malha P2P).
 *
 * Decisao chave: os transceivers de video e audio sao criados na hora em que o
 * espectador entra, mesmo que a captura ainda nao tenha comecado, e o track e
 * injetado depois com replaceTrack(). Isso evita renegociar SDP a cada
 * start/stop de transmissao — que e a origem classica de tela preta e de
 * travadas de 2 segundos ao trocar de fonte.
 */

/**
 * Quanto da internet o app esta autorizado a usar.
 *
 * `auto` e o comportamento historico: obedecer a estimativa do navegador. Ela e
 * conservadora por projeto — foi feita para videochamada dividir a rede com o
 * resto da casa — e quem transmite um filme quer o oposto disso. Os outros dois
 * modos existem para dizer explicitamente "pode pegar".
 */
export type UploadMode = 'auto' | 'manual' | 'max'

export interface UploadSetting {
  mode: UploadMode
  /** So vale no modo `manual`. */
  mbps: number
}

export interface HostState {
  status: ConnectionStatus
  roomCode: string | null
  selfId: string | null
  viewers: ViewerConnection[]
  /** Codec de video efetivamente negociado (para o HUD). */
  codec: string | null
  streaming: boolean
  micOn: boolean
  error: string | null
  upload: UploadSetting
  /** Capacidade total estimada do upload (kbps); 0 enquanto nao ha medida. */
  uploadMeasuredKbps: number
  /** Preenchido quando a trava de perda desligou o piso de bitrate. */
  uploadWarning: string | null
}

export interface HostSessionOptions {
  signalingUrl: string
  displayName: string
  password?: string
  presetId?: string
  onState: (state: HostState) => void
  onChat?: (from: string, text: string) => void
}

/** O que esta sendo transmitido — tela, janela ou arquivo local. */
export interface StreamSource {
  kind: SourceKind
  title: string
}

interface ViewerPeer {
  peerId: string
  name: string
  pc: RTCPeerConnection
  videoSender: RTCRtpSender
  audioSender: RTCRtpSender
  voiceSender: RTCRtpSender
  videoTransceiver: RTCRtpTransceiver
  /** Voz recebida deste espectador (null enquanto ele nao abre o microfone). */
  voice: MediaStream | null
  control: RTCDataChannel | null
  filmChannel: RTCDataChannel | null
  filmSender: FilmSender | null
  filmProgress: ViewerFilmProgress | null
  stats: StatsCollector
  lastStats: LinkStats | null
  reported: ViewerReport | null
  pendingCandidates: RTCIceCandidateInit[]
  remoteDescriptionSet: boolean
  negotiating: boolean
  /** Desde quando a conexao esta caida; null quando esta de pe. */
  disconnectedSince: number | null
  /** Quando a oferta saiu; base do watchdog de quem nunca chega a conectar. */
  offeredAt: number
  /** Ja tentamos ICE restart para esta tentativa de conexao? */
  restarted: boolean
  /** Desde quando a perda de video esta alta; null quando esta saudavel. */
  lossHighSince: number | null
  /** Desde quando a perda esta baixa — base para religar o piso. */
  lossHealthySince: number | null
  /** A trava de perda desligou o piso de bitrate para este espectador. */
  floorDisabled: boolean
  /** Decide resolucao e bitrate a partir da banda medida desta conexao. */
  governor: QualityGovernor
}

const STATS_INTERVAL_MS = 1000
/** Depois disso o ICE restart ja teve chances de sobra; e desistencia mesmo. */
const STALE_VIEWER_MS = 30_000
const SWEEP_INTERVAL_MS = 10_000
/**
 * Quem nunca conectou nao passa por `failed` — fica parado em `checking` ate o
 * navegador desistir sozinho, o que pode levar minutos. Do outro lado isso e o
 * "Conectando..." infinito que apareceu no iPhone. Aqui o host toma a
 * iniciativa: passou disto sem conectar, refaz o ICE.
 */
const NEVER_CONNECTED_MS = 15_000
/** Perda acima disto, sustentada, significa que o piso esta machucando. */
const LOSS_CEILING_PCT = 10
const LOSS_GRACE_MS = 10_000
/** Abaixo disto, por tempo suficiente, a rede voltou e o piso pode voltar junto. */
const LOSS_HEALTHY_PCT = 2
const LOSS_RECOVERY_MS = 60_000

export class HostSession implements Broadcaster {
  readonly kind = 'p2p' as const

  private signaling: SignalingClient
  private viewers = new Map<string, ViewerPeer>()
  private iceServers: IceServer[] = []
  private stream: MediaStream | null = null
  private micTrack: MediaStreamTrack | null = null
  private sourceInfo: StreamSource | null = null
  private filmFile: File | null = null
  private filmDurationSec: number | null = null
  private preset: QualityPreset
  private codec: string | null = null
  private roomCode: string | null = null
  private selfId: string | null = null
  private status: ConnectionStatus = 'idle'
  private error: string | null = null
  private disposed = false
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private upload: UploadSetting = { mode: 'auto', mbps: 0 }
  private uploadPeakKbps = 0
  private uploadWarning: string | null = null

  constructor(private readonly options: HostSessionOptions) {
    this.preset = getPreset(options.presetId)
    this.signaling = new SignalingClient(options.signalingUrl)

    this.signaling.on('status', (status) => {
      this.status = status
      this.publish()
    })

    this.signaling.on('welcome', (welcome) => {
      this.iceServers = welcome.iceServers

      /**
       * Sala diferente da anterior significa que a antiga expirou e ganhamos uma
       * nova. As conexoes antigas pertencem a uma sala que nao existe mais: sem
       * derrubar aqui, elas ficariam na lista para sempre como "desconectado" —
       * foi o que aconteceu com o espectador fantasma no primeiro teste real.
       */
      if (this.roomCode && this.roomCode !== welcome.roomCode) {
        for (const viewer of this.viewers.values()) this.teardownViewer(viewer)
        this.viewers.clear()
      }

      this.roomCode = welcome.roomCode
      this.selfId = welcome.selfId
      this.error = null
      /**
       * Reencontro com quem ja estava na sala.
       *
       * Com identidade estavel no servidor, quem volta volta com o MESMO id —
       * entao `connectToViewer` reconhece a pessoa e nao reconstroi nada se a
       * midia dela continua de pe. Quem realmente perdeu a conexao ganha uma
       * negociacao nova.
       */
      for (const peer of welcome.peers) {
        if (peer.role === 'viewer') void this.connectToViewer(peer)
      }
      this.publish()
    })

    this.signaling.on('peer-joined', (peer) => {
      if (peer.role === 'viewer') void this.connectToViewer(peer)
    })

    this.signaling.on('peer-left', (peerId) => {
      const viewer = this.viewers.get(peerId)
      /**
       * Igual ao lado de quem assiste: o socket de sinalizacao caiu, a midia
       * nao. Derrubar a RTCPeerConnection aqui e o que fazia a imagem do outro
       * lado piscar quando o tunel reconectava.
       *
       * Se a pessoa realmente fechou a aba, a conexao cai sozinha em poucos
       * segundos e o `sweepStaleViewers` limpa. Esperar por isso custa um card
       * a mais na lista por meio minuto; nao esperar custa a transmissao.
       */
      if (viewer && viewer.pc.connectionState === 'connected') {
        console.log(`[host] ${viewer.name} saiu da sinalizacao, mas a midia continua`)
        // De proposito NAO marca `disconnectedSince`: quem marca isso e o
        // estado real da conexao. Marcar aqui faria o `sweepStaleViewers`
        // derrubar, 30 s depois, alguem que esta assistindo sem problema nenhum.
        return
      }
      this.dropViewer(peerId)
    })

    this.signaling.on('signal', ({ from, payload }) => {
      void this.handleSignal(from, payload)
    })

    this.signaling.on('error', ({ message }) => {
      this.error = message
      this.publish()
    })
  }

  start(): void {
    this.signaling.createRoom(this.options.displayName, this.options.password)
    this.sweepTimer = setInterval(() => this.sweepStaleViewers(), SWEEP_INTERVAL_MS)
  }

  /**
   * Remove quem ficou caido tempo demais.
   *
   * Sem isto, um espectador que fecha o notebook no meio da sessao fica na lista
   * para sempre — e, pior, continua contando no orcamento de banda, roubando
   * qualidade de quem realmente esta assistindo.
   */
  private sweepStaleViewers(): void {
    const agora = Date.now()
    for (const viewer of [...this.viewers.values()]) {
      if (viewer.disconnectedSince && agora - viewer.disconnectedSince > STALE_VIEWER_MS) {
        console.warn(`[host] removendo ${viewer.name}: caido ha mais de 30s`)
        this.dropViewer(viewer.peerId)
        continue
      }

      /**
       * Quem nunca conectou e um caso diferente de quem caiu, e antes ele nao
       * era tratado: a conexao fica em `checking` indefinidamente, sem passar
       * por `failed`, entao nem o restart nem a limpeza aconteciam. Do lado de
       * quem assiste isso e o "Conectando..." eterno. Uma tentativa de ICE
       * restart resolve a maioria dos casos de NAT teimoso.
       */
      const estado = viewer.pc.connectionState
      const conectando = estado === 'new' || estado === 'connecting'
      if (conectando && !viewer.restarted && agora - viewer.offeredAt > NEVER_CONNECTED_MS) {
        viewer.restarted = true
        console.warn(`[host] ${viewer.name} nao conectou em 15s; refazendo o ICE`)
        void this.negotiate(viewer, true)
      }
    }
  }

  stop(): void {
    this.disposed = true
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    for (const viewer of this.viewers.values()) this.teardownViewer(viewer)
    this.viewers.clear()
    this.signaling.close()
    this.publish()
  }

  // -- midia -----------------------------------------------------------------

  async setStream(stream: MediaStream | null, info?: StreamSource): Promise<void> {
    this.stream = stream

    const videoTrack = stream?.getVideoTracks()[0] ?? null
    const audioTrack = stream?.getAudioTracks()[0] ?? null

    if (videoTrack) applyContentHint(videoTrack, this.preset)

    // info tambem vale com stream nulo: no Modo Cinema paramos de enviar pixels,
    // mas quem assiste continua precisando saber QUAL filme esta rolando.
    this.sourceInfo =
      info ?? (stream ? { kind: 'screen', title: videoTrack?.label ?? 'tela' } : null)

    await Promise.all(
      [...this.viewers.values()].map((viewer) =>
        this.attachTracks(viewer, videoTrack, audioTrack)
      )
    )

    this.broadcastControl(this.sourceStateMessage())
    this.publish()
  }

  /**
   * Estado do player do arquivo local, replicado para quem assiste.
   *
   * No modo simples os pixels ja carregam a imagem do filme, entao isto e
   * informativo: mostra posicao e se esta pausado. O mesmo formato de mensagem
   * vira a base do Modo Cinema, onde cada um decodifica o proprio arquivo e a
   * posicao passa a ser o que de fato sincroniza a sessao.
   */
  broadcastPlayerState(
    state: 'playing' | 'paused' | 'ended',
    positionSec: number,
    durationSec: number | null
  ): void {
    this.broadcastControl({
      type: 'player-state',
      state,
      positionSec,
      durationSec,
      hostTimeMs: Date.now()
    })
  }

  /**
   * Liga/desliga o microfone para todos os espectadores de uma vez.
   *
   * Vai numa trilha SEPARADA do som do sistema, e nao misturada, por dois
   * motivos: o cancelamento de eco precisa estar ligado na voz e desligado na
   * musica, e assim quem assiste ganha controle de volume independente — baixar
   * o filme para ouvir alguem falando.
   */
  async setMicTrack(track: MediaStreamTrack | null): Promise<void> {
    this.micTrack = track
    await Promise.all(
      [...this.viewers.values()].map((viewer) =>
        viewer.voiceSender.replaceTrack(track).catch(() => undefined)
      )
    )
    this.publish()
  }

  // -- Modo Cinema -----------------------------------------------------------

  /**
   * Oferece o arquivo original para todos. Cada viewer aceita, baixa e passa a
   * reproduzir localmente — a partir dai so a posicao do player trafega.
   */
  startFilm(file: File, durationSec: number | null): void {
    this.filmFile = file
    this.filmDurationSec = durationSec
    const offer = this.filmOfferMessage()
    if (offer) this.broadcastControl(offer)
    this.publish()
  }

  stopFilm(reason?: string): void {
    this.filmFile = null
    this.filmDurationSec = null
    for (const viewer of this.viewers.values()) {
      viewer.filmSender?.cancel()
      viewer.filmSender = null
      viewer.filmProgress = null
    }
    this.broadcastControl({ type: 'film-cancel', reason })
    this.publish()
  }

  private filmOfferMessage(): ControlMessage | null {
    if (!this.filmFile) return null
    return {
      type: 'film-offer',
      name: this.filmFile.name,
      size: this.filmFile.size,
      // Alguns arquivos chegam sem type definido pelo sistema; o palpite pelo
      // menos deixa o <video> tentar em vez de recusar de cara.
      mimeType: this.filmFile.type || 'video/mp4',
      durationSec: this.filmDurationSec
    }
  }

  private async sendFilmTo(viewer: ViewerPeer): Promise<void> {
    const file = this.filmFile
    const channel = viewer.filmChannel
    if (!file || !channel || viewer.filmSender) return
    if (channel.readyState !== 'open') return

    const sender = new FilmSender(channel, file)
    viewer.filmSender = sender
    viewer.filmProgress = { sent: 0, total: file.size, bytesPerSecond: 0, ready: false }

    try {
      await sender.send((progress) => {
        viewer.filmProgress = {
          sent: progress.sent,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
          ready: viewer.filmProgress?.ready ?? false
        }
        this.publish()
      })
    } catch (err) {
      console.warn('[host] envio do filme falhou:', err)
    }
  }

  /**
   * Tira alguem da sala.
   *
   * `block: false` derruba a conexao mas deixa a pessoa voltar pelo mesmo link —
   * e a forma de destravar quem ficou com a conexao emperrada. `block: true`
   * impede o retorno.
   */
  kickViewer(peerId: string, block: boolean): void {
    this.signaling.kick(peerId, block)
    // Nao espera o servidor: a conexao local com essa pessoa nao serve mais.
    this.dropViewer(peerId)
  }

  sendChat(text: string): void {
    this.broadcastControl({
      type: 'chat',
      text,
      at: Date.now(),
      from: this.options.displayName
    })
  }

  private sourceStateMessage(): ControlMessage {
    return {
      type: 'source-state',
      kind: this.sourceInfo?.kind ?? 'none',
      title: this.sourceInfo?.title ?? 'sem fonte',
      hasAudio: Boolean(this.stream?.getAudioTracks().length),
      preset: this.preset.id
    }
  }

  async setPreset(preset: QualityPreset): Promise<void> {
    this.preset = preset
    const videoTrack = this.stream?.getVideoTracks()[0] ?? null
    if (videoTrack) applyContentHint(videoTrack, preset)

    await Promise.all(
      [...this.viewers.values()].flatMap((viewer) => {
        // Zerar o governor faz a proxima amostra reavaliar na hora, sem esperar
        // a histerese — trocar de preset e um pedido explicito do usuario.
        viewer.governor = new QualityGovernor()
        return [
          applyPresetToSender(viewer.videoSender, preset),
          applyPresetToSender(viewer.audioSender, preset)
        ]
      })
    )
    // O preset aparece no HUD de quem assiste; sem reenviar, ficaria desatualizado.
    this.broadcastControl(this.sourceStateMessage())
    this.publish()
  }

  broadcastControl(message: ControlMessage): void {
    const payload = JSON.stringify(message)
    for (const viewer of this.viewers.values()) {
      if (viewer.control?.readyState === 'open') viewer.control.send(payload)
    }
  }

  // -- conexao por espectador ------------------------------------------------

  private async connectToViewer(peer: Peer): Promise<void> {
    if (this.disposed) return

    /**
     * Ja conhecemos esta pessoa?
     *
     * Se a midia dela continua conectada, nao ha nada a fazer — refazer a
     * conexao seria justamente a "piscada" que o solucao no tunel provocava. Se
     * a conexao morreu de verdade, a antiga nao serve e vai fora antes de
     * construir a nova.
     */
    const existente = this.viewers.get(peer.id)
    if (existente) {
      const estado = existente.pc.connectionState
      if (estado !== 'failed' && estado !== 'closed') return
      console.warn(`[host] reconstruindo a conexao com ${peer.name} (estava ${estado})`)
      this.teardownViewer(existente)
      this.viewers.delete(peer.id)
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })

    // Ordem fixa (ver MID_* no protocolo): video, som do sistema, voz.
    // Criados vazios e preenchidos com replaceTrack — nunca renegociamos.
    const videoTransceiver = pc.addTransceiver('video', { direction: 'sendonly' })
    const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendonly' })
    // sendrecv: a mesma m-line leva a minha voz e traz a voz do espectador.
    const voiceTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })

    this.codec = preferCodecs(videoTransceiver, this.preset.preferredCodecs)

    // Voz de quem esta assistindo, para eu ouvir aqui.
    pc.ontrack = (event) => {
      if (event.transceiver !== voiceTransceiver) return
      const existing = this.viewers.get(peer.id)
      if (!existing) return
      existing.voice = new MediaStream([event.track])
      this.publish()
    }

    const control = pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true })
    // Canal separado para os bytes do filme: assim uma transferencia de gigabytes
    // nao atrasa uma mensagem de pause, que precisa chegar na hora.
    const filmChannel = pc.createDataChannel(FILM_CHANNEL_LABEL, { ordered: true })
    filmChannel.binaryType = 'arraybuffer'

    const viewer: ViewerPeer = {
      peerId: peer.id,
      name: peer.name,
      pc,
      videoSender: videoTransceiver.sender,
      audioSender: audioTransceiver.sender,
      voiceSender: voiceTransceiver.sender,
      videoTransceiver,
      voice: null,
      control,
      filmChannel,
      filmSender: null,
      filmProgress: null,
      stats: new StatsCollector(pc, 'send'),
      lastStats: null,
      reported: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      negotiating: false,
      disconnectedSince: null,
      offeredAt: Date.now(),
      restarted: false,
      lossHighSince: null,
      lossHealthySince: null,
      floorDisabled: false,
      governor: new QualityGovernor()
    }
    this.viewers.set(peer.id, viewer)

    control.onopen = () => {
      this.publish()
      // Quem entra no meio da sessao precisa saber o que ja esta rolando.
      control.send(JSON.stringify(this.sourceStateMessage()))
      // Inclusive que existe um filme para baixar — senao quem chegou atrasado
      // ficaria olhando uma tela parada sem entender que falta o arquivo.
      const offer = this.filmOfferMessage()
      if (offer) control.send(JSON.stringify(offer))
    }
    control.onclose = () => this.publish()
    control.onmessage = (event) => this.handleControl(viewer, String(event.data))

    pc.onicecandidate = (event) => {
      this.signaling.signal(peer.id, {
        kind: 'ice',
        candidate: event.candidate ? event.candidate.toJSON() : null
      })
    }

    pc.onconnectionstatechange = () => {
      const caiu =
        pc.connectionState === 'failed' || pc.connectionState === 'disconnected'
      viewer.disconnectedSince = caiu ? (viewer.disconnectedSince ?? Date.now()) : null
      if (pc.connectionState === 'connected') {
        viewer.restarted = false
        viewer.offeredAt = Date.now()
      }

      this.publish()
      if (pc.connectionState === 'failed') void this.restartIce(viewer)
    }

    viewer.stats.start(STATS_INTERVAL_MS, (stats) => {
      viewer.lastStats = stats
      void this.governQuality(viewer, stats)
      this.publish()
    })

    const videoTrack = this.stream?.getVideoTracks()[0] ?? null
    const audioTrack = this.stream?.getAudioTracks()[0] ?? null
    await this.attachTracks(viewer, videoTrack, audioTrack)
    if (this.micTrack) await viewer.voiceSender.replaceTrack(this.micTrack)

    await this.negotiate(viewer, false)
    this.publish()
  }

  private async attachTracks(
    viewer: ViewerPeer,
    videoTrack: MediaStreamTrack | null,
    audioTrack: MediaStreamTrack | null
  ): Promise<void> {
    try {
      await viewer.videoSender.replaceTrack(videoTrack)
      await viewer.audioSender.replaceTrack(audioTrack)
      if (videoTrack) {
        await applyPresetToSender(viewer.videoSender, this.preset)
        // Fonte nova: a decisao anterior nao vale mais (a resolucao mudou).
        viewer.governor = new QualityGovernor()
      }
      if (audioTrack) await applyPresetToSender(viewer.audioSender, this.preset)

      /**
       * Confere se a troca REALMENTE pegou.
       *
       * replaceTrack() pode falhar silenciosamente em alguns estados da conexao,
       * e o sintoma e cruel: quem assiste fica congelado no ultimo quadro da
       * fonte antiga, sem erro em lugar nenhum. Renegociar e a saida — custa uma
       * troca de SDP, mas e infinitamente melhor que uma imagem travada.
       */
      if (videoTrack && viewer.videoSender.track !== videoTrack) {
        console.warn('[host] a troca de trilha nao pegou; renegociando')
        await this.negotiate(viewer, false)
      }
    } catch (err) {
      console.warn('[host] replaceTrack falhou; renegociando:', err)
      await this.negotiate(viewer, false)
    }
  }

  // -- orcamento de upload ---------------------------------------------------

  /**
   * Quanto de upload o app pode usar no total, em kbps. 0 = sem teto proprio
   * (obedece so a estimativa do navegador, conexao por conexao).
   */
  private uploadBudgetKbps(): number {
    if (this.upload.mode === 'manual') return Math.max(0, this.upload.mbps) * 1000
    if (this.upload.mode === 'max') return this.uploadPeakKbps
    return 0
  }

  /** Espectadores que efetivamente disputam o upload agora. */
  private activeViewerCount(): number {
    let ativos = 0
    for (const viewer of this.viewers.values()) {
      const estado = viewer.pc.connectionState
      if (estado !== 'failed' && estado !== 'closed') ativos += 1
    }
    return Math.max(1, ativos)
  }

  /**
   * A capacidade total e a SOMA do que cada conexao consegue estimar.
   *
   * Cada RTCPeerConnection so enxerga a propria fatia, entao nenhuma delas
   * sozinha sabe o tamanho do cano. Guardamos o pico porque a estimativa cai
   * durante um congestionamento momentaneo e voltar a subir leva dezenas de
   * segundos — usar o valor instantaneo faria o modo "usar toda a internet"
   * encolher exatamente quando ele deveria segurar.
   */
  private updateUploadPeak(): void {
    let soma = 0
    for (const viewer of this.viewers.values()) {
      soma += viewer.lastStats?.network.availableOutgoingKbps ?? 0
    }
    if (soma > this.uploadPeakKbps) this.uploadPeakKbps = soma
  }

  /**
   * Trava de seguranca do piso de bitrate.
   *
   * Forcar um piso acima da capacidade real nao entrega mais imagem: entrega
   * mais perda, e perda vira congelamento. Se a perda de VIDEO ficar alta por
   * tempo suficiente, o piso sai — e o painel diz que saiu, porque um botao que
   * silenciosamente nao faz o que promete e pior que nao ter o botao.
   */
  private updateLossGuard(viewer: ViewerPeer, stats: LinkStats): void {
    const agora = Date.now()
    const perdaAlta = stats.network.packetsLostPct > LOSS_CEILING_PCT

    if (!perdaAlta) {
      viewer.lossHighSince = null

      /**
       * A rede melhorou de verdade? Entao devolve o piso.
       *
       * Sem esta volta, quem ligou "usar toda a minha internet" ficava com o
       * botao ligado e sem efeito para sempre depois do primeiro solavanco — e o
       * aviso na tela continuava acusando um problema que ja tinha passado. A
       * espera aqui e longa de proposito (um minuto contra dez segundos para
       * desligar): religar cedo demais so recria o congestionamento.
       */
      if (viewer.floorDisabled && stats.network.packetsLostPct < LOSS_HEALTHY_PCT) {
        viewer.lossHealthySince ??= agora
        if (agora - viewer.lossHealthySince > LOSS_RECOVERY_MS) {
          viewer.floorDisabled = false
          viewer.lossHealthySince = null
          this.uploadWarning = null
          console.log(`[host] rede estavel com ${viewer.name}; piso de bitrate de volta`)
          void this.negotiate(viewer, false)
        }
      }
      return
    }

    viewer.lossHealthySince = null
    viewer.lossHighSince ??= agora
    if (viewer.floorDisabled) return
    if (agora - viewer.lossHighSince < LOSS_GRACE_MS) return

    viewer.floorDisabled = true
    this.uploadWarning = `A perda de pacotes passou de ${LOSS_CEILING_PCT}% com ${viewer.name}: o piso de bitrate foi desligado e a adaptacao voltou ao automatico.`
    console.warn(`[host] trava de perda desligou o piso para ${viewer.name}`)
    // O piso mora no SDP; tirar de verdade exige uma oferta nova.
    void this.negotiate(viewer, false)
  }

  /**
   * A cada amostra de estatisticas, reavalia quanto vai para o audio e qual
   * resolucao cabe no que sobra.
   *
   * E o unico lugar que mexe em bitrate — de video E de audio. Ter um dono so
   * evita que preset e adaptacao se sobrescrevam, e foi a falta desse dono no
   * audio que deixou 3 kbps para o video num link de 100 kbps.
   */
  private async governQuality(viewer: ViewerPeer, stats: LinkStats): Promise<void> {
    const track = viewer.videoSender.track
    if (!track) return

    this.updateUploadPeak()
    this.updateLossGuard(viewer, stats)

    const orcamento = this.uploadBudgetKbps()
    const fatia = orcamento > 0 ? Math.round(orcamento / this.activeViewerCount()) : 0
    // O piso e uma fracao da fatia: empurrar ate o teto absoluto nao deixaria
    // folga nenhuma para os picos de bitrate de um corte de cena.
    const piso = viewer.floorDisabled || fatia <= 0 ? 0 : Math.round(fatia * 0.8)

    const decision = viewer.governor.update({
      availableKbps: stats.network.availableOutgoingKbps,
      sendingKbps: stats.video.kbps,
      sendingAudioKbps: stats.audio.kbps,
      limitation: stats.video.limitation,
      sourceWidth: track.getSettings().width ?? 0,
      sourceHeight: track.getSettings().height ?? 0,
      presetMaxHeight: this.preset.maxHeight,
      presetMaxKbps: this.preset.maxBitrateKbps,
      presetAudioKbps: this.preset.audioBitrateKbps,
      floorKbps: piso,
      capKbps: fatia
    })

    if (!decision) return
    await applyQualityDecision(viewer.videoSender, decision)
    // O audio compete pelo MESMO orcamento, entao apertar um sem o outro nao
    // resolve nada: e a trilha de som que chega primeiro na fila do WebRTC.
    await applyAudioBitrate(viewer.audioSender, decision.audioKbps)
    this.publish()
  }

  /**
   * Define quanto da internet o app pode usar.
   *
   * Zerar os governors e proposital: e um pedido explicito do usuario, e esperar
   * a histerese de 15 s para ele ver efeito faria o botao parecer quebrado.
   */
  async setUploadSetting(setting: UploadSetting): Promise<void> {
    this.upload = setting
    this.uploadWarning = null
    for (const viewer of this.viewers.values()) {
      viewer.governor = new QualityGovernor()
      viewer.floorDisabled = false
      viewer.lossHighSince = null
      viewer.lossHealthySince = null
    }
    // O start/min-bitrate vive no SDP, entao mudar de modo exige renegociar.
    await Promise.all(
      [...this.viewers.values()].map((viewer) => this.negotiate(viewer, false))
    )
    this.publish()
  }

  private async negotiate(viewer: ViewerPeer, iceRestart: boolean): Promise<void> {
    if (viewer.negotiating) return
    viewer.negotiating = true
    try {
      const offer = await viewer.pc.createOffer({ iceRestart })
      // Unico ajuste que so existe via SDP: Opus estereo com bitrate de verdade.
      let sdp = tuneOpus(offer.sdp ?? '', {
        stereo: true,
        maxAverageBitrate: this.preset.audioBitrateKbps * 1000,
        useInbandFec: true,
        useDtx: false
      })

      /**
       * Modo "pode pegar da internet": arranca alto em vez de subir em rampa
       * de 30 s, e nao deixa a estimativa estrangular o encoder. So entra
       * quando o usuario pediu — e sai quando a trava de perda desliga o piso.
       */
      const orcamento = this.uploadBudgetKbps()
      const fatia = orcamento > 0 ? Math.round(orcamento / this.activeViewerCount()) : 0
      if (fatia > 0) {
        const teto = Math.min(fatia, this.preset.maxBitrateKbps)
        sdp = tuneVideoBitrate(sdp, {
          startKbps: Math.max(MIN_VIDEO_KBPS, Math.round(teto * 0.6)),
          minKbps: viewer.floorDisabled
            ? undefined
            : Math.max(MIN_VIDEO_KBPS, Math.round(teto * 0.25)),
          maxKbps: teto
        })
      }

      await viewer.pc.setLocalDescription({ type: 'offer', sdp })
      viewer.offeredAt = Date.now()
      this.signaling.signal(viewer.peerId, { kind: 'sdp', type: 'offer', sdp })
    } catch (err) {
      console.warn('[host] negociacao falhou:', err)
    } finally {
      viewer.negotiating = false
    }
  }

  private async restartIce(viewer: ViewerPeer): Promise<void> {
    console.warn(`[host] conexao com ${viewer.name} falhou; tentando ICE restart`)
    await this.negotiate(viewer, true)
  }

  private async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    const viewer = this.viewers.get(from)
    if (!viewer) return

    if (payload.kind === 'sdp' && payload.type === 'answer') {
      await viewer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      viewer.remoteDescriptionSet = true
      for (const candidate of viewer.pendingCandidates) {
        await viewer.pc.addIceCandidate(candidate).catch(() => undefined)
      }
      viewer.pendingCandidates = []
      return
    }

    if (payload.kind === 'ice') {
      if (!payload.candidate) return
      const candidate = payload.candidate as RTCIceCandidateInit
      // Candidato pode chegar antes da answer; guardar evita perder caminho de rede.
      if (!viewer.remoteDescriptionSet) {
        viewer.pendingCandidates.push(candidate)
        return
      }
      await viewer.pc.addIceCandidate(candidate).catch(() => undefined)
      return
    }

    /**
     * O espectador pediu uma oferta nova.
     *
     * Quem responde nao pode reiniciar o ICE — so quem oferta. Antes disso, um
     * viewer preso em `checking` so tinha a opcao de recarregar a pagina, o que
     * significa que ninguem se recuperava sozinho de um NAT teimoso.
     */
    if (payload.kind === 'renegotiate') {
      console.log(
        `[host] ${viewer.name} pediu renegociacao${payload.relay ? ' (via TURN)' : ''}${payload.fresh ? ' (conexao nova)' : ''}`
      )

      /**
       * `fresh` significa que do outro lado nao existe conexao nenhuma — aba
       * recarregada, tipicamente. Reiniciar o ICE da conexao antiga nao serve:
       * ela tem credenciais DTLS de uma pagina que nao existe mais. O caminho
       * e jogar fora e construir de novo.
       */
      if (payload.fresh) {
        const nome = viewer.name
        const peerId = viewer.peerId
        this.teardownViewer(viewer)
        this.viewers.delete(peerId)
        await this.connectToViewer({
          id: peerId,
          name: nome,
          role: 'viewer',
          joinedAt: Date.now()
        })
        return
      }

      viewer.restarted = false
      await this.negotiate(viewer, true)
    }
  }

  private handleControl(viewer: ViewerPeer, raw: string): void {
    const message = parseControlMessage(raw)
    if (!message) return

    switch (message.type) {
      case 'viewer-stats':
        viewer.reported = {
          fps: message.fps,
          width: message.width,
          height: message.height,
          kbps: message.kbps,
          packetsLostPct: message.packetsLostPct,
          jitterMs: message.jitterMs,
          freezeCount: message.freezeCount,
          at: Date.now()
        }
        this.publish()
        return
      case 'chat': {
        // Os espectadores nao se conectam entre si — a malha e em estrela, com o
        // host no centro. Por isso e ele quem carimba o autor e repassa aos
        // outros; sem este relay, um viewer nunca veria o que o outro escreveu.
        this.options.onChat?.(viewer.name, message.text)
        const relayed = JSON.stringify({
          type: 'chat',
          text: message.text,
          at: message.at,
          from: viewer.name
        } satisfies ControlMessage)
        for (const other of this.viewers.values()) {
          if (other.peerId !== viewer.peerId && other.control?.readyState === 'open') {
            other.control.send(relayed)
          }
        }
        return
      }
      case 'film-accept':
        void this.sendFilmTo(viewer)
        return

      case 'film-progress':
        // O relato do viewer e o que vale: mede o que ele REALMENTE recebeu,
        // enquanto o contador local so sabe o que entrou no buffer de envio.
        viewer.filmProgress = {
          sent: message.received,
          total: message.total,
          bytesPerSecond: viewer.filmProgress?.bytesPerSecond ?? 0,
          ready: viewer.filmProgress?.ready ?? false
        }
        this.publish()
        return

      case 'film-ready':
        if (viewer.filmProgress) viewer.filmProgress.ready = true
        this.publish()
        return

      case 'clock-ping':
        // Responde imediatamente com o relogio do host (base do Modo Cinema).
        if (viewer.control?.readyState === 'open') {
          viewer.control.send(
            JSON.stringify({
              type: 'clock-pong',
              id: message.id,
              t0: message.t0,
              t1: Date.now()
            } satisfies ControlMessage)
          )
        }
        return
      default:
        return
    }
  }

  private dropViewer(peerId: string): void {
    const viewer = this.viewers.get(peerId)
    if (!viewer) return
    this.teardownViewer(viewer)
    this.viewers.delete(peerId)
    this.publish()
  }

  private teardownViewer(viewer: ViewerPeer): void {
    viewer.stats.stop()
    viewer.filmSender?.cancel()
    viewer.filmChannel?.close()
    viewer.control?.close()
    viewer.pc.close()
  }

  // -- estado ----------------------------------------------------------------

  private publish(): void {
    this.options.onState({
      status: this.status,
      roomCode: this.roomCode,
      selfId: this.selfId,
      codec: this.codec,
      streaming: Boolean(this.stream),
      error: this.error,
      micOn: Boolean(this.micTrack),
      upload: this.upload,
      uploadMeasuredKbps: this.uploadPeakKbps,
      uploadWarning: this.uploadWarning,
      viewers: [...this.viewers.values()].map((viewer) => ({
        peerId: viewer.peerId,
        name: viewer.name,
        connectionState: viewer.pc.connectionState,
        stats: viewer.lastStats,
        reported: viewer.reported,
        voice: viewer.voice,
        film: viewer.filmProgress,
        quality: viewer.governor.decision,
        controlOpen: viewer.control?.readyState === 'open'
      }))
    })
  }
}
