/**
 * Coleta de estatisticas do WebRTC.
 *
 * getStats() e a diferenca entre "ta travando" e um diagnostico. O campo mais
 * valioso e qualityLimitationReason: o proprio Chrome diz se o gargalo e CPU,
 * banda ou nada. Sem isso, otimizar vira chute.
 *
 * A perda de pacotes precisa ser contada POR TRILHA, e isso nao e detalhe. Na
 * primeira versao o numerador somava a perda das tres trilhas (video, som do
 * sistema e voz) enquanto o denominador tinha so os pacotes de video — e num
 * teste real isso virou "perda de 28,6%" numa conexao com RTT de 25 ms. O numero
 * era ficcao, e pior: apontava para a rede quando o problema era o audio
 * afogando o video. Aqui cada `remote-inbound-rtp` e casado com o
 * `outbound-rtp` de mesmo SSRC antes de qualquer divisao.
 */

type RawStat = Record<string, unknown>

export interface LinkStats {
  at: number
  direction: 'send' | 'recv'
  video: {
    kbps: number
    fps: number
    width: number
    height: number
    codec: string | null
    /** Ex.: "ExternalEncoder" / "NvEnc" = encoder da GPU; libvpx/openh264 = software. */
    implementation: string | null
    /** 'none' | 'cpu' | 'bandwidth' | 'other' — do lado de quem envia. */
    limitation: string | null
    /** Congelamentos percebidos — do lado de quem assiste. */
    freezeCount: number
    framesDropped: number
  }
  audio: { kbps: number }
  network: {
    rttMs: number
    jitterMs: number
    /** Perda medida SO na trilha de video. */
    packetsLostPct: number
    /** Perda medida SO nas trilhas de audio (som do sistema + voz). */
    packetsLostPctAudio: number
    availableOutgoingKbps: number
    /** true = trafego passando por TURN (custa latencia e banda do servidor). */
    relayed: boolean
    localCandidateType: string | null
    remoteCandidateType: string | null
  }
}

interface KindCounters {
  bytes: number
  packets: number
  packetsLost: number
}

interface Sample {
  at: number
  video: KindCounters
  audio: KindCounters
}

const zeroCounters = (): KindCounters => ({ bytes: 0, packets: 0, packetsLost: 0 })

