/**
 * Testes do ajuste de bitrate de video no SDP.
 *
 * Os tres parametros `x-google-*` sao extensoes do Chromium e nao aparecem em
 * nenhuma especificacao — o que significa que ninguem que ler o codigo depois
 * vai saber, so pelo nome, que eles sao a diferenca entre a sessao arrancar em
 * 300 kbps subindo por 30 s ou ja comecar na qualidade certa.
 *
 * O risco real deste arquivo e mais chato: injetar os parametros na linha
 * errada. Colocar `x-google-min-bitrate` no fmtp do rtx, do Opus ou do ulpfec
 * nao da erro nenhum — o SDP negocia normalmente e o ajuste simplesmente nao
 * faz nada. Por isso os testes olham ONDE cada parametro caiu.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tuneVideoBitrate } from '../dist/sdp.js'

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 H264/90000',
  'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640020',
  'a=rtpmap:99 ulpfec/90000',
  ''
].join('\r\n')

const linha = (sdp, prefixo) => sdp.split('\r\n').find((l) => l.startsWith(prefixo)) ?? ''

test('injeta os tres parametros no codec de video', () => {
  const out = tuneVideoBitrate(SDP, { startKbps: 2500, minKbps: 800, maxKbps: 6000 })
  const h264 = linha(out, 'a=fmtp:98 ')

  assert.match(h264, /x-google-start-bitrate=2500/)
  assert.match(h264, /x-google-min-bitrate=800/)
  assert.match(h264, /x-google-max-bitrate=6000/)
})

test('preserva os parametros que ja existiam', () => {
  const out = tuneVideoBitrate(SDP, { startKbps: 2500 })
  const h264 = linha(out, 'a=fmtp:98 ')

  assert.match(h264, /profile-level-id=640020/, 'perder o perfil trocaria o encoder')
  assert.match(h264, /packetization-mode=1/)
})

test('cria a linha fmtp para codec que nao tinha (o caso do VP8)', () => {
  const out = tuneVideoBitrate(SDP, { startKbps: 1200 })
  assert.match(linha(out, 'a=fmtp:96 '), /x-google-start-bitrate=1200/)
})

test('nao toca em rtx, ulpfec nem no audio', () => {
  const out = tuneVideoBitrate(SDP, { startKbps: 2500, minKbps: 800, maxKbps: 6000 })

  assert.equal(linha(out, 'a=fmtp:97 '), 'a=fmtp:97 apt=96', 'rtx nao carrega imagem')
  assert.equal(linha(out, 'a=fmtp:99 '), '', 'ulpfec nao pode ganhar fmtp inventado')
  assert.equal(
    linha(out, 'a=fmtp:111 '),
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'o Opus tem o proprio ajuste, em tuneOpus'
  )
})

test('sem nenhuma opcao, devolve o SDP intacto', () => {
  assert.equal(tuneVideoBitrate(SDP, {}), SDP)
  assert.equal(tuneVideoBitrate(SDP), SDP)
})

test('SDP so de audio passa sem alteracao', () => {
  const soAudio = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'].join(
    '\r\n'
  )
  assert.equal(tuneVideoBitrate(soAudio, { startKbps: 2500 }), soAudio)
})

test('aplicar duas vezes nao duplica parametro', () => {
  const uma = tuneVideoBitrate(SDP, { startKbps: 2500 })
  const duas = tuneVideoBitrate(uma, { startKbps: 4000 })
  const h264 = linha(duas, 'a=fmtp:98 ')

  assert.equal(h264.match(/x-google-start-bitrate/g).length, 1)
  assert.match(h264, /x-google-start-bitrate=4000/, 'o valor novo tem que vencer')
})
