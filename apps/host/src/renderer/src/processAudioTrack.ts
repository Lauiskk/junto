/**
 * Transforma o PCM do modulo nativo numa trilha de audio do WebRTC.
 *
 * O caminho e curto de proposito: o nativo ja entrega exatamente o formato que o
 * WebRTC quer (s16 intercalado, 48 kHz, estereo), entao aqui nao ha reamostragem
 * nem conversao — so empacotar em AudioData e escrever na trilha.
 */

interface AudioFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export interface ProcessAudioTrack {
  track: MediaStreamTrack
  stop: () => void
}

type TrackGeneratorCtor = new (init: { kind: 'audio' }) => MediaStreamTrack & {
  writable: WritableStream<unknown>
}

type AudioDataCtor = new (init: {
  format: string
  sampleRate: number
  numberOfFrames: number
  numberOfChannels: number
  timestamp: number
  /**
   * Aceita qualquer buffer: o PCM chega do IPC como Uint8Array, e as versoes
   * recentes do TypeScript tornaram os tipos de buffer genericos, o que faria
   * a assinatura estrita brigar sem nenhum ganho real.
   */
  data: ArrayBufferLike | ArrayBufferView
}) => unknown

/**
 * Monta a trilha. Retorna null quando o navegador nao tem os Insertable Streams
 * — nesse caso o app volta ao audio do sistema, com o aviso correspondente.
 */
export function createProcessAudioTrack(format: AudioFormat): ProcessAudioTrack | null {
  const Generator = (globalThis as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor })
    .MediaStreamTrackGenerator
  const AudioDataClass = (globalThis as unknown as { AudioData?: AudioDataCtor }).AudioData

  if (!Generator || !AudioDataClass) return null

  const generator = new Generator({ kind: 'audio' })
  const writer = generator.writable.getWriter()

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8)
  /**
   * O timestamp precisa avancar sozinho, em microssegundos, a partir da contagem
   * de amostras — e nao do relogio da maquina. Usar Date.now() aqui produziria
   * micro-saltos a cada pacote e estalos no audio.
   */
  let timestampUs = 0
  let closed = false

  const unsubscribe = window.junto.onAudioPcm((chunk) => {
    if (closed || chunk.byteLength < bytesPerFrame) return

    const frames = Math.floor(chunk.byteLength / bytesPerFrame)
    try {
      const data = new AudioDataClass({
        format: 's16',
        sampleRate: format.sampleRate,
        numberOfFrames: frames,
        numberOfChannels: format.channels,
        timestamp: timestampUs,
        data: chunk
      })
      timestampUs += Math.round((frames / format.sampleRate) * 1_000_000)
      void writer.write(data).catch(() => undefined)
    } catch {
      // Pacote malformado nao pode derrubar a transmissao inteira.
    }
  })

  return {
    track: generator,
    stop: () => {
      closed = true
      unsubscribe()
      void writer.close().catch(() => undefined)
      generator.stop()
    }
  }
}
