/**
 * Decide QUANTA banda vai para o audio e QUAL resolucao cabe no que sobra.
 *
 * Este arquivo nasceu de um teste real que deu errado: com a estimativa de banda
 * em 101 kbps, o app continuou enviando 1920x1032. Cem kilobits espalhados sobre
 * dois milhoes de pixels viram um mosaico — enquanto os mesmos 101 kbps em 360p
 * produzem uma imagem perfeitamente assistivel.
 *
 * A causa era conceitual: `maxBitrate` e apenas um TETO, nunca um piso, e o
 * `scaleResolutionDownBy` saia do preset escolhido pelo usuario, que nao sabe
 * nada sobre a rede do momento. Aqui a direcao se inverte — a banda medida
 * escolhe a resolucao.
 *
 * O SEGUNDO teste real expos a outra metade do problema, mais grave: o audio
 * estava fixo em 256 kbps e nunca adaptava. Como o WebRTC atende o audio ANTES
 * do video na alocacao de banda, num link de ~100 kbps ele se servia primeiro e
 * sobravam 3 kbps para a imagem. Os numeros batiam: o host mostrava 3 kbps (so
 * video) e quem assistia relatava 91 kbps (video + audio). Por isso o orcamento
 * aqui e UNICO e o audio e descontado antes de escolher a resolucao.
 */

export interface ResolutionTier {
  height: number
  /** Banda minima de VIDEO para esta altura fazer sentido. */
  minKbps: number
  label: string
}

/**
 * Escada de resolucoes.
 *
 * Os limites vieram da regra pratica de bits por pixel: abaixo de ~0,1 bit por
 * pixel por quadro a compressao passa a destruir a imagem em vez de comprimi-la.
 * Preferir sempre "menos pixels nitidos" a "muitos pixels borrados".
 */
export const RESOLUTION_LADDER: ResolutionTier[] = [
  { height: 1080, minKbps: 6000, label: '1080p' },
  { height: 900, minKbps: 3000, label: '900p' },
  { height: 720, minKbps: 1500, label: '720p' },
  { height: 540, minKbps: 700, label: '540p' },
  { height: 432, minKbps: 350, label: '432p' },
  { height: 360, minKbps: 0, label: '360p' }
]

export function tierForBitrate(kbps: number): ResolutionTier {
  return (
    RESOLUTION_LADDER.find((tier) => kbps >= tier.minKbps) ??
    RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1]!
  )
}

export interface AudioTier {
  minTotalKbps: number
  /** 0 significa "use o valor do preset". */
  audioKbps: number
}

/**
 * Escada do audio, em funcao do orcamento TOTAL da conexao.
 *
 * Com banda sobrando nao ha razao para economizar em som — trilha de filme em
 * 256 kbps estereo e um dos pontos fortes do app. A escada so entra em acao
 * quando o link aperta, e a ordem de sacrificio e deliberada: 128 kbps ainda e
 * musica boa, 96 e aceitavel, 64 ja e voz decente e 48 e o minimo para nao virar
 * radio AM. Abaixo disso o ganho para o video nao compensa o estrago no som.
 */
export const AUDIO_LADDER: AudioTier[] = [
  { minTotalKbps: 1500, audioKbps: 0 },
  { minTotalKbps: 700, audioKbps: 128 },
  { minTotalKbps: 350, audioKbps: 96 },
  { minTotalKbps: 160, audioKbps: 64 },
  { minTotalKbps: 0, audioKbps: 48 }
]

/**
 * O preset e sempre um TETO, nunca um alvo: o preset "Internet ruim" pede 96
 * kbps de audio, e uma conexao boa nao deve elevar isso para 128 so porque cabe.
 */
