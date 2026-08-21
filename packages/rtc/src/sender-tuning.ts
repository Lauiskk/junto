import type { QualityPreset } from './presets.js'

/**
 * Ajuste fino do lado que envia.
 *
 * Sem isto, o navegador escolhe sozinho — e escolhe pensando em videochamada de
 * webcam (rosto falando), nao em tela de codigo ou jogo a 60fps. E aqui que a
 * transmissao deixa de "funcionar" e passa a ficar boa.
 */

/** degradationPreference ainda nao esta em todas as versoes do lib.dom. */
type SendParameters = RTCRtpSendParameters & {
  degradationPreference?: QualityPreset['degradationPreference']
}

export async function applyPresetToSender(
  sender: RTCRtpSender,
  preset: QualityPreset
): Promise<void> {
  if (!sender.track) return

  const params = sender.getParameters() as SendParameters

  // Chrome exige que encodings exista antes de setParameters.
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}]
  }

  const isVideo = sender.track.kind === 'video'
  const encoding = params.encodings[0]!

  if (isVideo) {
    // Bitrate e resolucao de video NAO sao definidos aqui de proposito: quem
    // manda neles e o QualityGovernor, que enxerga a banda medida. Ter dois
    // donos do mesmo botao foi o que produziu 1080p a 101 kbps.
    encoding.maxFramerate = preset.maxFramerate
    params.degradationPreference = preset.degradationPreference
  } else {
    // Idem para o audio, e pelo mesmo motivo elevado a segunda potencia: o
    // preset fixava 256 kbps aqui e, num link de 100 kbps, o audio consumia o
    // link inteiro antes de sobrar qualquer coisa para a imagem. O valor do
    // preset e o TETO; quem escolhe o numero do momento e o governor.
    encoding.maxBitrate = preset.audioBitrateKbps * 1000
  }

  try {
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[rtc] setParameters falhou:', err)
  }
}

/**
 * Aplica a decisao do QualityGovernor: quanto bitrate e quanta resolucao.
 *
 * Reduzir a resolucao quando a banda cai nao e desistir de qualidade — e o
 * contrario. Poucos pixels bem codificados sao assistiveis; muitos pixels com
 * bits de menos viram blocos.
 */
export async function applyQualityDecision(
  sender: RTCRtpSender,
  decision: { maxBitrateKbps: number; scaleResolutionDownBy: number }
): Promise<void> {
  if (!sender.track || sender.track.kind !== 'video') return
  const params = sender.getParameters() as SendParameters
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]

  params.encodings[0]!.maxBitrate = decision.maxBitrateKbps * 1000
  params.encodings[0]!.scaleResolutionDownBy = decision.scaleResolutionDownBy

  try {
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[rtc] applyQualityDecision falhou:', err)
  }
}

/**
 * Aperta ou solta a trilha de audio conforme o orcamento do momento.
 *
 * Feito por setParameters de proposito: mexer no `maxaveragebitrate` do SDP
 * exigiria renegociar, e renegociar por causa de uma oscilacao de rede
 * congelaria a imagem por segundos. Por aqui o estereo negociado continua
 * valendo e o bitrate volta ao valor do preset sozinho quando a banda melhora.
 */
export async function applyAudioBitrate(
  sender: RTCRtpSender,
  kbps: number
): Promise<void> {
  if (!sender.track || sender.track.kind !== 'audio') return
  const params = sender.getParameters() as SendParameters
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]

  const alvo = kbps * 1000
  if (params.encodings[0]!.maxBitrate === alvo) return
  params.encodings[0]!.maxBitrate = alvo

  try {
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[rtc] applyAudioBitrate falhou:', err)
  }
}

/**
 * contentHint diz ao encoder QUE TIPO de imagem ele esta comprimindo.
 * 'text'/'detail' ligam o screen content coding (texto nitido, sem borrar);
 * 'motion' prioriza fluidez, que e o certo para jogo e filme.
 */
export function applyContentHint(track: MediaStreamTrack, preset: QualityPreset): void {
  if (track.kind === 'video') track.contentHint = preset.contentHint
}

/**
 * Ordem de preferencia entre perfis de H.264 — e ela decide se a GPU entra.
 *
 * O Chromium roteia o Constrained Baseline (42e01f) para o encoder de SOFTWARE
 * (OpenH264) por razoes historicas e como rede de seguranca contra bugs de
 * driver. Os perfis High e Main sao os que chegam ao MediaFoundation, e portanto
 * ao NVENC/QuickSync.
 *
 * Consequencia pratica: pedir "o perfil mais compativel" e exatamente o que faz
 * a transmissao codificar na CPU e engasgar o jogo. Medido neste projeto —
 * preferir 42e01f dava OpenH264; preferir 640020 muda o encoder.
 */
