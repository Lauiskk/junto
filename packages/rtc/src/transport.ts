import type { ControlMessage } from '@junto/protocol'
import type { QualityPreset } from './presets.js'
import type { LinkStats } from './stats.js'
import type { QualityDecision } from './bitrate-budget.js'

/**
 * Camada de transporte.
 *
 * Hoje existe uma implementacao so: P2P (menor latencia possivel, custo quase
 * zero). Esta interface existe para que trocar por um SFU no futuro — quando/se
 * o upload do host virar o gargalo com muitos espectadores — seja substituir uma
 * peca, e nao reescrever o app. Tudo acima daqui trabalha com estes tipos.
 */

export type TransportKind = 'p2p' | 'sfu'

export interface ViewerConnection {
  peerId: string
  name: string
  /** Estado da conexao WebRTC com este espectador. */
  connectionState: RTCPeerConnectionState
  /** O que ESTE lado esta enviando para ele. */
  stats: LinkStats | null
  /** O que ELE relata estar recebendo (chega pelo canal de controle). */
  reported: ViewerReport | null
  /** Voz dele, quando o microfone esta aberto. */
  voice: MediaStream | null
  /** Progresso do download do filme no Modo Cinema. */
  film: ViewerFilmProgress | null
  /** Resolucao/bitrate escolhidos para ESTE espectador a partir da banda dele. */
  quality: QualityDecision | null
  controlOpen: boolean
}

export interface ViewerFilmProgress {
  sent: number
  total: number
  bytesPerSecond: number
  /** Confirmado pelo proprio viewer: ele ja tem o arquivo inteiro. */
  ready: boolean
}

export interface ViewerReport {
  fps: number
  width: number
  height: number
  kbps: number
  packetsLostPct: number
  jitterMs: number
  freezeCount: number
  at: number
}

export interface Broadcaster {
  readonly kind: TransportKind
  /** Troca o que esta sendo transmitido sem renegociar a conexao. */
  setStream(stream: MediaStream | null): Promise<void>
  setPreset(preset: QualityPreset): Promise<void>
  broadcastControl(message: ControlMessage): void
  stop(): void
}