export function audioBudgetFor(totalKbps: number, presetAudioKbps: number): number {
  const tier =
    AUDIO_LADDER.find((t) => totalKbps >= t.minTotalKbps) ??
    AUDIO_LADDER[AUDIO_LADDER.length - 1]!
  const alvo = tier.audioKbps === 0 ? presetAudioKbps : tier.audioKbps
  return Math.min(alvo, presetAudioKbps)
}

/**
 * Piso do video. Abaixo disto o encoder nao consegue nem manter 360p vivo, e
 * roubar mais alguns kbps do audio nao salvaria a imagem — so pioraria o som.
 */
export const MIN_VIDEO_KBPS = 60

/** Nao vale a pena descer abaixo disto procurando dimensao par. */
const MIN_TARGET_HEIGHT = 144

/**
 * Escolhe uma escala cujo resultado tenha LARGURA E ALTURA PARES.
 *
 * O encoder H.264 por hardware recusa frames de dimensao impar. Quando isso
 * acontece o Chromium nao falha de forma visivel — ele reclama no log e cai
 * para o encoder de software, que gasta CPU e engasga. Numa sessao real o log
 * ficou cheio de linhas como:
 *
 *   Input video size is 803x432, but hardware H.264 encoder only supports
 *   even sized frames.
 *
 * A causa e a conta ingenua `escala = alturaDaFonte / alturaAlvo`. Com 1920x1080
 * ela cai em numeros redondos (1.5 -> 1280x720) e ninguem percebe o problema.
 * Mas compartilhando uma JANELA, cuja largura e qualquer coisa (1487, 1670,
 * 1343...), a largura derivada sai impar quase sempre.
 *
 * A busca desce de duas em duas linhas ate achar uma altura cuja largura
 * derivada tambem seja par. Perde-se no maximo alguns pixels de altura; ganha-se
 * o encoder da GPU de volta.
 */
export function evenFriendlyScale(
  sourceWidth: number,
  sourceHeight: number,
  targetHeight: number
): number {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetHeight <= 0) return 1

  /**
   * A busca comeca na MENOR entre a altura pedida e a da fonte — e nao para na
   * fonte.
   *
   * Uma janela de 1487x800 tem largura impar na resolucao nativa: mesmo sem
   * nenhuma reducao, o encoder por hardware ja recusa o frame. Nesse caso o
   * certo e encolher 4 pixels e manter a GPU, nao mandar o tamanho "original"
   * e cair para software.
   */
  for (
    let h = Math.min(targetHeight, sourceHeight) & ~1;
    h >= MIN_TARGET_HEIGHT;
    h -= 2
  ) {
    // Arredondar ANTES de conferir: e o valor arredondado que vai para o
    // encoder, entao e ele que precisa produzir dimensoes pares.
    const escala = Math.round((sourceHeight / h) * 1000) / 1000
    if (escala < 1) continue
    if (
      Math.round(sourceWidth / escala) % 2 === 0 &&
      Math.round(sourceHeight / escala) % 2 === 0
    ) {
      return escala
    }
  }

  // Nenhuma combinacao par: fica com a conta direta, que e o comportamento
  // antigo — pior que o ideal, mas nunca pior do que era.
  return Math.max(1, Math.round((sourceHeight / targetHeight) * 100) / 100)
}

