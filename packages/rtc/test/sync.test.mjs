/**
 * Testes da sincronizacao do Modo Cinema.
 *
 *   node --test packages/rtc/test/
 *
 * A logica de correcao e funcao pura de proposito: e a parte que decide se a
 * experiencia fica suave ou engasgada, e testar isso a mao (dois PCs, um filme,
 * um cronometro) seria lento e nada confiavel.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEAD_ZONE_SEC,
  FilmReceiver,
  FilmSender,
  HARD_SEEK_THRESHOLD_SEC,
  MAX_RATE_ADJUSTMENT,
  computePlaybackCorrection,
  formatBytes,
  projectHostPosition
} from '../dist/film-transfer.js'

test('desvio grande vira um pulo unico, nao correcao lenta', () => {
  const correction = computePlaybackCorrection(130, 100)
  assert.equal(correction.action, 'seek')
  assert.equal(correction.seekTo, 130)
  assert.equal(correction.playbackRate, 1)
  assert.equal(correction.driftSec, 30)
})

test('atrasado por pouco: acelera de leve, dentro do teto imperceptivel', () => {
  const correction = computePlaybackCorrection(100.5, 100)
  assert.equal(correction.action, 'rate')
  assert.ok(correction.playbackRate > 1)
  assert.ok(correction.playbackRate <= 1 + MAX_RATE_ADJUSTMENT)
})

test('adiantado por pouco: desacelera de leve', () => {
  const correction = computePlaybackCorrection(100, 100.5)
  assert.equal(correction.action, 'rate')
  assert.ok(correction.playbackRate < 1)
  assert.ok(correction.playbackRate >= 1 - MAX_RATE_ADJUSTMENT)
})

test('desvio irrelevante nao mexe no player', () => {
  const correction = computePlaybackCorrection(100.05, 100)
  assert.equal(correction.action, 'none')
  assert.equal(correction.playbackRate, 1)
})

test('as fronteiras da zona morta e do pulo sao coerentes', () => {
  assert.ok(DEAD_ZONE_SEC < HARD_SEEK_THRESHOLD_SEC)
  // Logo acima da zona morta ainda e ajuste fino, nao pulo.
  assert.equal(computePlaybackCorrection(100 + DEAD_ZONE_SEC + 0.01, 100).action, 'rate')
  // Logo acima do limite vira pulo.
  assert.equal(
    computePlaybackCorrection(100 + HARD_SEEK_THRESHOLD_SEC + 0.01, 100).action,
    'seek'
  )
})

test('a correcao converge em vez de oscilar', () => {
  // Simula o viewer 0,8s atrasado corrigindo a cada segundo.
  let viewerPosition = 100
  let hostPosition = 100.8
  for (let tick = 0; tick < 30; tick++) {
    const correction = computePlaybackCorrection(hostPosition, viewerPosition)
    if (correction.action === 'seek') viewerPosition = correction.seekTo
    else viewerPosition += correction.playbackRate
    hostPosition += 1
  }
  const finalDrift = Math.abs(hostPosition - viewerPosition)
  assert.ok(finalDrift <= DEAD_ZONE_SEC, `deveria ter convergido, sobrou ${finalDrift}s`)
})

test('posicao do host e projetada com o offset de relogio', () => {
  const hostTimeMs = 1_000_000
  // Dois segundos depois, com relogios identicos.
  const projected = projectHostPosition(50, hostTimeMs, 0, true, hostTimeMs + 2000)
  assert.equal(projected, 52)

  // Mesmo instante, mas nosso relogio esta 500ms atrasado em relacao ao host:
  // sem o offset erramos meio segundo permanentemente.
  const corrected = projectHostPosition(50, hostTimeMs, 500, true, hostTimeMs + 2000)
  assert.equal(corrected, 52.5)
})

test('pausado nao extrapola posicao', () => {
  const projected = projectHostPosition(50, 1_000_000, 0, false, 1_000_000 + 9999)
  assert.equal(projected, 50)
})

test('FilmReceiver remonta o arquivo byte a byte', async () => {
  const total = 300_000
  const original = new Uint8Array(total)
  for (let i = 0; i < total; i++) original[i] = i % 251

  const receiver = new FilmReceiver('filme.mp4', total, 'video/mp4')
  const chunkSize = 16 * 1024
  for (let offset = 0; offset < total; offset += chunkSize) {
    const slice = original.slice(offset, Math.min(offset + chunkSize, total))
    receiver.push(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
  }

  assert.equal(receiver.received, total)
  assert.equal(receiver.complete, true)

  const blob = receiver.finish()
  assert.equal(blob.size, total)
  assert.equal(blob.type, 'video/mp4')

  const roundTripped = new Uint8Array(await blob.arrayBuffer())
  assert.deepEqual(roundTripped, original, 'o arquivo remontado difere do original')
})

test('FilmReceiver so fica completo com o arquivo inteiro', () => {
  const receiver = new FilmReceiver('filme.mp4', 1000, 'video/mp4')
  receiver.push(new ArrayBuffer(600))
  assert.equal(receiver.complete, false)
  receiver.push(new ArrayBuffer(400))
  assert.equal(receiver.complete, true)
})

test('formatBytes usa a unidade que a pessoa espera ler', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(2048), '2 KB')
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB')
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB')
})

test('transferencia retomada sai byte a byte identica ao original', async () => {
  /**
   * O cenario que motivou a retomada: o host reinicia no meio de um filme
   * grande. Antes, os bytes ja recebidos iam para o lixo e tudo recomecava do
   * zero. O que este teste prova nao e so que a retomada acontece — e que o
   * arquivo montado depois dela e EXATAMENTE o original. Retomar na posicao
   * errada produziria um arquivo do tamanho certo e com o conteudo embaralhado,
   * que e uma falha muito pior do que recomecar.
   */
  const total = 300_000
  const original = new Uint8Array(total)
  for (let i = 0; i < total; i++) original[i] = (i * 7) % 251

  const pedaco = (de, ate) => {
    const s = original.slice(de, ate)
    return s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength)
  }

  const receiver = new FilmReceiver('filme.mp4', total, 'video/mp4')

  // Primeira tentativa: cai no meio de um chunk qualquer.
  const queda = 137_216
  const chunk = 16 * 1024
  for (let o = 0; o < queda; o += chunk) receiver.push(pedaco(o, Math.min(o + chunk, queda)))

  assert.equal(receiver.received, queda)
  assert.equal(receiver.complete, false)

  // O host volta e pergunta de onde continuar; a resposta e `received`.
  assert.ok(receiver.matches('filme.mp4', total), 'e o mesmo arquivo')
  receiver.resumeSession()

  for (let o = receiver.received; o < total; o += chunk) {
    receiver.push(pedaco(o, Math.min(o + chunk, total)))
  }

  assert.equal(receiver.received, total)
  assert.equal(receiver.complete, true)

  const bytes = new Uint8Array(await receiver.finish().arrayBuffer())
  assert.equal(bytes.length, total)
  assert.deepEqual(bytes, original, 'o arquivo retomado tem que ser identico')
})

