/**
 * Teste de fumaca do signaling.
 *
 * Cobre o ciclo completo sem precisar de navegador: criar sala, entrar, relay de
 * SDP/ICE entre os dois, senha errada e — o mais importante para sessao longa —
 * o host cair e retomar a MESMA sala com o token, sem trocar o link.
 *
 *   node server/signaling/test/smoke.mjs [url]
 */
import { WebSocket } from 'ws'

const URL = process.argv[2] ?? 'ws://localhost:8787/ws'
const TIMEOUT_MS = 5000

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.error(`  FAIL ${name} ${detail}`)
  }
}

function connect() {
  const socket = new WebSocket(URL)
  const queue = []
  const waiters = []

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else queue.push(message)
  })

  return {
    socket,
    open: () => new Promise((resolve) => socket.once('open', resolve)),
    send: (message) => socket.send(JSON.stringify(message)),
    /** Espera a proxima mensagem, ignorando pongs do heartbeat. */
    next: () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout esperando mensagem')), TIMEOUT_MS)
        const take = (message) => {
          if (message.type === 'pong') {
            pull()
            return
          }
          clearTimeout(timer)
          resolve(message)
        }
        const pull = () => {
          const queued = queue.shift()
          if (queued) take(queued)
          else waiters.push(take)
        }
        pull()
      }),
    close: () => socket.close()
  }
}

