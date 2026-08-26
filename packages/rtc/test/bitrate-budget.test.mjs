/**
 * Testes do orcamento de banda.
 *
 * Dois casos de referencia, os dois vindos de testes reais que deram errado:
 *
 *  1. 101 kbps saindo a 1920x1032 — poucos bits espalhados por pixels demais.
 *  2. 88 kbps de audio e 3 kbps de video no mesmo link — o audio servindo-se
 *     primeiro e nao sobrando nada para a imagem.
 *
 * Nenhum dos dois pode voltar a acontecer, e nenhum dos dois da erro em lugar
 * nenhum: os dois aparecem so como "a imagem esta horrivel". Daí os testes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COOLDOWN_DOWN_MS,
  COOLDOWN_UP_MS,
  MIN_RENDERED_CAP_HEIGHT,
  MIN_VIDEO_KBPS,
  QualityGovernor,
  audioBudgetFor,
  evenFriendlyScale,
  decideQuality,
  describeQuality,
  tierForBitrate
} from '../dist/bitrate-budget.js'

const preset1080 = {
  presetMaxHeight: 1080,
  presetMaxKbps: 8000,
  presetAudioKbps: 256
}
const semAudioSaindo = { sendingAudioKbps: 0 }

/** A maioria dos testes usa uma fonte 16:9 comum. */
const fonte1080 = { sourceWidth: 1920, sourceHeight: 1080 }

test('o caso real: 101 kbps a 1080p vira 360p', () => {
  const d = decideQuality({
    availableKbps: 101,
    sendingKbps: 101,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    sourceWidth: 1834,
    sourceHeight: 1032,
    ...preset1080
  })

  assert.equal(d.targetHeight, 360)
  assert.equal(d.reason, 'banda')
  assert.ok(d.scaleResolutionDownBy > 2.5, 'precisa reduzir bastante a escala')
  assert.ok(d.maxBitrateKbps <= 101, 'nao adianta pedir mais do que existe')
})

test('o SEGUNDO caso real: o audio nao pode comer o link inteiro', () => {
  // Reproduz o teste com amigos: ~100 kbps de link total, audio do preset
  // "Filme" fixo em 256 kbps. Antes: 88 kbps de audio e 3 de video.
  const d = decideQuality({
    availableKbps: 100,
    sendingKbps: 3,
    sendingAudioKbps: 88,
    limitation: 'bandwidth',
    sourceWidth: 1834,
    sourceHeight: 1032,
    ...preset1080
  })

  assert.equal(d.audioKbps, 48, 'com o link neste tamanho o audio tem que encolher')
  assert.ok(
    d.maxBitrateKbps >= MIN_VIDEO_KBPS,
    `o video precisa sobrar com pelo menos ${MIN_VIDEO_KBPS} kbps, veio ${d.maxBitrateKbps}`
  )
  assert.equal(d.targetHeight, 360)
})

