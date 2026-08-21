/**
 * Presets de qualidade.
 *
 * A ideia central: sob pressao de rede ou CPU, ALGUMA coisa tem que ser
 * sacrificada. Quem decide o que sacrificar deveria ser voce, nao o navegador —
 * e essa escolha e exatamente o que falta nos concorrentes.
 *
 *  - Codigo/planilha: nitidez importa mais que fluidez  -> maintain-resolution
 *  - Jogo: fluidez importa mais que nitidez             -> maintain-framerate
 *  - Filme: equilibrio                                  -> balanced
 */

export type DegradationPreference =
  | 'maintain-framerate'
  | 'maintain-resolution'
  | 'balanced'

/** 'detail' e 'text' ligam o modo screen-content do encoder (texto fica legivel). */
export type ContentHint = '' | 'motion' | 'detail' | 'text'

export interface QualityPreset {
  id: string
  label: string
  description: string
  maxBitrateKbps: number
  maxFramerate: number
  /** Altura alvo; o encoder reduz a resolucao se a tela for maior. */
  maxHeight: number
  contentHint: ContentHint
  degradationPreference: DegradationPreference
  /**
   * Ordem de preferencia de codec (mimeType do RTCRtpCapabilities).
   * H.264 costuma ter a menor latencia no Windows por usar o encoder da GPU;
   * VP9/AV1 entregam a mesma qualidade com bem menos banda, gastando mais CPU.
   */
  preferredCodecs: string[]
  /** Opus: estereo de verdade importa para jogo/filme, nao so para musica. */
  audioBitrateKbps: number
}

export const QUALITY_PRESETS: Record<string, QualityPreset> = {
  work: {
    id: 'work',
    label: 'Trabalho',
    description: 'Texto nitido. Prefere perder fluidez a borrar a tela.',
    maxBitrateKbps: 5000,
    maxFramerate: 30,
    maxHeight: 1440,
    contentHint: 'text',
    degradationPreference: 'maintain-resolution',
    preferredCodecs: ['video/H264', 'video/VP9', 'video/VP8'],
    audioBitrateKbps: 128
  },
  game: {
    id: 'game',
    label: 'Jogo',
    description: '1080p60 fluido. Prefere borrar a engasgar.',
    maxBitrateKbps: 10000,
    maxFramerate: 60,
    maxHeight: 1080,
    contentHint: 'motion',
    degradationPreference: 'maintain-framerate',
    preferredCodecs: ['video/H264', 'video/VP8', 'video/VP9'],
    audioBitrateKbps: 192
  },
  movie: {
    id: 'movie',
    label: 'Filme',
    description: '1080p com audio estereo de qualidade. Equilibrado.',
    maxBitrateKbps: 8000,
    maxFramerate: 30,
    maxHeight: 1080,
    contentHint: 'motion',
    degradationPreference: 'balanced',
    /**
     * H.264 aqui por MEDICAO, nao por tradicao.
     *
     * A tentacao era colocar AV1 primeiro — comprime muito melhor, e a GPU desta
     * maquina (RTX 40) tem encoder AV1 em hardware. Medido: o Chromium negocia
     * AV1 mas encoda com `libaom`, ou seja, na CPU. Em 1080p isso rouba
     * exatamente a CPU do jogo/filme que esta sendo transmitido.
     *
     * H.264 e o unico codec que chega ao encoder da GPU aqui
     * (MediaFoundation/NVENC), e GPU vale mais que eficiencia de compressao
     * quando a resolucao e alta.
     */
    preferredCodecs: ['video/H264', 'video/VP9', 'video/AV1'],
    audioBitrateKbps: 256
  },
  lowbandwidth: {
    id: 'lowbandwidth',
    label: 'Internet ruim',
    description: '720p30 economico. AV1 entrega muito mais imagem por megabit.',
    maxBitrateKbps: 2500,
    maxFramerate: 30,
    maxHeight: 720,
    contentHint: 'motion',
    degradationPreference: 'balanced',
    /**
     * Aqui AV1 na frente, e de proposito — o oposto dos outros presets.
     *
     * A troca inverte quando a banda e o gargalo: AV1 por software custa CPU,
     * mas comprime cerca de 45% melhor que VP9 (e, segundo o Chrome, roda ate
     * mais rapido nas velocidades usadas em tempo real). Em 720p a conta fecha:
     * sobra CPU e falta megabit, entao vale gastar processador para economizar
     * banda. Em 1080p a conta se inverte, e por isso os outros presets usam
     * H.264 na GPU.
     */
    preferredCodecs: ['video/AV1', 'video/VP9', 'video/H264'],
    audioBitrateKbps: 96
  }
}

export const DEFAULT_PRESET_ID = 'game'

export function getPreset(id: string | undefined): QualityPreset {
  return QUALITY_PRESETS[id ?? DEFAULT_PRESET_ID] ?? QUALITY_PRESETS[DEFAULT_PRESET_ID]!
}

export const PRESET_LIST: QualityPreset[] = Object.values(QUALITY_PRESETS)
