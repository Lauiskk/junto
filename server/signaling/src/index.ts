import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  parseClientMessage,
  type ErrorCode,
  type Peer,
  type Role,
  type ServerMessage
} from '@junto/protocol'
import { buildIceServers } from './ice.ts'
import { resolveWebRoot, serveStatic } from './static.ts'

/**
 * Servidor de signaling do Junto.
 *
 * Responsabilidade unica: apresentar dois computadores um ao outro. Depois que a
 * conexao WebRTC fecha, video e audio vao DIRETO de um PC para o outro e este
 * processo fica ocioso — por isso ele cabe numa VPS minima. Nenhuma midia passa
 * por aqui, nem em transito.
 */

const PORT = Number(process.env.PORT ?? 8787)
const BIND = process.env.BIND ?? '0.0.0.0'
const MAX_PEERS_PER_ROOM = Number(process.env.MAX_PEERS_PER_ROOM ?? 8)
/** Janela em que o host pode voltar com o MESMO codigo apos cair. */
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS ?? 120_000)
const HEARTBEAT_MS = 30_000
const RATE_LIMIT_MSGS = 150
const RATE_LIMIT_WINDOW_MS = 10_000

interface Client {
  id: string
  name: string
  role: Role
  socket: WebSocket
  roomCode: string
  joinedAt: number
  recentMessages: number[]
  /** Endereco de rede, para o bloqueio. Atras de proxy vem do x-forwarded-for. */
  ip: string
  /** Token que o navegador guarda; a outra metade da identidade do bloqueio. */
  clientToken: string | null
}

interface Room {
  code: string
  hostToken: string
  passwordHash: Buffer | null
  hostId: string | null
  clients: Map<string, Client>
  createdAt: number
  graceTimer: NodeJS.Timeout | null
  /**
   * Quem o host bloqueou nesta sala — guarda IP e token do navegador.
   *
   * Nao e uma barreira criptografica: trocar de rede ou abrir aba anonima
   * contorna. Resolve o caso real (tirar alguem inconveniente da sala) e a
   * trava de verdade continua sendo a senha da sala.
   */
  blocked: Set<string>
  /**
   * Identidade -> id de peer, para que a MESMA pessoa volte com o MESMO id.
   *
   * Isto existe por causa de um teste real: o tunel do Cloudflare derrubou a
   * conexao QUIC no meio da sessao e todo mundo reconectou em 3 segundos. Como
   * cada `join` gerava um id novo, o host via um espectador desconhecido,
   * construia uma RTCPeerConnection do zero e a imagem de quem assistia
   * "piscava" — reconexao completa de midia por causa de um solucao de
   * sinalizacao, que a midia P2P nem usa.
   *
   * A chave e o token que o navegador guarda no localStorage; para o host, o
   * proprio hostToken da sala.
   */
  identities: Map<string, string>
}

const rooms = new Map<string, Room>()
const webRoot = resolveWebRoot()

// ---------------------------------------------------------------------------
// Utilitarios
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log(`[${new Date().toISOString()}]`, ...args)
}

function send(client: Client, message: ServerMessage): void {
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.send(JSON.stringify(message))
  }
}

function broadcast(room: Room, message: ServerMessage, exceptId?: string): void {
  for (const client of room.clients.values()) {
    if (client.id !== exceptId) send(client, message)
  }
}

function toPeer(client: Client): Peer {
  return {
    id: client.id,
    name: client.name,
    role: client.role,
    joinedAt: client.joinedAt
  }
}

function sendError(socket: WebSocket, code: ErrorCode, message: string): void {
  if (socket.readyState === WebSocket.OPEN) {
    const payload: ServerMessage = { type: 'error', code, message }
    socket.send(JSON.stringify(payload))
  }
}

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = randomBytes(ROOM_CODE_LENGTH)
    let code = ''
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length]
    }
    if (!rooms.has(code)) return code
  }
  throw new Error('nao foi possivel gerar codigo de sala unico')
}

function hashPassword(password: string): Buffer {
  return createHash('sha256').update(password).digest()
}