test('arquivo diferente com o mesmo nome nao e confundido', () => {
  const receiver = new FilmReceiver('filme.mp4', 1000, 'video/mp4')
  assert.equal(receiver.matches('filme.mp4', 1000), true)
  assert.equal(receiver.matches('filme.mp4', 2000), false, 'tamanho diferente = outro arquivo')
  assert.equal(receiver.matches('outro.mp4', 1000), false)
})

test('bytes a mais sao descartados em vez de corromper o arquivo', () => {
  // Se quem envia recomecar de uma posicao anterior a que ja temos, aceitar
  // tudo produziria um arquivo maior que o original — e que parece valido.
  const receiver = new FilmReceiver('filme.mp4', 100, 'video/mp4')
  receiver.push(new ArrayBuffer(80))
  receiver.push(new ArrayBuffer(50))

  assert.equal(receiver.received, 100, 'nunca passa do tamanho declarado')
  assert.equal(receiver.complete, true)
  assert.equal(receiver.finish().size, 100)
})

test('a velocidade medida ignora o que ja havia antes da retomada', () => {
  // Retomando em 90%, dividir o total pelo tempo desta sessao daria um numero
  // fantasioso na tela de quem espera.
  const receiver = new FilmReceiver('filme.mp4', 1_000_000, 'video/mp4')
  receiver.push(new ArrayBuffer(900_000))
  receiver.resumeSession()
  const progresso = receiver.push(new ArrayBuffer(1000))

  assert.equal(progresso.sent, 901_000, 'o progresso mostra o total acumulado')
  assert.ok(
    progresso.bytesPerSecond < 900_000,
    `a taxa deve refletir so os bytes novos, veio ${progresso.bytesPerSecond}`
  )
})

