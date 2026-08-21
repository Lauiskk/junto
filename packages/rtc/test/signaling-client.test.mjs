/**
 * Regressao do bug que quebrou a primeira sessao real.
 *
 * Sintomas observados pelo usuario, todos com a MESMA causa: "a sala expirou;
 * crie uma nova", status preso em "reconectando", "entre numa sala antes de
 * sinalizar" e um espectador fantasma que nunca saia da lista.
 *
 * A causa: quando a retomada da sala era recusada, o cliente limpava o token e
 * parava — socket aberto, sem sala nenhuma, para sempre.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** WebSocket falso: registra o que foi enviado e deixa injetar respostas. */
class FakeSocket {
  static instances = []
  static OPEN = 1

  constructor(url) {
    this.url = url
    this.sent = []
    this.readyState = FakeSocket.OPEN
    FakeSocket.instances.push(this)
  }

  send(data) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  abrir() {
    this.onopen?.()
  }

  receber(mensagem) {
    this.onmessage?.({ data: JSON.stringify(mensagem) })
  }

  /** Mensagens de um tipo, ignorando os pings do heartbeat. */
  enviadas(tipo) {
    return this.sent.filter((m) => m.type === tipo)
  }
}

globalThis.WebSocket = FakeSocket

const { SignalingClient } = await import('../dist/signaling-client.js')

const boasVindas = (roomCode, hostToken) => ({
  type: 'welcome',
  selfId: 'self-' + roomCode,
  roomCode,
  role: 'host',
  peers: [],
  iceServers: [],
  ...(hostToken ? { hostToken } : {})
})

const esperar = (ms) => new Promise((r) => setTimeout(r, ms))

function novoCliente() {
  FakeSocket.instances = []
  return new SignalingClient('ws://teste/ws')
}

test('retomada recusada resulta em sala NOVA, nao em limbo', async () => {
  const client = novoCliente()
  const erros = []
  const salas = []
  client.on('error', (e) => erros.push(e))
  client.on('welcome', (w) => salas.push(w.roomCode))

  client.createRoom('Host')
  const primeiro = FakeSocket.instances[0]
  primeiro.abrir()
  primeiro.receber(boasVindas('AAA111', 'token-secreto'))

  assert.equal(salas[0], 'AAA111')

  // A conexao cai e o cliente reconecta sozinho.
  primeiro.close()
  await esperar(1200)

  const segundo = FakeSocket.instances[1]
  assert.ok(segundo, 'deveria ter reconectado')
  segundo.abrir()

  const comRetomada = segundo.enviadas('create')[0]
  assert.deepEqual(
    comRetomada.resume,
    { roomCode: 'AAA111', hostToken: 'token-secreto' },
    'a primeira tentativa deve tentar retomar a mesma sala'
  )

  // O servidor recusa: a sala expirou enquanto estavamos fora.
  segundo.receber({
    type: 'error',
    code: 'room-not-found',
    message: 'a sala expirou; crie uma nova'
  })

  // ESTE e o comportamento que faltava.
  const criacoes = segundo.enviadas('create')
  assert.equal(criacoes.length, 2, 'deveria pedir uma sala nova imediatamente')
  assert.equal(criacoes[1].resume, undefined, 'o novo pedido nao pode levar token morto')
  assert.equal(erros.length, 0, 'recuperacao automatica nao deve virar erro na tela')

  // E a sala nova chega normalmente.
  segundo.receber(boasVindas('BBB222', 'outro-token'))
  assert.equal(salas[1], 'BBB222')
  assert.equal(client.status, 'connected')
  client.close()
})

test('viewer com sala inexistente ainda recebe o erro', async () => {
  const client = novoCliente()
  const erros = []
  client.on('error', (e) => erros.push(e))

  client.joinRoom('ZZZZZZ', 'Amigo')
  const socket = FakeSocket.instances[0]
  socket.abrir()
  socket.receber({
    type: 'error',
    code: 'room-not-found',
    message: 'sala nao encontrada'
  })

  // Para quem assiste nao ha o que recriar: o erro tem que aparecer.
  assert.equal(erros.length, 1)
  assert.equal(erros[0].code, 'room-not-found')
  client.close()
})

test('nao sinaliza enquanto nao estiver numa sala', async () => {
  const client = novoCliente()
  client.createRoom('Host')
  const socket = FakeSocket.instances[0]
  socket.abrir()

  // Antes do welcome: qualquer ICE aqui viraria "entre numa sala antes de sinalizar".
  client.signal('alguem', { kind: 'ice', candidate: { candidate: 'x' } })
  assert.equal(socket.enviadas('signal').length, 0)

  socket.receber(boasVindas('CCC333', 'tok'))
  client.signal('alguem', { kind: 'ice', candidate: { candidate: 'x' } })
  assert.equal(socket.enviadas('signal').length, 1, 'dentro da sala deve sinalizar')
  client.close()
})

test('perder a sala interrompe a sinalizacao na hora', async () => {
  const client = novoCliente()
  client.createRoom('Host')
  const socket = FakeSocket.instances[0]
  socket.abrir()
  socket.receber(boasVindas('DDD444', 'tok'))

  socket.receber({ type: 'error', code: 'host-taken', message: 'outro host assumiu' })

  const antes = socket.enviadas('signal').length
  client.signal('alguem', { kind: 'ice', candidate: { candidate: 'x' } })
  assert.equal(socket.enviadas('signal').length, antes, 'nao deve sinalizar fora da sala')
  client.close()
})