export const EMPTY_STATS: LinkStats = {
  at: 0,
  direction: 'send',
  video: {
    kbps: 0,
    fps: 0,
    width: 0,
    height: 0,
    codec: null,
    implementation: null,
    limitation: null,
    freezeCount: 0,
    framesDropped: 0
  },
  audio: { kbps: 0 },
  network: {
    rttMs: 0,
    jitterMs: 0,
    packetsLostPct: 0,
    packetsLostPctAudio: 0,
    availableOutgoingKbps: 0,
    relayed: false,
    localCandidateType: null,
    remoteCandidateType: null
  }
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Percentual de perda com uma casa decimal; 0 quando nao houve trafego. */
function lossPct(deltaLost: number, deltaPackets: number): number {
  const total = deltaPackets + deltaLost
  if (total <= 0) return 0
  // Contadores de perda podem recuar entre amostras (o relatorio do receptor
  // chega fora de ordem); negativo aqui nao significa "perda negativa".
  return Math.max(0, Math.round((deltaLost / total) * 1000) / 10)
}

export class StatsCollector {
  private timer: ReturnType<typeof setInterval> | null = null
  private previous: Sample | null = null

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly direction: 'send' | 'recv'
  ) {}

  start(intervalMs: number, onSample: (stats: LinkStats) => void): void {
    this.stop()
    this.timer = setInterval(() => {
      void this.sample().then(onSample).catch(() => undefined)
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async sample(): Promise<LinkStats> {
    const report = await this.pc.getStats()
    const byId = new Map<string, RawStat>()
    for (const stat of report.values()) byId.set(String((stat as RawStat).id), stat as RawStat)

    const result: LinkStats = structuredClone(EMPTY_STATS)
    result.at = Date.now()
    result.direction = this.direction

    const wanted = this.direction === 'send' ? 'outbound-rtp' : 'inbound-rtp'
    const video = zeroCounters()
    const audio = zeroCounters()
    /** SSRC -> trilha, para casar o relatorio do receptor com a trilha certa. */
    const kindBySsrc = new Map<number, 'video' | 'audio'>()
    let rttFromReceiver = 0

    for (const stat of byId.values()) {
      const type = stat.type as string

      if (type === wanted) {
        const bytes =
          this.direction === 'send' ? num(stat.bytesSent) : num(stat.bytesReceived)
        const packets =
          this.direction === 'send' ? num(stat.packetsSent) : num(stat.packetsReceived)
        const ssrc = num(stat.ssrc, -1)

        if (stat.kind === 'video') {
          if (ssrc >= 0) kindBySsrc.set(ssrc, 'video')
          video.bytes += bytes
          video.packets += packets
          if (this.direction === 'recv') {
            video.packetsLost += num(stat.packetsLost)
            result.network.jitterMs = num(stat.jitter) * 1000
          }

          result.video.fps = num(stat.framesPerSecond, result.video.fps)
          result.video.width = num(stat.frameWidth, result.video.width)
          result.video.height = num(stat.frameHeight, result.video.height)
          result.video.implementation =
            str(stat.encoderImplementation) ??
            str(stat.decoderImplementation) ??
            result.video.implementation
          result.video.limitation =
            str(stat.qualityLimitationReason) ?? result.video.limitation
          result.video.freezeCount = num(stat.freezeCount, result.video.freezeCount)
          result.video.framesDropped = num(stat.framesDropped, result.video.framesDropped)

          const codecId = str(stat.codecId)
          if (codecId) {
            const codec = byId.get(codecId)
            const mime = codec ? str(codec.mimeType) : null
            if (mime) result.video.codec = mime.replace(/^video\//i, '')
          }
        } else if (stat.kind === 'audio') {
          if (ssrc >= 0) kindBySsrc.set(ssrc, 'audio')
          audio.bytes += bytes
          audio.packets += packets
          if (this.direction === 'recv') audio.packetsLost += num(stat.packetsLost)
        }
      }

      if (type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
        result.network.rttMs = num(stat.currentRoundTripTime) * 1000
        result.network.availableOutgoingKbps = Math.round(
          num(stat.availableOutgoingBitrate) / 1000
        )
        const local = byId.get(str(stat.localCandidateId) ?? '')
        const remote = byId.get(str(stat.remoteCandidateId) ?? '')
        result.network.localCandidateType = local ? str(local.candidateType) : null
        result.network.remoteCandidateType = remote ? str(remote.candidateType) : null
        result.network.relayed =
          result.network.localCandidateType === 'relay' ||
          result.network.remoteCandidateType === 'relay'
      }
    }

    /**
     * Do lado de quem envia, perda e RTT so existem no relatorio que o receptor
     * devolve (RTCP). Segunda passada porque o mapa de SSRC precisa estar
     * completo — a ordem dos stats no relatorio nao e garantida.
     */
    if (this.direction === 'send') {
      for (const stat of byId.values()) {
        if (stat.type !== 'remote-inbound-rtp') continue
        const kind = str(stat.kind) ?? kindBySsrc.get(num(stat.ssrc, -1)) ?? null
        const lost = num(stat.packetsLost)
        if (kind === 'video') {
          video.packetsLost += lost
          // O jitter que interessa mostrar e o do video; o do audio some no buffer.
          result.network.jitterMs = num(stat.jitter) * 1000
          rttFromReceiver = num(stat.roundTripTime) * 1000 || rttFromReceiver
        } else if (kind === 'audio') {
          audio.packetsLost += lost
          if (!rttFromReceiver) rttFromReceiver = num(stat.roundTripTime) * 1000
        }
      }
      // candidate-pair e a medida mais direta; o RTCP entra so quando ela falta.
      if (!result.network.rttMs) result.network.rttMs = rttFromReceiver
    }

    const current: Sample = { at: result.at, video, audio }

    if (this.previous) {
      const seconds = (current.at - this.previous.at) / 1000
      if (seconds > 0) {
        result.video.kbps = Math.round(
          ((current.video.bytes - this.previous.video.bytes) * 8) / seconds / 1000
        )
        result.audio.kbps = Math.round(
          ((current.audio.bytes - this.previous.audio.bytes) * 8) / seconds / 1000
        )
      }
      result.network.packetsLostPct = lossPct(
        current.video.packetsLost - this.previous.video.packetsLost,
        current.video.packets - this.previous.video.packets
      )
      result.network.packetsLostPctAudio = lossPct(
        current.audio.packetsLost - this.previous.audio.packetsLost,
        current.audio.packets - this.previous.audio.packets
      )
    }

    this.previous = current
    return result
  }
}

/** Texto curto para o HUD: por que a qualidade esta limitada agora. */
export function describeLimitation(stats: LinkStats): string | null {
  switch (stats.video.limitation) {
    case 'cpu':
      return 'Limitado pela CPU — tente o encoder da GPU ou baixe o preset'
    case 'bandwidth':
      return 'Limitado pela banda — seu upload nao aguenta este bitrate'
    case 'other':
      return 'Limitado por outro motivo'
    default:
      return null
  }
}