test('com banda de sobra, o audio volta ao valor do preset', () => {
  const d = decideQuality({
    availableKbps: 9000,
    sendingKbps: 7000,
    sendingAudioKbps: 256,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  assert.equal(d.audioKbps, 256, 'estereo de verdade e o ponto forte do app')
  assert.equal(d.targetHeight, 1080)
  assert.equal(d.scaleResolutionDownBy, 1)
  assert.equal(d.reason, 'preset')
})

test('a escada do audio desce em degraus, e o preset e sempre o teto', () => {
  assert.equal(audioBudgetFor(5000, 256), 256)
  assert.equal(audioBudgetFor(1000, 256), 128)
  assert.equal(audioBudgetFor(500, 256), 96)
  assert.equal(audioBudgetFor(200, 256), 64)
  assert.equal(audioBudgetFor(80, 256), 48)
  // Preset economico com banda sobrando NAO deve subir para 128.
  assert.equal(audioBudgetFor(5000, 96), 96)
  assert.equal(audioBudgetFor(200, 96), 64)
})

test('a escada de resolucao respeita os degraus', () => {
  assert.equal(tierForBitrate(6000).height, 1080)
  assert.equal(tierForBitrate(3000).height, 900)
  assert.equal(tierForBitrate(1500).height, 720)
  assert.equal(tierForBitrate(700).height, 540)
  assert.equal(tierForBitrate(350).height, 432)
  assert.equal(tierForBitrate(10).height, 360)
})

test('o preset continua sendo um teto, nunca um piso', () => {
  const d = decideQuality({
    availableKbps: 50_000,
    sendingKbps: 20_000,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 3840,
    sourceHeight: 2160,
    presetMaxHeight: 720,
    presetMaxKbps: 2500,
    presetAudioKbps: 96
  })

  assert.equal(d.targetHeight, 720, 'nao pode passar do teto escolhido pelo usuario')
  assert.ok(d.maxBitrateKbps <= 2500)
  assert.equal(d.audioKbps, 96)
})

test('nunca aumenta a resolucao alem da fonte', () => {
  const d = decideQuality({
    availableKbps: 9000,
    sendingKbps: 9000,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 854,
    sourceHeight: 480,
    ...preset1080
  })

  assert.equal(d.targetHeight, 480)
  assert.equal(d.scaleResolutionDownBy, 1, 'nao faz upscale')
})

test('sem medida ainda, parte do preset e espera a primeira amostra', () => {
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 0,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  assert.equal(d.reason, 'sem-medida')
  assert.equal(d.targetHeight, 1080)
  assert.equal(d.audioKbps, 256)
})

test('tela parada NAO derruba a resolucao', () => {
  // Regressao de um bug pego em teste: a tela estava imovel, o encoder mandava
  // 74 kbps porque nao havia o que codificar, e o app leu isso como "internet
  // ruim" e caiu para 360p — num link local, sem gargalo nenhum. Numa cena
  // escura de filme aconteceria o mesmo.
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 74,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  assert.equal(d.targetHeight, 1080, 'bitrate baixo sem gargalo nao e motivo para reduzir')
  assert.equal(d.reason, 'sem-medida')
})

test('bitrate baixo COM gargalo de banda derruba mesmo', () => {
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 74,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  assert.equal(d.targetHeight, 360, 'aqui o proprio encoder confirmou o gargalo')
  assert.equal(d.reason, 'banda')
})

test('sem estimativa, a medida soma video E audio', () => {
  // Usar so o bitrate de video subestimaria o link inteiro pela largura da
  // trilha de som — e faria o app cortar resolucao que nao precisava cortar.
  const soVideo = decideQuality({
    availableKbps: 0,
    sendingKbps: 800,
    sendingAudioKbps: 0,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })
  const comAudio = decideQuality({
    availableKbps: 0,
    sendingKbps: 800,
    sendingAudioKbps: 900,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  assert.ok(
    comAudio.maxBitrateKbps > soVideo.maxBitrateKbps,
    'o audio que ja esta saindo faz parte do que o link comporta'
  )
})

test('gargalo de CPU nao e tratado como falta de banda', () => {
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 500,
    ...semAudioSaindo,
    limitation: 'cpu',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })

  // Reduzir resolucao ate ajuda a CPU, mas a decisao aqui e nao inventar uma
  // medida de rede que nao existe. Quem trata CPU e o preset/framerate.
  assert.equal(d.reason, 'sem-medida')
})

test('o teto por espectador divide o upload', () => {
  const sozinho = decideQuality({
    availableKbps: 6000,
    sendingKbps: 5000,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })
  const dividido = decideQuality({
    availableKbps: 6000,
    sendingKbps: 5000,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    capKbps: 2000,
    ...preset1080
  })

  assert.ok(sozinho.maxBitrateKbps > 5000)
  assert.ok(dividido.maxBitrateKbps <= 2000, 'a fatia e um teto duro')
  assert.equal(dividido.reason, 'dividido')
})

test('o piso autorizado levanta uma estimativa pessimista', () => {
  const semPiso = decideQuality({
    availableKbps: 400,
    sendingKbps: 400,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })
  const comPiso = decideQuality({
    availableKbps: 400,
    sendingKbps: 400,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    floorKbps: 4000,
    ...preset1080
  })

  // 400 kbps totais: 96 vao para o audio e sobram 304 para o video — abaixo dos
  // 350 que o degrau de 432p exige.
  assert.equal(semPiso.targetHeight, 360)
  assert.equal(comPiso.targetHeight, 900, 'quem autorizou a banda quer usa-la')
})

test('o teto declarado vale ANTES da primeira medida', () => {
  // Pego numa sessao real: com "Eu digo quanto = 0,15 Mbps" o audio encolhia na
  // hora, mas o video seguia em 1080p porque `sem medida` mandava usar o preset
  // inteiro. Quem digita o proprio upload esta dando uma medida.
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 0,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    capKbps: 150,
    ...preset1080
  })

  assert.equal(d.audioKbps, 48)
  assert.equal(d.targetHeight, 360, 'o teto do usuario tem que valer para a imagem tambem')
  assert.ok(d.maxBitrateKbps <= 150)
  assert.equal(d.reason, 'dividido')
})

