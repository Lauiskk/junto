/**
 * Modo Cinema — transferencia do arquivo original + reproducao sincronizada.
 *
 * O modo simples (fase 4) recodifica o filme ao vivo: a qualidade fica limitada
 * pelo upload do host e o mesmo bitrate e gasto continuamente, do inicio ao fim.
 * Aqui a logica se inverte — os bytes originais viajam UMA vez, cada pessoa
 * decodifica localmente, e depois so trafega a posicao do player.
 *
 * Resultado: 4K intacto, sem perda de recodificacao, e o upload deixa de ser o
 * teto da qualidade. E o mesmo modelo do Plex Watch Together.
 *
 * O preco: e preciso esperar a transferencia antes de comecar.
 */

/**
 * 16 KB e o tamanho de mensagem que funciona em qualquer implementacao de
 * SCTP/WebRTC. Chrome aceita bem mais, mas nao vale arriscar interoperabilidade
 * por um ganho que o controle de fluxo abaixo ja entrega.
 */
const CHUNK_SIZE = 16 * 1024

/**
 * Sem controle de fluxo, dava para enfileirar o filme inteiro no buffer do canal
 * e estourar a memoria antes de um unico byte sair pela rede. Enviamos ate a
 * marca d'agua e esperamos o buffer drenar.
 */
const HIGH_WATER_MARK = 1024 * 1024
const LOW_WATER_MARK = 256 * 1024

/**
 * Quanto acumular em memoria antes de dobrar para dentro do Blob.
 * Blobs no Chromium sao guardados pelo navegador (com spill para disco), entao
 * dobrar cedo mantem o heap do JS pequeno mesmo num filme de varios GB.
 */
const FOLD_THRESHOLD = 8 * 1024 * 1024

export interface TransferProgress {
  sent: number
  total: number
  /** Bytes por segundo da janela recente. */
  bytesPerSecond: number
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

export class FilmSender {
  private cancelled = false
  private startedAt = 0

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly file: File
  ) {}

  cancel(): void {
    this.cancelled = true
  }

  async send(onProgress: (progress: TransferProgress) => void): Promise<void> {
    this.channel.binaryType = 'arraybuffer'
    this.channel.bufferedAmountLowThreshold = LOW_WATER_MARK
    this.startedAt = Date.now()

    let offset = 0

    while (offset < this.file.size) {
      if (this.cancelled) return
      if (this.channel.readyState !== 'open') {
        throw new Error('canal do filme fechou durante o envio')
      }

      if (this.channel.bufferedAmount > HIGH_WATER_MARK) {
        await this.waitForDrain()
        continue
      }

      const slice = this.file.slice(offset, offset + CHUNK_SIZE)
      const buffer = await slice.arrayBuffer()
      this.channel.send(buffer)
      offset += buffer.byteLength

      const seconds = (Date.now() - this.startedAt) / 1000
      onProgress({
        sent: offset,
        total: this.file.size,
        bytesPerSecond: seconds > 0 ? Math.round(offset / seconds) : 0
      })
    }
  }

  private waitForDrain(): Promise<void> {
    return new Promise((resolve) => {
      const onLow = (): void => {
        this.channel.removeEventListener('bufferedamountlow', onLow)
        resolve()
      }
      this.channel.addEventListener('bufferedamountlow', onLow)
    })
  }
}

// ---------------------------------------------------------------------------
// Recepcao
// ---------------------------------------------------------------------------

export class FilmReceiver {
  private pending: ArrayBuffer[] = []
  private pendingBytes = 0
  private folded: Blob | null = null
  private startedAt = Date.now()

  received = 0

  constructor(
    readonly name: string,
    readonly total: number,
    readonly mimeType: string
  ) {}

  push(chunk: ArrayBuffer): TransferProgress {
    this.pending.push(chunk)
    this.pendingBytes += chunk.byteLength
    this.received += chunk.byteLength

    if (this.pendingBytes >= FOLD_THRESHOLD) this.fold()

    const seconds = (Date.now() - this.startedAt) / 1000
    return {
      sent: this.received,
      total: this.total,
      bytesPerSecond: seconds > 0 ? Math.round(this.received / seconds) : 0
    }
  }

  get complete(): boolean {
    return this.received >= this.total && this.total > 0
  }

  /** Junta tudo num Blob unico, pronto para virar objectURL. */
  finish(): Blob {
    this.fold()
    return this.folded ?? new Blob([], { type: this.mimeType })
  }

  private fold(): void {
    if (this.pending.length === 0) return
    // Concatenar Blobs nao copia os dados ja existentes — o Blob anterior entra
    // por referencia. E o que permite montar arquivos grandes sem estourar o heap.
    const parts: BlobPart[] = this.folded ? [this.folded, ...this.pending] : [...this.pending]
    this.folded = new Blob(parts, { type: this.mimeType })
    this.pending = []
    this.pendingBytes = 0
  }
}

// ---------------------------------------------------------------------------
// Sincronizacao da reproducao
// ---------------------------------------------------------------------------

/** Acima disto, corrigir com playbackRate demoraria demais: melhor pular. */
export const HARD_SEEK_THRESHOLD_SEC = 1
/** Abaixo disto ninguem percebe a diferenca; mexer so causaria oscilacao. */
export const DEAD_ZONE_SEC = 0.1
/** Teto do ajuste fino: 3% e imperceptivel no audio; 10% ja soa "acelerado". */
export const MAX_RATE_ADJUSTMENT = 0.03

export interface PlaybackCorrection {
  action: 'seek' | 'rate' | 'none'
  /** Posicao alvo em segundos (para 'seek'). */
  seekTo?: number
  /** Velocidade a aplicar (para 'rate' e 'none'). */
  playbackRate: number
  driftSec: number
}

/**
 * Decide como alcancar o host sem que a correcao seja percebida.
 *
 * Pular o video a cada pequeno desvio deixaria a imagem "engasgando" o tempo
 * todo. Por isso: desvio grande -> pulo unico; desvio pequeno -> acelera ou
 * desacelera de leve ate encostar; desvio irrelevante -> nao mexe.
 */
export function computePlaybackCorrection(
  targetSec: number,
  currentSec: number
): PlaybackCorrection {
  const drift = targetSec - currentSec

  if (Math.abs(drift) > HARD_SEEK_THRESHOLD_SEC) {
    return { action: 'seek', seekTo: targetSec, playbackRate: 1, driftSec: drift }
  }

  if (Math.abs(drift) > DEAD_ZONE_SEC) {
    const adjustment = Math.max(
      -MAX_RATE_ADJUSTMENT,
      Math.min(MAX_RATE_ADJUSTMENT, drift / 2)
    )
    return { action: 'rate', playbackRate: 1 + adjustment, driftSec: drift }
  }

  return { action: 'none', playbackRate: 1, driftSec: drift }
}

/**
 * Onde o host esta AGORA, corrigido pela diferenca de relogio entre as maquinas.
 * Sem o offset, dois PCs com relogios 300 ms diferentes ficariam permanentemente
 * dessincronizados mesmo com a rede perfeita.
 */
export function projectHostPosition(
  positionSec: number,
  hostTimeMs: number,
  clockOffsetMs: number,
  playing: boolean,
  nowMs = Date.now()
): number {
  if (!playing) return positionSec
  const elapsedMs = nowMs + clockOffsetMs - hostTimeMs
  return positionSec + Math.max(0, elapsedMs) / 1000
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
