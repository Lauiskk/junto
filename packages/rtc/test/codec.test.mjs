/**
 * Testes da preferencia de perfil H.264.
 *
 * Este arquivo existe por causa de um bug real que custou caro para achar: o
 * codigo preferia Constrained Baseline (42e01f) "por compatibilidade", e o
 * Chromium roteia exatamente esse perfil para o encoder de SOFTWARE. Medido em
 * execucao: com 42e01f o encoder era OpenH264; com 640020 passou a ser
 * "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)".
 *
 * Se alguem "simplificar" essa ordem de novo, a transmissao volta a comer CPU
 * sem nenhum erro aparecer. Daí o teste.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { h264ProfileRank } from '../dist/sender-tuning.js'

const fmtp = (profile) =>
  `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${profile}`

test('High vem antes de Main, que vem antes de Baseline', () => {
  assert.ok(h264ProfileRank(fmtp('640020')) < h264ProfileRank(fmtp('4d001f')))
  assert.ok(h264ProfileRank(fmtp('4d001f')) < h264ProfileRank(fmtp('42001f')))
})

test('Constrained Baseline e o ULTIMO — e o que cai no encoder de software', () => {
  const cbp = h264ProfileRank(fmtp('42e01f'))
  for (const outro of ['640020', '4d001f', '42001f']) {
    assert.ok(
      h264ProfileRank(fmtp(outro)) < cbp,
      `${outro} deveria ter prioridade sobre o Constrained Baseline`
    )
  }
})

test('perfil desconhecido nao ganha prioridade sobre os conhecidos', () => {
  const desconhecido = h264ProfileRank(fmtp('f4ffff'))
  assert.ok(desconhecido >= h264ProfileRank(fmtp('42e01f')))
})

test('fmtp sem profile-level-id nao quebra', () => {
  assert.equal(typeof h264ProfileRank('packetization-mode=1'), 'number')
  assert.equal(typeof h264ProfileRank(''), 'number')
})

test('a comparacao ignora maiusculas e minusculas', () => {
  assert.equal(h264ProfileRank(fmtp('640020')), h264ProfileRank(fmtp('640020'.toUpperCase())))
  assert.equal(h264ProfileRank(fmtp('4D001F')), h264ProfileRank(fmtp('4d001f')))
})