/** Canal de dados de mentira que despeja direto no receptor. */
function canalFalso(receiver, morrerApos = Infinity) {
  let enviado = 0
  return {
    binaryType: 'arraybuffer',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    readyState: 'open',
    send(buffer) {
      receiver.push(buffer)
      enviado += buffer.byteLength
      // A queda acontece DEPOIS de entregar o chunk, como na vida real: o que
      // ja passou pelo fio chegou.
      if (enviado >= morrerApos) this.readyState = 'closed'
    },
    addEventListener() {},
    removeEventListener() {}
  }
}

test('envio + queda + retomada entregam o arquivo original', async () => {
  const total = 250_000
  const original = new Uint8Array(total)
  for (let i = 0; i < total; i++) original[i] = (i * 13) % 251
  const arquivo = new File([original], 'filme.mp4', { type: 'video/mp4' })

  const receiver = new FilmReceiver('filme.mp4', total, 'video/mp4')

  // Primeira tentativa: o canal fecha por volta da metade.
  const canal1 = canalFalso(receiver, 120_000)
  await assert.rejects(
    () => new FilmSender(canal1, arquivo).send(() => {}),
    /canal do filme fechou/,
    'o envio precisa falhar de forma explicita, nao em silencio'
  )

  const parouEm = receiver.received
  assert.ok(parouEm > 0 && parouEm < total, `parou em ${parouEm}, fora do esperado`)

  // Retomada: quem recebe dita a posicao.
  receiver.resumeSession()
  let ultimoProgresso = null
  await new FilmSender(canalFalso(receiver), arquivo).send((p) => {
    ultimoProgresso = p
  }, receiver.received)

  assert.equal(ultimoProgresso.sent, total)
  assert.equal(receiver.complete, true)

  const bytes = new Uint8Array(await receiver.finish().arrayBuffer())
  assert.deepEqual(bytes, original, 'retomar na posicao errada embaralharia o conteudo')
})

test('retomar no fim nao reenvia nada', async () => {
  const arquivo = new File([new Uint8Array(50_000)], 'filme.mp4', { type: 'video/mp4' })
  const receiver = new FilmReceiver('filme.mp4', 50_000, 'video/mp4')

  let bytesNoFio = 0
  const canal = canalFalso(receiver)
  const enviarOriginal = canal.send.bind(canal)
  canal.send = (b) => {
    bytesNoFio += b.byteLength
    enviarOriginal(b)
  }

  const progressos = []
  await new FilmSender(canal, arquivo).send((p) => progressos.push(p), 50_000)

  assert.equal(bytesNoFio, 0, 'nada deve trafegar quando ja esta completo')
  assert.equal(progressos.at(-1).sent, 50_000, 'mas o painel precisa mostrar 100%')
})
