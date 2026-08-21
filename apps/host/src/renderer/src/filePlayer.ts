/**
 * Transmitir um video/filme do proprio computador — modo simples (fase 4).
 *
 * O arquivo toca num elemento <video> local e vira uma MediaStream com
 * captureStream(), que entra no MESMO caminho do compartilhamento de tela: video
 * e audio ja vem juntos e sincronizados, sem re-multiplexar nada.
 *
 * O preco desta abordagem e que o filme e re-codificado ao vivo, entao a
 * qualidade fica limitada pelo seu upload. O Modo Cinema (fase 6) resolve isso
 * mandando os bytes originais e sincronizando a reproducao — 4K intacto —, mas
 * custa buffer inicial e remux de MKV no navegador. Este modo entrega hoje.
 */

/** O Chromium do Electron abre MP4/WebM/MOV; MKV e AVI quase sempre falham. */
export const SUPPORTED_HINT = 'MP4, WebM ou MOV (H.264/AAC ou VP9/Opus)'

export interface LoadedFile {
  stream: MediaStream
  title: string
  durationSec: number
}

type CapturableVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

export class FileLoadError extends Error {
  constructor(
    message: string,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'FileLoadError'
  }
}

/**
 * Carrega o arquivo no elemento e devolve a stream capturada.
 * O objectURL anterior e revogado para nao vazar memoria em sessao longa.
 */
export async function loadFileIntoPlayer(
  video: HTMLVideoElement,
  file: File
): Promise<LoadedFile> {
  revokeCurrentSource(video)

  const url = URL.createObjectURL(file)
  video.src = url

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      const code = video.error?.code
      if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        reject(
          new FileLoadError(
            `O player nao consegue abrir "${file.name}".`,
            `Formatos que funcionam: ${SUPPORTED_HINT}. MKV e HEVC costumam falhar porque o Chromium nao traz esses demuxers — converter para MP4 resolve.`
          )
        )
      } else {
        reject(new FileLoadError(`Falha ao ler "${file.name}" (codigo ${code ?? '?'}).`))
      }
    }
    const cleanup = (): void => {
      video.removeEventListener('loadedmetadata', onReady)
      video.removeEventListener('error', onError)
    }
    video.addEventListener('loadedmetadata', onReady)
    video.addEventListener('error', onError)
  })

  /**
   * Container abriu — mas isso NAO significa que o video vai aparecer.
   *
   * Medido com um MKV real (H.264 em Matroska): o Chromium le o container, toca
   * o AUDIO, avanca a posicao normalmente e nao dispara nenhum erro — mas a
   * trilha de video fica 0x0. Sem esta checagem, o app transmitiria som com tela
   * preta e ninguem saberia por que.
   */
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    revokeCurrentSource(video)
    throw new FileLoadError(
      `"${file.name}" abriu, mas sem imagem — so o audio e legivel.`,
      `O Chromium le o container mas nao decodifica esse video (tipico de MKV e de codecs antigos). Formatos que funcionam: ${SUPPORTED_HINT}. Converter para MP4 resolve, e sem recodificar a imagem: ffmpeg -i "${file.name}" -c copy saida.mp4`
    )
  }

  const capturable = video as CapturableVideo
  const capture = capturable.captureStream ?? capturable.mozCaptureStream
  if (!capture) {
    throw new FileLoadError('Este navegador nao suporta captureStream().')
  }

  const stream = capture.call(capturable)

  // captureStream() logo apos loadedmetadata pode vir sem tracks: o elemento so
  // materializa as trilhas quando comeca a decodificar. Um play() resolve.
  if (stream.getVideoTracks().length === 0) {
    await video.play().catch(() => undefined)
  }

  // Ultima barreira: se depois do play ainda nao ha video, nao ha o que transmitir.
  if (stream.getVideoTracks().length === 0) {
    revokeCurrentSource(video)
    throw new FileLoadError(
      `"${file.name}" nao produziu imagem para transmitir.`,
      `Converta para MP4: ffmpeg -i "${file.name}" -c copy saida.mp4`
    )
  }

  return {
    stream,
    title: file.name,
    durationSec: Number.isFinite(video.duration) ? video.duration : 0
  }
}

export function revokeCurrentSource(video: HTMLVideoElement): void {
  const previous = video.src
  video.removeAttribute('src')
  video.load()
  if (previous.startsWith('blob:')) URL.revokeObjectURL(previous)
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`
}