test('o piso nao inventa banda quando nao ha medida nenhuma', () => {
  const d = decideQuality({
    availableKbps: 0,
    sendingKbps: 0,
    ...semAudioSaindo,
    limitation: 'none',
    sourceWidth: 1920,
    sourceHeight: 1080,
    floorKbps: 4000,
    ...preset1080
  })
  assert.equal(d.reason, 'sem-medida')
})

test('a primeira decisao sempre passa', () => {
  const g = new QualityGovernor()
  const d = g.update(
    {
      availableKbps: 5000,
      sendingKbps: 4000,
      ...semAudioSaindo,
      limitation: 'none',
      sourceWidth: 1920,
    sourceHeight: 1080,
      ...preset1080
    },
    1000
  )
  assert.ok(d, 'a primeira decisao nao pode ser engolida pela histerese')
  assert.equal(d.targetHeight, 900)
})

test('descer e rapido; subir e lento', () => {
  const g = new QualityGovernor()
  const base = { ...fonte1080, ...semAudioSaindo, ...preset1080 }
  let t = 0

  g.update({ availableKbps: 8000, sendingKbps: 8000, limitation: 'none', ...base }, t)
  assert.equal(g.decision.targetHeight, 1080)

  // A rede piora. Logo depois do tempo de descida, a queda e aplicada.
  t += COOLDOWN_DOWN_MS + 1
  const queda = g.update({ availableKbps: 200, sendingKbps: 200, limitation: 'none', ...base }, t)
  assert.ok(queda, 'queda de qualidade deve ser aplicada rapido')
  assert.equal(queda.targetHeight, 360)

  // A rede melhora, mas subir logo em seguida seria oscilacao.
  t += COOLDOWN_DOWN_MS + 1
  const subidaCedo = g.update({ availableKbps: 8000, sendingKbps: 8000, limitation: 'none', ...base }, t)
  assert.equal(subidaCedo, null, 'nao pode subir antes do tempo de subida')

  // Passado o tempo de subida, aí sim.
  t += COOLDOWN_UP_MS
  const subida = g.update({ availableKbps: 8000, sendingKbps: 8000, limitation: 'none', ...base }, t)
  assert.ok(subida, 'depois da espera, deve voltar a subir')
  assert.equal(subida.targetHeight, 1080)
})

test('cortar o audio NAO espera a histerese', () => {
  // Enquanto o audio estiver grande demais para o link, o video nao tem de onde
  // sair. Esperar 5 s para apertar o audio e esperar 5 s de imagem congelada.
  const g = new QualityGovernor()
  const base = { ...fonte1080, ...semAudioSaindo, ...preset1080 }

  g.update({ availableKbps: 8000, sendingKbps: 8000, limitation: 'none', ...base }, 0)
  assert.equal(g.decision.audioKbps, 256)

  const corte = g.update(
    { availableKbps: 120, sendingKbps: 120, limitation: 'bandwidth', ...base },
    1
  )
  assert.ok(corte, 'o corte do audio tem que ser imediato')
  assert.equal(corte.audioKbps, 48)
})