async function main() {
  console.log(`Testando ${URL}\n`)

  // ---------------------------------------------------------------- criar
  const host = connect()
  await host.open()
  host.send({ type: 'create', name: 'Host', password: 'segredo' })
  const welcome = await host.next()

  check('host recebe welcome', welcome.type === 'welcome', JSON.stringify(welcome))
  check('welcome traz codigo de 6 letras', welcome.roomCode?.length === 6, welcome.roomCode)
  check('welcome traz hostToken', typeof welcome.hostToken === 'string')
  check('welcome traz iceServers', Array.isArray(welcome.iceServers))
  check('papel e host', welcome.role === 'host')

  const roomCode = welcome.roomCode
  const hostToken = welcome.hostToken
  const hostId = welcome.selfId

  // -------------------------------------------------------- senha errada
  const impostor = connect()
  await impostor.open()
  impostor.send({ type: 'join', roomCode, name: 'Impostor', password: 'errada' })
  const denied = await impostor.next()
  check('senha errada e recusada', denied.type === 'error' && denied.code === 'bad-password', JSON.stringify(denied))
  impostor.close()

  // -------------------------------------------------------- codigo errado
  const lost = connect()
  await lost.open()
  lost.send({ type: 'join', roomCode: 'ZZZZZZ', name: 'Perdido' })
  const notFound = await lost.next()
  check('sala inexistente e recusada', notFound.type === 'error' && notFound.code === 'room-not-found', JSON.stringify(notFound))
  lost.close()

  // ---------------------------------------------------------------- viewer
  const viewer = connect()
  await viewer.open()
  viewer.send({ type: 'join', roomCode, name: 'Amigo', password: 'segredo' })
  const viewerWelcome = await viewer.next()
  check('viewer entra com a senha certa', viewerWelcome.type === 'welcome', JSON.stringify(viewerWelcome))
  check('viewer enxerga o host na sala', viewerWelcome.peers?.some((p) => p.role === 'host'))

  const viewerId = viewerWelcome.selfId

  const joinedEvent = await host.next()
  check('host e avisado da entrada', joinedEvent.type === 'peer-joined' && joinedEvent.peer.id === viewerId, JSON.stringify(joinedEvent))

  // ------------------------------------------------------------- relay SDP
  host.send({
    type: 'signal',
    to: viewerId,
    payload: { kind: 'sdp', type: 'offer', sdp: 'v=0-oferta-de-teste' }
  })
  const offer = await viewer.next()
  check('oferta chega no viewer', offer.type === 'signal' && offer.payload.sdp === 'v=0-oferta-de-teste', JSON.stringify(offer))
  check('oferta identifica o remetente', offer.from === hostId)

  viewer.send({
    type: 'signal',
    to: hostId,
    payload: { kind: 'ice', candidate: { candidate: 'candidato-de-teste' } }
  })
  const ice = await host.next()
  check('candidato ICE volta para o host', ice.type === 'signal' && ice.payload.kind === 'ice', JSON.stringify(ice))

  /**
   * Pedido de oferta nova, do viewer para o host.
   *
   * E a unica saida de um viewer preso em `checking` — quem responde nao pode
   * reiniciar o ICE sozinho. Se o schema perder esta variante, o servidor recusa
   * a mensagem e a recuperacao morre calada: a tela volta a dizer
   * "Conectando..." para sempre, que e exatamente o bug que ela conserta.
   */
  viewer.send({ type: 'signal', to: hostId, payload: { kind: 'renegotiate', relay: true } })
  const renegotiate = await host.next()
  check(
    'pedido de renegociacao chega no host',
    renegotiate.type === 'signal' &&
      renegotiate.payload.kind === 'renegotiate' &&
      renegotiate.payload.relay === true,
    JSON.stringify(renegotiate)
  )

  // ------------------------------------------------------- host cai e volta
  host.close()
  const hostLeft = await viewer.next()
  check('viewer e avisado que o host saiu', hostLeft.type === 'peer-left' && hostLeft.peerId === hostId, JSON.stringify(hostLeft))

  const hostAgain = connect()
  await hostAgain.open()
  hostAgain.send({ type: 'create', name: 'Host', resume: { roomCode, hostToken } })
  const resumed = await hostAgain.next()
  check('host retoma a MESMA sala com o token', resumed.type === 'welcome' && resumed.roomCode === roomCode, JSON.stringify(resumed))
  check('viewer continuou na sala durante a queda', resumed.peers?.some((p) => p.id === viewerId))

  // ------------------------------------------------------- token invalido
  const thief = connect()
  await thief.open()
  thief.send({ type: 'create', name: 'Ladrao', resume: { roomCode, hostToken: 'token-falso' } })
  const rejected = await thief.next()
  check('token de host invalido e recusado', rejected.type === 'error' && rejected.code === 'host-taken', JSON.stringify(rejected))
  thief.close()

  // ------------------------------------------------------- mensagem invalida
  const noisy = connect()
  await noisy.open()
  noisy.socket.send('isto nao e json')
  const invalid = await noisy.next()
  check('mensagem malformada e rejeitada', invalid.type === 'error' && invalid.code === 'invalid-message', JSON.stringify(invalid))
  noisy.close()

  // ------------------------------------------------------------- remover
  // Nao lemos as mensagens do host aqui de proposito: peer-joined/peer-left dele
  // ficam na fila e as asercoes olham so o socket do alvo, o que torna o teste
  // imune a ordem de eventos.
  const alvo = connect()
  await alvo.open()
  alvo.send({ type: 'join', roomCode, name: 'Alvo', password: 'segredo', clientToken: 'token-alvo' })
  const alvoWelcome = await alvo.next()
  check('alvo entrou na sala', alvoWelcome.type === 'welcome', JSON.stringify(alvoWelcome))

  hostAgain.send({ type: 'kick', peerId: alvoWelcome.selfId, block: false })
  const avisoRemocao = await alvo.next()
  check(
    'removido e avisado',
    avisoRemocao.type === 'error' && avisoRemocao.code === 'kicked',
    JSON.stringify(avisoRemocao)
  )
  alvo.close()

  const devolta = connect()
  await devolta.open()
  devolta.send({ type: 'join', roomCode, name: 'Alvo', password: 'segredo', clientToken: 'token-alvo' })
  const voltou = await devolta.next()
  check(
    'removido SEM bloqueio consegue voltar',
    voltou.type === 'welcome',
    JSON.stringify(voltou)
  )

  // ------------------------------------------------------------ bloquear
  hostAgain.send({ type: 'kick', peerId: voltou.selfId, block: true })
  const avisoBloqueio = await devolta.next()
  check(
    'bloqueado e avisado',
    avisoBloqueio.type === 'error' && avisoBloqueio.code === 'blocked',
    JSON.stringify(avisoBloqueio)
  )
  devolta.close()

  const insistindo = connect()
  await insistindo.open()
  insistindo.send({ type: 'join', roomCode, name: 'Alvo', password: 'segredo', clientToken: 'token-alvo' })
  const recusado = await insistindo.next()
  check(
    'bloqueado nao consegue voltar',
    recusado.type === 'error' && recusado.code === 'blocked',
    JSON.stringify(recusado)
  )
  insistindo.close()

  // Bloqueio por token nao pode pegar quem divide o mesmo IP (mesma casa).
  const vizinho = connect()
  await vizinho.open()
  vizinho.send({ type: 'join', roomCode, name: 'Vizinho', password: 'segredo', clientToken: 'token-vizinho' })
  const vizinhoMsg = await vizinho.next()
  check(
    'bloqueio nao atinge outro navegador no mesmo IP',
    vizinhoMsg.type === 'welcome',
    JSON.stringify(vizinhoMsg)
  )

  // --------------------------------------------------- so o host remove
  vizinho.send({ type: 'kick', peerId: 'qualquer-um', block: true })
  const negado = await vizinho.next()
  check(
    'espectador nao pode remover ninguem',
    negado.type === 'error' && negado.code === 'not-host',
    JSON.stringify(negado)
  )
  vizinho.close()

  viewer.close()
  hostAgain.close()

  console.log(`\n${passed} passaram, ${failed} falharam`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nerro no teste:', err.message)
  process.exit(1)
})