export interface QualityInput {
  /** Estimativa da conexao (kbps). 0 quando ainda nao ha medida. */
  availableKbps: number
  /** Video saindo agora (kbps). */
  sendingKbps: number
  /** Audio saindo agora (kbps) — parte do mesmo orcamento que o video. */
  sendingAudioKbps: number
  /**
   * O que o proprio encoder diz estar limitando: 'none' | 'bandwidth' | 'cpu' | 'other'.
   *
   * Isto e essencial e nao obvio: bitrate baixo NAO significa rede ruim. Uma tela
   * parada, ou uma cena escura de filme, comprime para quase nada com a rede
   * inteira disponivel. Sem este sinal, o app confundiria "nao ha o que enviar"
   * com "nao da para enviar" e derrubaria a resolucao sem motivo — o que chegou
   * a acontecer em teste: 360p num link local sem nenhum gargalo.
   */
  limitation: string | null
  /** Largura real da fonte capturada. */
  sourceWidth: number
  /** Altura real da fonte capturada. */
  sourceHeight: number
  /** Teto de altura do preset escolhido pelo usuario. */
  presetMaxHeight: number
  /** Teto de bitrate de VIDEO do preset. */
  presetMaxKbps: number
  /** Teto de bitrate de audio do preset. */
  presetAudioKbps: number
  /**
   * Piso de banda que o usuario autorizou explicitamente ("usar toda a minha
   * internet"). Sobrepoe uma estimativa pessimista; a trava de perda em
   * host-session e quem o retira quando ele passa a machucar.
   */
  floorKbps?: number
  /** Teto vindo da divisao do upload entre os espectadores ativos. */
  capKbps?: number
}

export interface QualityDecision {
  targetHeight: number
  maxBitrateKbps: number
  audioKbps: number
  scaleResolutionDownBy: number
  label: string
  /** Por que esta resolucao — para o painel poder explicar ao usuario. */
  reason: 'banda' | 'preset' | 'sem-medida' | 'dividido'
}

/**
 * A banda de referencia e a estimativa da conexao quando existe; senao, o que
 * esta realmente saindo. Nunca o teto do preset — foi exatamente esse otimismo
 * que produziu 1080p a 101 kbps.
 */
export function decideQuality(input: QualityInput): QualityDecision {
  const {
    availableKbps,
    sendingKbps,
    sendingAudioKbps,
    limitation,
    sourceWidth,
    sourceHeight,
    presetMaxHeight,
    presetMaxKbps,
    presetAudioKbps,
    floorKbps = 0,
    capKbps = 0
  } = input

  /**
   * Ordem dos sinais, do mais confiavel para o menos:
   *
   * 1. A estimativa da conexao (availableOutgoingBitrate) — mede a rede de fato.
   * 2. Se ela nao existe, o que esta saindo SO vale como medida quando o encoder
   *    declara estar limitado pela banda. E precisa somar video + audio: usar so
   *    o video subestimaria o link inteiro pela largura da trilha de som.
   * 3. Caso contrario, nao ha evidencia de gargalo: fica no preset.
   */
  const limitadoPelaBanda = limitation === 'bandwidth'
  const medidaBruta =
    availableKbps > 0
      ? availableKbps
      : limitadoPelaBanda
        ? sendingKbps + sendingAudioKbps
        : 0

  // O piso autorizado pelo usuario so vale onde ja existe alguma medida para
  // corrigir; sem medida nenhuma, o caminho de "sem-medida" ja usa o preset.
  const medida = medidaBruta > 0 ? Math.max(medidaBruta, floorKbps) : 0
  const semMedida = medida <= 0

  const tetoTotal = presetMaxKbps + presetAudioKbps
  const totalBruto = semMedida ? tetoTotal : Math.min(medida, tetoTotal)
  // Teto por espectador: o upload e um so e precisa ser dividido.
  const total = capKbps > 0 ? Math.min(totalBruto, capKbps) : totalBruto

  const audioKbps = audioBudgetFor(total, presetAudioKbps)

  /**
   * Um teto declarado pelo usuario vale mesmo ANTES de existir medida.
   *
   * Pego em teste: com "Eu digo quanto = 0,15 Mbps" o audio encolhia na hora,
   * mas o video continuava saindo em 1080p — porque `sem medida` mandava usar o
   * preset inteiro. Quem digita o proprio upload esta dando uma medida; ignora-la
   * ate a rede reclamar e repetir, em menor escala, o erro que originou este
   * arquivo.
   */
  const temTeto = !semMedida || capKbps > 0
  const videoBudget = temTeto
    ? Math.max(MIN_VIDEO_KBPS, Math.min(presetMaxKbps, total - audioKbps))
    : presetMaxKbps

  const tier = tierForBitrate(videoBudget)
  const targetHeight = Math.min(tier.height, presetMaxHeight, sourceHeight || tier.height)

  // scaleResolutionDownBy e razao, nao altura: 1 = tamanho original.
  const scale = evenFriendlyScale(sourceWidth, sourceHeight, targetHeight)

  // "Sem medida" continua sendo um estado proprio: e a diferenca entre "ainda
  // nao sei" e "sei, e cabe". So deixa de valer quando o usuario declarou um teto.
  const reason: QualityDecision['reason'] =
    semMedida && capKbps <= 0
      ? 'sem-medida'
      : videoBudget >= presetMaxKbps
        ? 'preset'
        : capKbps > 0 && totalBruto > capKbps
          ? 'dividido'
          : 'banda'

  return {
    targetHeight,
    maxBitrateKbps: Math.round(videoBudget),
    audioKbps,
    scaleResolutionDownBy: scale,
    label: tier.label,
    reason
  }
}

