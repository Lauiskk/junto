import { disableAudioProcessing, type QualityPreset } from '@junto/rtc'
import type { CaptureSource } from '../../main/capture'
import { createProcessAudioTrack, type ProcessAudioTrack } from './processAudioTrack'

/**
 * Captura no renderer.
 *
 * Duas fontes de audio possiveis, nesta ordem:
 *
 * 1. **Por processo** (preferida): so o som da janela escolhida. Resolve o
 *    vazamento que apareceu em uso real — uma chamada de Discord foi ouvida por
 *    quem assistia uma janela de filme.
 * 2. **Do sistema** (queda): pega tudo o que toca no computador. Continua
 *    existindo porque em tela cheia nao ha "processo dono", e porque o modulo
 *    nativo pode faltar. Nesse caso a interface avisa.
 */

export interface CaptureResult {
  stream: MediaStream
  audioSettings: MediaTrackSettings | null
  usedFallback: boolean
  /**
   * De onde veio o som — o que decide o aviso na interface.
   * `processo` = so a janela; `excluindo` = tudo menos um app; `sistema` = tudo.
   */
  audioMode: 'processo' | 'excluindo' | 'sistema' | 'nenhum'
  audioNote: string | null
}

/** O Chromium do Electron abre MP4/WebM/MOV; MKV e AVI quase sempre falham. */
export const SUPPORTED_HINT = 'MP4, WebM ou MOV (H.264/AAC ou VP9/Opus)'

interface LegacyConstraints {
  audio: unknown
  video: unknown
}

/** So existe uma captura por vez; guardar aqui evita vazar a trilha anterior. */
let processAudio: ProcessAudioTrack | null = null

async function tryProcessAudio(
  source: CaptureSource,
  silenceSourceId: string | null
): Promise<{ track: MediaStreamTrack | null; note: string | null }> {
  /**
   * Dois caminhos, conforme o que esta sendo compartilhado:
   *
   * - **Janela**: modo INCLUDE no processo dono — sai so o som dela.
   * - **Tela inteira**: nao existe "processo dono", entao o melhor possivel e o
   *   inverso — capturar tudo MENOS o app escolhido (tipicamente o Discord, para
   *   a conversa de voz nao ir junto com o filme).
   */
  const alvo =
    source.kind === 'window'
      ? { id: source.id, mode: 'include' as const }
      : silenceSourceId
        ? { id: silenceSourceId, mode: 'exclude' as const }
        : null

  if (!alvo) return { track: null, note: null }

  const status = await window.junto.startProcessAudio(alvo.id, alvo.mode)
  if (!status.started) {
    return {
      track: null,
      note: status.available
        ? 'Nao foi possivel isolar o audio; usando o som do sistema.'
        : null
    }
  }

  const built = createProcessAudioTrack(status.format)
  if (!built) {
    await window.junto.stopProcessAudio()
    return { track: null, note: 'Navegador sem suporte para montar a trilha isolada.' }
  }

  processAudio = built
  return { track: built.track, note: null }
}

export async function startCapture(
  source: CaptureSource,
  withSystemAudio: boolean,
  preset: QualityPreset,
  silenceSourceId: string | null = null
): Promise<CaptureResult> {
  stopProcessAudioTrack()

  const isolated = withSystemAudio
    ? await tryProcessAudio(source, silenceSourceId)
    : { track: null, note: null }

  // Se o audio ja vem isolado, o getDisplayMedia pede video puro — pedir os dois
  // faria o som do sistema entrar junto e desfazer todo o isolamento.
  const precisaAudioDoSistema = withSystemAudio && !isolated.track

  await window.junto.selectSource({
    sourceId: source.id,
    withSystemAudio: precisaAudioDoSistema
  })

  let stream: MediaStream
  let usedFallback = false

  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: preset.maxFramerate, max: preset.maxFramerate }
      },
      audio: precisaAudioDoSistema
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false
    })
  } catch (err) {
    console.warn('[host] getDisplayMedia falhou; tentando caminho legado:', err)
    usedFallback = true
    const legacy: LegacyConstraints = {
      audio: precisaAudioDoSistema
        ? { mandatory: { chromeMediaSource: 'desktop' } }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxFrameRate: preset.maxFramerate
        }
      }
    }
    stream = await navigator.mediaDevices.getUserMedia(
      legacy as unknown as MediaStreamConstraints
    )
  }

  if (isolated.track) stream.addTrack(isolated.track)

  const audioTrack = stream.getAudioTracks()[0] ?? null
  // O processamento de voz so faz sentido desligar na trilha do sistema; a
  // trilha isolada ja vem crua do WASAPI, sem nada aplicado.
  const audioSettings =
    audioTrack && !isolated.track ? await disableAudioProcessing(audioTrack) : null

  const audioMode: CaptureResult['audioMode'] = !isolated.track
    ? audioTrack
      ? 'sistema'
      : 'nenhum'
    : source.kind === 'window'
      ? 'processo'
      : 'excluindo'

  return { stream, audioSettings, usedFallback, audioMode, audioNote: isolated.note }
}

export function stopProcessAudioTrack(): void {
  processAudio?.stop()
  processAudio = null
  void window.junto.stopProcessAudio()
}

/**
 * Encerra APENAS as trilhas de uma stream, sem tocar no audio por processo.
 *
 * Existe separado de `stopCapture` por causa da troca de fonte: ao trocar de
 * janela para tela, a stream nova ja foi adquirida e o audio nativo novo ja esta
 * rodando — derrubar o audio aqui mataria justamente o que acabou de comecar.
 */
export function stopStreamTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

export function stopCapture(stream: MediaStream | null): void {
  stopStreamTracks(stream)
  stopProcessAudioTrack()
}

/** Resolucao real que esta saindo da captura (nem sempre e a do monitor). */
export function describeVideoTrack(stream: MediaStream | null): string {
  const track = stream?.getVideoTracks()[0]
  if (!track) return '—'
  const settings = track.getSettings()
  const fps = settings.frameRate ? `@${Math.round(settings.frameRate)}fps` : ''
  return `${settings.width ?? '?'}x${settings.height ?? '?'} ${fps}`.trim()
}