test('variacao pequena nao mexe no encoder', () => {
  const g = new QualityGovernor()
  const base = { ...fonte1080, ...semAudioSaindo, ...preset1080 }
  g.update({ availableKbps: 4000, sendingKbps: 4000, limitation: 'none', ...base }, 0)

  const igual = g.update(
    { availableKbps: 4050, sendingKbps: 4000, limitation: 'none', ...base },
    100_000
  )
  assert.equal(igual, null, 'ruido de medicao nao pode virar troca de resolucao')
})

test('a explicacao muda quando ha mais de um espectador', () => {
  const d = decideQuality({
    availableKbps: 400,
    sendingKbps: 400,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    sourceWidth: 1920,
    sourceHeight: 1080,
    ...preset1080
  })
  assert.match(describeQuality(d, 1), /upload/)
  assert.match(describeQuality(d, 3), /3 pessoas/)
  assert.match(describeQuality(d, 1), /audio \d+ kbps/, 'o painel precisa dizer o audio tambem')
})

test('a escala sempre produz largura E altura pares', () => {
  /**
   * Regressao de um log de sessao real, cheio de:
   *   "Input video size is 803x432, but hardware H.264 encoder only supports
   *    even sized frames."
   *
   * O Chromium nao falha de forma visivel quando isso acontece — ele cai para o
   * encoder de software, gasta CPU e engasga. Nada na interface denuncia.
   *
   * As larguras abaixo sao as que apareceram no log: janelas de tamanho
   * arbitrario, que e o caso em que a conta ingenua quebra.
   */
  const fontes = [
    [1487, 800],
    [1670, 897],
    [1343, 722],
    [895, 481],
    [1113, 598],
    [1067, 600],
    [1920, 1080],
    [1834, 1032],
    [2560, 1440]
  ]

  for (const [w, h] of fontes) {
    for (const alvo of [1080, 900, 720, 540, 432, 360]) {
      const escala = evenFriendlyScale(w, h, alvo)
      const saidaW = Math.round(w / escala)
      const saidaH = Math.round(h / escala)
      assert.equal(saidaW % 2, 0, `${w}x${h} alvo ${alvo}: largura ${saidaW} e impar`)
      assert.equal(saidaH % 2, 0, `${w}x${h} alvo ${alvo}: altura ${saidaH} e impar`)
      assert.ok(escala >= 1, 'nunca faz upscale')
    }
  }
})

test('a escala nao encolhe mais do que o necessario', () => {
  // 1920x1080 -> 720p e um caso redondo: tem que sair exatamente 1.5.
  assert.equal(evenFriendlyScale(1920, 1080, 720), 1.5)
  assert.equal(evenFriendlyScale(1920, 1080, 360), 3)
  // Alvo maior ou igual a fonte nao mexe em nada.
  assert.equal(evenFriendlyScale(1280, 720, 720), 1)
  assert.equal(evenFriendlyScale(1280, 720, 1080), 1)
})

test('a altura entregue fica perto da pedida', () => {
  // Ceder alguns pixels para ganhar o encoder da GPU e o negocio; ceder muitos
  // seria trocar um problema por outro.
  for (const [w, h] of [[1487, 800], [1670, 897], [1113, 598]]) {
    for (const alvo of [720, 540, 432, 360]) {
      const escala = evenFriendlyScale(w, h, alvo)
      const saidaH = Math.round(h / escala)
      if (alvo >= h) continue
      assert.ok(
        saidaH <= alvo && saidaH >= alvo - 12,
        `${w}x${h} alvo ${alvo}: saiu ${saidaH}, longe demais`
      )
    }
  }
})