const H264_PROFILE_ORDER = [
  '640', // High — melhor caminho para o encoder da GPU
  '4d0', // Main
  '420', // Baseline
  '42e' // Constrained Baseline — desvia para software
]

/**
 * Exportado para teste: esta ordem e a diferenca entre codificar na GPU e na
 * CPU, e nao ha nada no nome "42e01f" que denuncie isso para quem ler depois.
 */
export function h264ProfileRank(fmtp: string): number {
  const match = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp)
  if (!match) return H264_PROFILE_ORDER.length
  const prefix = match[1]!.slice(0, 3).toLowerCase()
  const index = H264_PROFILE_ORDER.indexOf(prefix)
  return index === -1 ? H264_PROFILE_ORDER.length : index
}

/**
 * Reordena os codecs oferecidos no SDP.
 * Retorna o mimeType que ficou em primeiro lugar (para exibir no HUD).
 */
export function preferCodecs(
  transceiver: RTCRtpTransceiver,
  preferred: string[]
): string | null {
  if (typeof transceiver.setCodecPreferences !== 'function') return null

  const capabilities = RTCRtpSender.getCapabilities('video')
  if (!capabilities) return null

  const score = (codec: RTCRtpCodec): number => {
    const index = preferred.findIndex(
      (mime) => codec.mimeType.toLowerCase() === mime.toLowerCase()
    )
    // Codec fora da lista do preset vai para o fim, mas continua na oferta:
    // remover seria arriscar nao ter nada em comum com o outro lado.
    if (index === -1) return 1000

    const fmtp = codec.sdpFmtpLine ?? ''
    let rank = index * 100

    if (/H264/i.test(codec.mimeType)) {
      rank += h264ProfileRank(fmtp) * 10
      // packetization-mode=1 permite fatiar NAL units grandes; o modo 0 limita
      // o tamanho do frame e piora a qualidade em resolucoes altas.
      rank += fmtp.includes('packetization-mode=1') ? 0 : 5
    }

    return rank
  }

  const sorted = [...capabilities.codecs].sort((a, b) => score(a) - score(b))

  try {
    transceiver.setCodecPreferences(sorted)
    return sorted[0]?.mimeType ?? null
  } catch (err) {
    console.warn('[rtc] setCodecPreferences falhou:', err)
    return null
  }
}

/**
 * Zera o buffer de reproducao do lado de quem assiste.
 *
 * Por padrao o navegador acumula centenas de milissegundos de video para
 * suavizar jitter — otimo para assistir Netflix, pessimo quando voce quer
 * conversar sobre o que esta na tela em tempo real.
 */
export function minimizePlayoutDelay(receiver: RTCRtpReceiver): void {
  const target = receiver as RTCRtpReceiver & {
    playoutDelayHint?: number
    jitterBufferTarget?: number
  }
  try {
    // jitterBufferTarget e o nome padronizado (ms); playoutDelayHint e o antigo (s).
    target.jitterBufferTarget = 0
    target.playoutDelayHint = 0
  } catch {
    // Navegador sem suporte: segue com o buffer padrao.
  }
}

/**
 * Desliga o processamento de voz na trilha de audio do sistema.
 *
 * ESTE E O ERRO QUE QUASE TODO APP DE WATCH PARTY COMETE. Por padrao o Chrome
 * assume que qualquer audio e voz de reuniao e liga cancelamento de eco, controle
 * automatico de ganho e supressao de ruido. Numa musica, num filme ou num jogo o
 * resultado e som abafado, com volume oscilando e instrumentos sumindo — o
 * sintoma que os usuarios descrevem como "o audio fica estranho".
 *
 * O microfone e o caso oposto: la o cancelamento de eco deve ficar LIGADO.
 */
export async function disableAudioProcessing(
  track: MediaStreamTrack
): Promise<MediaTrackSettings> {
  if (track.kind !== 'audio') return track.getSettings()
  try {
    await track.applyConstraints({
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false
    })
  } catch (err) {
    console.warn('[rtc] nao foi possivel desligar o processamento de audio:', err)
  }
  return track.getSettings()
}