/**
 * Aplica as decisoes com histerese.
 *
 * Trocar de resolucao a cada amostra deixaria a imagem piscando entre nitidez e
 * borrao — pior de assistir do que ficar num degrau so. Descer e rapido (a
 * experiencia ja esta ruim, nao ha o que preservar); subir e lento, para nao
 * voltar a cair no primeiro solavanco da rede.
 */
export const COOLDOWN_DOWN_MS = 5_000
export const COOLDOWN_UP_MS = 15_000

export class QualityGovernor {
  private current: QualityDecision | null = null
  private lastChangeAt = 0

  get decision(): QualityDecision | null {
    return this.current
  }

  /** Retorna a nova decisao apenas quando ela deve ser aplicada; senao, null. */
  update(input: QualityInput, now = Date.now()): QualityDecision | null {
    const proxima = decideQuality(input)

    if (!this.current) {
      this.current = proxima
      this.lastChangeAt = now
      return proxima
    }

    const mesmaAltura = proxima.targetHeight === this.current.targetHeight
    const mesmoAudio = proxima.audioKbps === this.current.audioKbps
    const bitrateParecido =
      Math.abs(proxima.maxBitrateKbps - this.current.maxBitrateKbps) <
      this.current.maxBitrateKbps * 0.2

    if (mesmaAltura && mesmoAudio && bitrateParecido) return null

    /**
     * Cortar o audio e urgente e NAO espera histerese: enquanto ele estiver
     * grande demais para o link, o video fica sem nada e a imagem nao volta
     * sozinha. Aumentar o audio, sim, respeita a espera normal.
     */
    const audioEncolhendo = proxima.audioKbps < this.current.audioKbps
    const descendo = proxima.targetHeight < this.current.targetHeight
    const espera = audioEncolhendo ? 0 : descendo ? COOLDOWN_DOWN_MS : COOLDOWN_UP_MS
    if (now - this.lastChangeAt < espera) return null

    this.current = proxima
    this.lastChangeAt = now
    return proxima
  }
}

/** Texto curto para o painel explicar por que a qualidade esta onde esta. */
export function describeQuality(decision: QualityDecision, viewers: number): string {
  const audio = ` · audio ${decision.audioKbps} kbps`
  switch (decision.reason) {
    case 'dividido':
      return viewers > 1
        ? `${decision.label} — upload dividido entre ${viewers} pessoas${audio}`
        : `${decision.label} — dentro do limite de upload que voce definiu${audio}`
    case 'banda':
      return viewers > 1
        ? `${decision.label} — seu upload dividido entre ${viewers} pessoas nao comporta mais${audio}`
        : `${decision.label} — limitado pelo seu upload${audio}`
    case 'preset':
      return `${decision.label} — no maximo do preset escolhido${audio}`
    default:
      return `${decision.label} — medindo a rede${audio}`
  }
}