test('quem assiste numa janela pequena nao custa 1080p', () => {
  /**
   * A otimizacao de maior impacto que existe aqui: mandar 1080p para um
   * elemento de 600 px joga fora a maior parte dos pixels codificados, no
   * upload E na CPU de quem transmite. Quem assiste na janelinha nao ganha nada
   * com isso; so o host paga.
   */
  const banda = {
    availableKbps: 9000,
    sendingKbps: 7000,
    ...semAudioSaindo,
    limitation: 'none',
    ...fonte1080,
    ...preset1080
  }

  const telaCheia = decideQuality(banda)
  const janelinha = decideQuality({ ...banda, renderedHeight: 600 })

  assert.equal(telaCheia.targetHeight, 1080)
  assert.equal(janelinha.targetHeight, 600, 'a altura tem que seguir o tile')
  assert.ok(
    janelinha.scaleResolutionDownBy > telaCheia.scaleResolutionDownBy,
    'menos pixels codificados'
  )
})

test('o corte por tamanho de tela tem piso, e ele e caro de proposito', () => {
  // Ao pe da letra, um tile de 216 px pediria 216p. Mas tela compartilhada
  // ilegivel nao e transmissao barata, e transmissao desperdicada.
  const d = decideQuality({
    availableKbps: 9000,
    sendingKbps: 7000,
    ...semAudioSaindo,
    limitation: 'none',
    ...fonte1080,
    renderedHeight: 216,
    ...preset1080
  })

  assert.equal(d.targetHeight, MIN_RENDERED_CAP_HEIGHT)
  assert.equal(MIN_RENDERED_CAP_HEIGHT, 540)
})

test('falta de banda ainda desce abaixo do piso do tile', () => {
  // Sao coisas diferentes: o tile diz "nao precisa", a banda diz "nao cabe".
  // A segunda tem que continuar mandando.
  const d = decideQuality({
    availableKbps: 120,
    sendingKbps: 120,
    ...semAudioSaindo,
    limitation: 'bandwidth',
    ...fonte1080,
    renderedHeight: 1080,
    ...preset1080
  })

  assert.equal(d.targetHeight, 360, 'a banda manda mais que o tamanho do tile')
})

test('tile nao informado nao muda nada', () => {
  // Aba oculta, layout ainda nao aconteceu, viewer antigo: na duvida, o host
  // nao corta. Presumir zero prenderia a transmissao na pior qualidade.
  const base = {
    availableKbps: 9000,
    sendingKbps: 7000,
    ...semAudioSaindo,
    limitation: 'none',
    ...fonte1080,
    ...preset1080
  }

  assert.equal(decideQuality(base).targetHeight, 1080)
  assert.equal(decideQuality({ ...base, renderedHeight: 0 }).targetHeight, 1080)
})

test('a estimativa do ICE e piso, nao teto', () => {
  /**
   * A estimativa so aprende que o link aguenta mais quando ele carrega mais —
   * o que fecha um laco: rebaixou, entao passa pouco, entao a estimativa fica
   * baixa, entao continua rebaixado. Se 2 Mbps estao comprovadamente saindo, o
   * link carrega pelo menos 2 Mbps.
   */
  const d = decideQuality({
    availableKbps: 500,
    sendingKbps: 3800,
    sendingAudioKbps: 200,
    limitation: 'none',
    ...fonte1080,
    ...preset1080
  })

  assert.ok(
    d.maxBitrateKbps > 500,
    `o que ja esta saindo e evidencia de capacidade, veio ${d.maxBitrateKbps}`
  )
  assert.equal(d.targetHeight, 900)
})

test('mas quando o encoder acusa a banda, a estimativa vence', () => {
  // Aqui o que esta saindo pode ser justamente o excesso que causa perda.
  const d = decideQuality({
    availableKbps: 500,
    sendingKbps: 3800,
    sendingAudioKbps: 200,
    limitation: 'bandwidth',
    ...fonte1080,
    ...preset1080
  })

  assert.ok(d.maxBitrateKbps <= 500, `deveria obedecer a estimativa, veio ${d.maxBitrateKbps}`)
})
