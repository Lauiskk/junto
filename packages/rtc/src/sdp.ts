/**
 * Transformacoes de SDP.
 *
 * O unico ajuste que NAO da para fazer via API e o do Opus: estereo e bitrate alto
 * so entram como parametros fmtp no SDP. Sem isso, o Chrome trata seu audio como
 * voz de reuniao — mono, ~40 kbps, com supressao de ruido agressiva — e musica,
 * trilha de filme e som de jogo ficam abafados. Este e o detalhe que quase todos
 * os apps de watch party erram.
 */

export interface OpusOptions {
  /** Estereo real (o padrao do WebRTC e mono). */
  stereo?: boolean
  /** Teto de bitrate do Opus em bits/s. 128k-256k para musica/filme. */
  maxAverageBitrate?: number
  /** FEC: recupera perda pequena sem retransmitir. Vale sempre a pena. */
  useInbandFec?: boolean
  /** DTX corta o envio no silencio; otimo para voz, pessimo para trilha sonora. */
  useDtx?: boolean
}

const DEFAULT_OPUS: Required<OpusOptions> = {
  stereo: true,
  maxAverageBitrate: 256_000,
  useInbandFec: true,
  useDtx: false
}

/**
 * Injeta os parametros de Opus na linha fmtp correspondente.
 * Preserva parametros ja existentes e nao toca em outros codecs.
 */
export function tuneOpus(sdp: string, options: OpusOptions = {}): string {
  const opts = { ...DEFAULT_OPUS, ...options }
  const lines = sdp.split(/\r\n|\n/)

  // Descobre o payload type do Opus (varia por navegador e por negociacao).
  const opusPayloadTypes = new Set<string>()
  for (const line of lines) {
    const match = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line)
    if (match) opusPayloadTypes.add(match[1]!)
  }
  if (opusPayloadTypes.size === 0) return sdp

  const desired: Record<string, string> = {
    stereo: opts.stereo ? '1' : '0',
    'sprop-stereo': opts.stereo ? '1' : '0',
    maxaveragebitrate: String(opts.maxAverageBitrate),
    useinbandfec: opts.useInbandFec ? '1' : '0',
    usedtx: opts.useDtx ? '1' : '0'
  }

  const output: string[] = []
  const seenFmtp = new Set<string>()

  for (const line of lines) {
    const fmtpMatch = /^a=fmtp:(\d+)\s+(.*)$/.exec(line)
    if (fmtpMatch && opusPayloadTypes.has(fmtpMatch[1]!)) {
      const payloadType = fmtpMatch[1]!
      const params = new Map<string, string>()
      for (const pair of fmtpMatch[2]!.split(';')) {
        const [key, value] = pair.split('=')
        if (key && value !== undefined) params.set(key.trim(), value.trim())
      }
      for (const [key, value] of Object.entries(desired)) params.set(key, value)
      const merged = [...params].map(([k, v]) => `${k}=${v}`).join(';')
      output.push(`a=fmtp:${payloadType} ${merged}`)
      seenFmtp.add(payloadType)
      continue
    }

    output.push(line)

    // Opus sem linha fmtp: cria uma logo apos o rtpmap.
    const rtpmapMatch = /^a=rtpmap:(\d+)\s+opus\/48000/i.exec(line)
    if (rtpmapMatch) {
      const payloadType = rtpmapMatch[1]!
      const hasFmtp = lines.some((l) => l.startsWith(`a=fmtp:${payloadType} `))
      if (!hasFmtp && !seenFmtp.has(payloadType)) {
        const merged = Object.entries(desired)
          .map(([k, v]) => `${k}=${v}`)
          .join(';')
        output.push(`a=fmtp:${payloadType} ${merged}`)
        seenFmtp.add(payloadType)
      }
    }
  }

  return output.join('\r\n')
}

export interface VideoBitrateOptions {
  /** Onde o encoder COMECA, em kbps. Sem isto a sessao arranca em ~300 kbps. */
  startKbps?: number
  /** Piso: impede o encoder de ser estrangulado por uma estimativa pessimista. */
  minKbps?: number
  /** Teto absoluto, em kbps. */
  maxKbps?: number
}

/** Codecs que aparecem na secao de video mas nao carregam imagem. */
const NAO_E_VIDEO = /^(rtx|red|ulpfec|flexfec-03)$/i

