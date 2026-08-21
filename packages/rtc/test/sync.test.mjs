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