function passwordMatches(room: Room, password: string | undefined): boolean {
  if (!room.passwordHash) return true
  if (!password) return false
  const candidate = hashPassword(password)
  return (
    candidate.length === room.passwordHash.length &&
    timingSafeEqual(candidate, room.passwordHash)
  )
}

function closeRoom(room: Room, reason: string): void {
  if (room.graceTimer) clearTimeout(room.graceTimer)
  for (const client of room.clients.values()) {
    sendError(client.socket, 'room-not-found', reason)
    client.socket.close(4000, reason)
  }
  rooms.delete(room.code)
  log(`sala ${room.code} encerrada: ${reason}`)
}

/** Sliding window simples: barra flood sem penalizar uso normal. */
function withinRateLimit(client: Client): boolean {
  const now = Date.now()
  client.recentMessages = client.recentMessages.filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  )
  client.recentMessages.push(now)
  return client.recentMessages.length <= RATE_LIMIT_MSGS
}

// ---------------------------------------------------------------------------
// HTTP (health + ICE)
// ---------------------------------------------------------------------------

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (url.pathname === '/health') {
    let peers = 0
    for (const room of rooms.values()) peers += room.clients.size
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({ ok: true, rooms: rooms.size, peers, uptime: process.uptime() })
    )
    return
  }

  if (url.pathname === '/ice') {
    void buildIceServers().then((iceServers) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ iceServers }))
    })
    return
  }

  // Se o viewer foi buildado, ele sai por este mesmo servidor — uma origem so
  // para o site e para o WebSocket.
  if (webRoot && serveStatic(webRoot, req, res, url.pathname)) return

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(
    'Junto signaling. Endpoints: /health, /ice, ws://.../ws\n' +
      '(o viewer web nao foi encontrado: rode "npm run build -w @junto/web")'
  )
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const httpServer = createServer(handleHttp)
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
  /** Client so existe depois de create/join — antes disso a conexao e anonima. */
  let client: Client | null = null
  let alive = true

  // Atras do tunel/proxy, remoteAddress e sempre o mesmo — todos os espectadores
  // pareceriam a mesma pessoa. O x-forwarded-for e o que distingue.
  const forwarded = req.headers['x-forwarded-for']
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined) ||
    req.socket.remoteAddress ||
    'desconhecido'

  socket.on('pong', () => {
    alive = true
  })

  socket.on('message', async (data) => {
    const message = parseClientMessage(data.toString())
    if (!message) {
      sendError(socket, 'invalid-message', 'mensagem malformada')
      return
    }

    if (client && !withinRateLimit(client)) {
      sendError(socket, 'rate-limited', 'muitas mensagens')
      socket.close(4008, 'rate limited')
      return
    }

    switch (message.type) {
      case 'create': {
        if (client) {
          sendError(socket, 'already-in-room', 'esta conexao ja esta numa sala')
          return
        }

        let room: Room

        if (message.resume) {
          // Host voltando de uma queda: so entra com o token secreto da sala.
          const existing = rooms.get(message.resume.roomCode)
          if (!existing) {
            sendError(socket, 'room-not-found', 'a sala expirou; crie uma nova')
            return
          }
          if (existing.hostToken !== message.resume.hostToken) {
            sendError(socket, 'host-taken', 'token de host invalido')
            return
          }
          if (existing.hostId) {
            sendError(socket, 'host-taken', 'esta sala ja tem um host conectado')
            return
          }
          if (existing.graceTimer) {
            clearTimeout(existing.graceTimer)
            existing.graceTimer = null
          }
          room = existing
          log(`host retomou a sala ${room.code}`)
        } else {
          const code = generateRoomCode()
          room = {
            code,
            hostToken: randomUUID(),
            passwordHash: message.password ? hashPassword(message.password) : null,
            hostId: null,
            clients: new Map(),
            createdAt: Date.now(),
            graceTimer: null,
            blocked: new Set(),
            identities: new Map()
          }
          rooms.set(code, room)
          log(`sala ${code} criada`)
        }

        // O host que retoma continua sendo o mesmo peer para quem assiste; um
        // id novo faria o viewer jogar fora a conexao que ainda funcionava.
        const self: Client = {
          id: room.identities.get(room.hostToken) ?? randomUUID(),
          name: message.name,
          role: 'host',
          socket,
          roomCode: room.code,
          joinedAt: Date.now(),
          recentMessages: [],
          ip,
          clientToken: null
        }
        client = self
        room.hostId = self.id
        room.identities.set(room.hostToken, self.id)
        room.clients.set(self.id, self)

        send(self, {
          type: 'welcome',
          selfId: self.id,
          roomCode: room.code,
          role: 'host',
          peers: [...room.clients.values()]
            .filter((c) => c.id !== self.id)
            .map(toPeer),
          iceServers: await buildIceServers(),
          hostToken: room.hostToken
        })
        broadcast(room, { type: 'peer-joined', peer: toPeer(self) }, self.id)
        return
      }

      case 'join': {
        if (client) {
          sendError(socket, 'already-in-room', 'esta conexao ja esta numa sala')
          return
        }
        const room = rooms.get(message.roomCode)
        if (!room) {
          sendError(socket, 'room-not-found', 'sala nao encontrada')
          return
        }
        if (!passwordMatches(room, message.password)) {
          sendError(socket, 'bad-password', 'senha incorreta')
          return
        }
        if (room.clients.size >= MAX_PEERS_PER_ROOM) {
          sendError(socket, 'room-full', 'sala cheia')
          return
        }
        if (room.blocked.has(ip) || (message.clientToken && room.blocked.has(message.clientToken))) {
          sendError(socket, 'blocked', 'voce foi bloqueado nesta sala')
          socket.close(4003, 'bloqueado')
          return
        }

        const self: Client = {
          id: (message.clientToken && room.identities.get(message.clientToken)) || randomUUID(),
          name: message.name,
          role: 'viewer',
          socket,
          roomCode: room.code,
          joinedAt: Date.now(),
          recentMessages: [],
          ip,
          clientToken: message.clientToken ?? null
        }
        client = self
        if (message.clientToken) room.identities.set(message.clientToken, self.id)
        // Socket antigo da mesma pessoa ainda pendurado (o `close` pode demorar
        // a chegar): o `set` abaixo ja o substitui no mapa, e o guard no
        // handler de `close` impede que a saida dele derrube a entrada nova.
        room.clients.set(self.id, self)

        send(self, {
          type: 'welcome',
          selfId: self.id,
          roomCode: room.code,
          role: 'viewer',
          peers: [...room.clients.values()]
            .filter((c) => c.id !== self.id)
            .map(toPeer),
          iceServers: await buildIceServers()
        })
        broadcast(room, { type: 'peer-joined', peer: toPeer(self) }, self.id)
        log(`viewer entrou na sala ${room.code} (${room.clients.size} na sala)`)
        return
      }

      case 'signal': {
        if (!client) {
          sendError(socket, 'invalid-message', 'entre numa sala antes de sinalizar')
          return
        }
        const room = rooms.get(client.roomCode)
        const target = room?.clients.get(message.to)
        // Silencioso de proposito: o alvo pode ter saido no meio da negociacao,
        // e isso e normal, nao erro.
        if (target) {
          send(target, { type: 'signal', from: client.id, payload: message.payload })
        }
        return
      }

      case 'ping': {
        if (client) send(client, { type: 'pong', t: message.t, serverTime: Date.now() })
        return
      }

      case 'kick': {
        if (!client) {
          sendError(socket, 'invalid-message', 'entre numa sala primeiro')
          return
        }
        const room = rooms.get(client.roomCode)
        // So o host DAQUELA sala remove alguem. Sem esta checagem, qualquer
        // espectador poderia derrubar os outros.
        if (!room || room.hostId !== client.id) {
          sendError(socket, 'not-host', 'apenas o host pode remover alguem')
          return
        }
        const target = room.clients.get(message.peerId)
        if (!target || target.id === client.id) return

        if (message.block) {
          /**
           * Token primeiro, IP so como ultimo recurso.
           *
           * Dois amigos na mesma casa saem pelo MESMO IP publico: bloquear por
           * endereco derrubaria o irmao junto. O token identifica o navegador
           * especifico. O IP so entra quando nao ha token — navegador sem
           * armazenamento — assumindo o risco nesse caso raro.
           */
          if (target.clientToken) room.blocked.add(target.clientToken)
          else room.blocked.add(target.ip)
        }

        sendError(
          target.socket,
          message.block ? 'blocked' : 'kicked',
          message.block
            ? 'o host bloqueou voce nesta sala'
            : 'o host removeu voce da sala'
        )
        target.socket.close(message.block ? 4003 : 4002, 'removido pelo host')
        log(
          `host removeu ${target.name} da sala ${room.code}` +
            (message.block ? ' (bloqueado)' : '')
        )
        return
      }

      case 'leave': {
        socket.close(1000, 'saiu')
        return
      }
    }
  })

  const heartbeat = setInterval(() => {
    // Heartbeat por conexao: derruba socket zumbi (queda de rede sem FIN).
    if (!alive) {
      socket.terminate()
      return
    }
    alive = false
    socket.ping()
  }, HEARTBEAT_MS)

  socket.on('close', () => {
    clearInterval(heartbeat)
    if (!client) return
    const room = rooms.get(client.roomCode)
    if (!room) return

    /**
     * A mesma pessoa ja voltou e ocupou este id?
     *
     * Reconexao rapida entrega o `close` do socket velho DEPOIS do `join` do
     * novo. Sem esta checagem de identidade do objeto, a saida do socket morto
     * apagaria a conexao viva e mandaria um `peer-left` que derruba a
     * transmissao de quem acabou de voltar.
     */
    if (room.clients.get(client.id) !== client) return

    room.clients.delete(client.id)
    broadcast(room, { type: 'peer-left', peerId: client.id })

    if (client.role === 'host') {
      room.hostId = null
      // Nao derruba a sala na hora: quem esta assistindo continua conectado e o
      // host tem HOST_GRACE_MS para voltar com o mesmo link.
      room.graceTimer = setTimeout(() => closeRoom(room, 'o host saiu'), HOST_GRACE_MS)
      log(
        `host saiu da sala ${room.code}; aguardando retomada por ${HOST_GRACE_MS / 1000}s`
      )
    } else if (room.clients.size === 0 && !room.hostId && !room.graceTimer) {
      /**
       * `!room.graceTimer` e o que faltava, e custou uma sessao inteira.
       *
       * Quando o tunel cai, host e espectadores perdem o socket no MESMO
       * instante. O host saia primeiro (armando a janela de retomada) e o
       * espectador logo atras — e este ramo, sem olhar a janela, apagava a sala
       * com um `sala vazia` que cancelava o proprio timer de graca. O host
       * voltava, nao achava a sala, criava outra com codigo NOVO, e todo mundo
       * que ainda estava com o link antigo via "sala nao encontrada".
       *
       * Sala vazia durante a janela de retomada nao e sala abandonada: e
       * exatamente o estado que a janela existe para cobrir.
       */
      closeRoom(room, 'sala vazia')
    }
  })

  socket.on('error', (err) => log('erro de socket:', err.message))
})

httpServer.listen(PORT, BIND, async () => {
  const ice = await buildIceServers()
  const hasTurn = ice.some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn'))
  )
  log(`signaling ouvindo em http://${BIND}:${PORT} (ws://${BIND}:${PORT}/ws)`)
  log(
    `ICE: ${ice.length} servidor(es); TURN ${hasTurn ? 'configurado' : 'AUSENTE (ok em LAN, falha em CGNAT)'}`
  )
  log(
    webRoot
      ? `viewer web sendo servido daqui: ${webRoot}`
      : 'viewer web NAO encontrado (rode: npm run build -w @junto/web)'
  )
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log('encerrando...')
    for (const room of [...rooms.values()]) closeRoom(room, 'servidor reiniciando')
    httpServer.close(() => process.exit(0))
  })
}
