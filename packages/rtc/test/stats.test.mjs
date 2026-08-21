/**
 * Testes da leitura de estatisticas.
 *
 * Existem por causa de um numero que apareceu num teste real e nao fazia
 * sentido: "perda 28,6%" numa conexao com RTT de 25 ms. A perda era ficcao — o
 * numerador somava os pacotes perdidos das TRES trilhas (video, som do sistema
 * e voz) enquanto o denominador tinha so os pacotes de video. Com o video a 10
 * fps, o denominador era minusculo.
 *
 * O estrago nao foi o numero errado na tela: foi ter apontado para a rede
 * quando o problema era o audio afogando o video. Metrica errada manda a
 * investigacao inteira para o lado errado, e por isso ela merece teste.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { StatsCollector } from '../dist/stats.js'

/** RTCPeerConnection de mentira: so precisa saber devolver relatorios. */
function fakePc(relatorios) {
  let i = 0
  return {
    async getStats() {
      const atual = relatorios[Math.min(i++, relatorios.length - 1)]
      return new Map(atual.map((stat) => [stat.id, stat]))
    }
  }
}

/** Um instante de uma sessao com as tres trilhas que o app sempre cria. */
function relatorio({ videoPkt, videoLost, audioPkt, audioLost, videoBytes, audioBytes }) {
  return [
    {
      id: 'out-v',
      type: 'outbound-rtp',
      kind: 'video',
      ssrc: 111,
      bytesSent: videoBytes,
      packetsSent: videoPkt,
      framesPerSecond: 10,
      frameWidth: 334,
      frameHeight: 180,
      qualityLimitationReason: 'bandwidth'
    },
    {
      id: 'out-a',
      type: 'outbound-rtp',
      kind: 'audio',
      ssrc: 222,
      bytesSent: audioBytes,
      packetsSent: audioPkt
    },
    {
      id: 'out-voz',
      type: 'outbound-rtp',
      kind: 'audio',
      ssrc: 333,
      bytesSent: 0,
      packetsSent: 0
    },
    { id: 'rem-v', type: 'remote-inbound-rtp', kind: 'video', ssrc: 111, packetsLost: videoLost, roundTripTime: 0.025 },
    { id: 'rem-a', type: 'remote-inbound-rtp', kind: 'audio', ssrc: 222, packetsLost: audioLost, roundTripTime: 0.025 },
    {
      id: 'pair',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      currentRoundTripTime: 0.025,
      availableOutgoingBitrate: 100_000,
      localCandidateId: 'loc',
      remoteCandidateId: 'rem'
    },
    { id: 'loc', type: 'local-candidate', candidateType: 'srflx' },
    { id: 'rem', type: 'remote-candidate', candidateType: 'srflx' }
  ]
}

test('a perda do audio nao entra na conta do video', async () => {
  // O cenario exato do teste real: video quase parado, audio perdendo pacotes.
  const pc = fakePc([
    relatorio({ videoPkt: 100, videoLost: 0, audioPkt: 1000, audioLost: 0, videoBytes: 0, audioBytes: 0 }),
    relatorio({ videoPkt: 110, videoLost: 0, audioPkt: 1100, audioLost: 40, videoBytes: 400, audioBytes: 11_000 })
  ])
  const c = new StatsCollector(pc, 'send')

  await c.sample()
  const s = await c.sample()

  assert.equal(s.network.packetsLostPct, 0, 'o video nao perdeu nada; nao pode acusar perda')
  assert.ok(s.network.packetsLostPctAudio > 0, 'a perda do audio precisa aparecer, mas no campo dela')
})

test('a perda do video e medida contra os pacotes de video', async () => {
  const pc = fakePc([
    relatorio({ videoPkt: 0, videoLost: 0, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 }),
    relatorio({ videoPkt: 90, videoLost: 10, audioPkt: 500, audioLost: 0, videoBytes: 1000, audioBytes: 5000 })
  ])
  const c = new StatsCollector(pc, 'send')

  await c.sample()
  const s = await c.sample()

  // 10 perdidos de 100 enviados = 10%.
  assert.equal(s.network.packetsLostPct, 10)
  assert.equal(s.network.packetsLostPctAudio, 0)
})

test('video e audio tem kbps separados', async () => {
  const pc = fakePc([
    relatorio({ videoPkt: 0, videoLost: 0, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 }),
    relatorio({ videoPkt: 10, videoLost: 0, audioPkt: 50, audioLost: 0, videoBytes: 12_500, audioBytes: 12_500 })
  ])
  const c = new StatsCollector(pc, 'send')

  const primeira = await c.sample()
  assert.equal(primeira.video.kbps, 0, 'sem amostra anterior nao da para calcular taxa')

  // Duas amostras no MESMO milissegundo nao tem intervalo para dividir; em
  // producao o coletor roda a cada segundo.
  await new Promise((r) => setTimeout(r, 5))
  const s = await c.sample()
  assert.ok(s.video.kbps > 0 && s.audio.kbps > 0)
  assert.equal(s.video.limitation, 'bandwidth', 'o motivo do gargalo vem do encoder')
})

test('contador que recua nao vira perda negativa', async () => {
  // Relatorios de RTCP chegam fora de ordem; o delta pode ficar negativo.
  const pc = fakePc([
    relatorio({ videoPkt: 100, videoLost: 50, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 }),
    relatorio({ videoPkt: 200, videoLost: 20, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 })
  ])
  const c = new StatsCollector(pc, 'send')

  await c.sample()
  const s = await c.sample()

  assert.equal(s.network.packetsLostPct, 0)
})

test('o caminho de rede vem do par de candidatos', async () => {
  const pc = fakePc([relatorio({ videoPkt: 0, videoLost: 0, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 })])
  const s = await new StatsCollector(pc, 'send').sample()

  assert.equal(s.network.rttMs, 25)
  assert.equal(s.network.availableOutgoingKbps, 100)
  assert.equal(s.network.relayed, false)
  assert.equal(s.network.localCandidateType, 'srflx')
})

test('relay e detectado dos dois lados', async () => {
  const base = relatorio({ videoPkt: 0, videoLost: 0, audioPkt: 0, audioLost: 0, videoBytes: 0, audioBytes: 0 })
  const comRelay = base.map((s) => (s.id === 'rem' ? { ...s, candidateType: 'relay' } : s))
  const s = await new StatsCollector(fakePc([comRelay]), 'send').sample()

  assert.equal(s.network.relayed, true, 'passar por TURN precisa aparecer no painel')
})