/**
 * Injeta os parametros de bitrate do Chromium na secao de video.
 *
 * `x-google-start-bitrate` existe porque o WebRTC nasceu para videochamada: toda
 * sessao arranca perto de 300 kbps e leva ~30 s subindo em rampa. Para quem
 * comeca a assistir um filme, esses 30 s sao justamente a primeira impressao —
 * e ela e de imagem borrada.
 *
 * `x-google-min-bitrate` e o pedido explicito de "pode pegar muito da internet":
 * um piso que a estimativa de banda nao derruba. E uma faca de dois gumes —
 * forcar um piso acima da capacidade real PROVOCA perda em vez de evitar — por
 * isso quem liga isto tambem liga a trava de perda no host, que o retira sozinho
 * quando ele passa a machucar.
 *
 * Sao extensoes do Chromium, nao padrao. Quem envia aqui e sempre o Electron
 * (que e Chromium), e um navegador que as ignore apenas fica com o comportamento
 * de hoje.
 */
export function tuneVideoBitrate(sdp: string, options: VideoBitrateOptions = {}): string {
  const desired: Record<string, string> = {}
  if (options.startKbps) desired['x-google-start-bitrate'] = String(Math.round(options.startKbps))
  if (options.minKbps) desired['x-google-min-bitrate'] = String(Math.round(options.minKbps))
  if (options.maxKbps) desired['x-google-max-bitrate'] = String(Math.round(options.maxKbps))
  if (Object.keys(desired).length === 0) return sdp

  const lines = sdp.split(/\r\n|\n/)

  // Descobre os payload types de video reais (fora de m=video eles nao valem, e
  // rtx/red/ulpfec sao mecanismos de recuperacao, nao codecs de imagem).
  const videoPayloadTypes = new Set<string>()
  let dentroDoVideo = false
  for (const line of lines) {
    if (line.startsWith('m=')) {
      dentroDoVideo = line.startsWith('m=video')
      continue
    }
    if (!dentroDoVideo) continue
    const match = /^a=rtpmap:(\d+)\s+([^/]+)\//.exec(line)
    if (match && !NAO_E_VIDEO.test(match[2]!)) videoPayloadTypes.add(match[1]!)
  }
  if (videoPayloadTypes.size === 0) return sdp

  const output: string[] = []
  const jaTemFmtp = new Set<string>()

  for (const line of lines) {
    const fmtpMatch = /^a=fmtp:(\d+)\s+(.*)$/.exec(line)
    if (fmtpMatch && videoPayloadTypes.has(fmtpMatch[1]!)) {
      const params = new Map<string, string>()
      for (const pair of fmtpMatch[2]!.split(';')) {
        const separador = pair.indexOf('=')
        if (separador > 0) {
          params.set(pair.slice(0, separador).trim(), pair.slice(separador + 1).trim())
        }
      }
      for (const [key, value] of Object.entries(desired)) params.set(key, value)
      output.push(
        `a=fmtp:${fmtpMatch[1]} ${[...params].map(([k, v]) => `${k}=${v}`).join(';')}`
      )
      jaTemFmtp.add(fmtpMatch[1]!)
      continue
    }

    output.push(line)

    // Codec de video sem linha fmtp (VP8 costuma vir assim): cria uma.
    const rtpmapMatch = /^a=rtpmap:(\d+)\s+([^/]+)\//.exec(line)
    if (rtpmapMatch && videoPayloadTypes.has(rtpmapMatch[1]!)) {
      const payloadType = rtpmapMatch[1]!
      const temFmtp = lines.some((l) => l.startsWith(`a=fmtp:${payloadType} `))
      if (!temFmtp && !jaTemFmtp.has(payloadType)) {
        output.push(
          `a=fmtp:${payloadType} ${Object.entries(desired)
            .map(([k, v]) => `${k}=${v}`)
            .join(';')}`
        )
        jaTemFmtp.add(payloadType)
      }
    }
  }

  return output.join('\r\n')
}

/** Nome legivel do codec de video efetivamente negociado (para o HUD). */
export function negotiatedVideoCodec(sdp: string): string | null {
  const videoSection = sdp.split(/^m=/m).find((section) => section.startsWith('video'))
  if (!videoSection) return null

  const firstPayloadType = videoSection.split('\n')[0]?.trim().split(/\s+/)[3]
  if (!firstPayloadType) return null

  const match = new RegExp(`^a=rtpmap:${firstPayloadType}\\s+(\\S+?)/`, 'm').exec(
    videoSection
  )
  return match?.[1] ?? null
}
