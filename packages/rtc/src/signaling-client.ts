import {
  parseServerMessage,
  type ClientMessage,
  type IceServer,
  type Peer,
  type Role,
  type ServerMessage,
  type SignalPayload
} from '@junto/protocol'

/**
 * Cliente do servidor de signaling, com reconexao automatica.
 *
 * Sessoes longas (o caso de uso principal) significam que a conexao VAI cair em
 * algum momento: Wi-Fi oscila, notebook dorme, provedor renumera. O objetivo aqui
 * e que isso nao vire "manda o link de novo pra todo mundo".
 */

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'

export interface WelcomeInfo {
  selfId: string
  roomCode: string
  role: Role
  peers: Peer[]
  iceServers: IceServer[]
  hostToken?: string
}

interface EventMap {
  status: ConnectionStatus
  welcome: WelcomeInfo
  'peer-joined': Peer
  'peer-left': string
  signal: { from: string; payload: SignalPayload }
  error: { code: string; message: string }
  rtt: number
}

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void

type Intent =
  | { kind: 'create'; name: string; password?: string }
  | { kind: 'join'; roomCode: string; name: string; password?: string }

const CLIENT_TOKEN_KEY = 'junto:client-token'

/**
 * Identidade fraca e persistente do navegador.
 *
 * O id de peer muda a cada conexao, entao bloquear por ele nao serviria de nada —
 * bastaria recarregar a pagina. Este token sobrevive ao reload e da ao bloqueio
 * algum efeito pratico. Quem apagar os dados do navegador escapa, e tudo bem:
 * isto e para tirar alguem inconveniente da sala, nao para conter um invasor.
 */
function clientToken(): string | undefined {
  try {
    const guardado = localStorage.getItem(CLIENT_TOKEN_KEY)
    if (guardado) return guardado
    const novo = crypto.randomUUID()
    localStorage.setItem(CLIENT_TOKEN_KEY, novo)
    return novo
  } catch {
    // Navegador com armazenamento bloqueado: segue sem token.
    return undefined
  }
}

const HOST_ROOM_KEY = 'junto:host-room'
/** Precisa caber um restart do app; a janela real quem define e o servidor. */
const HOST_ROOM_TTL_MS = 5 * 60 * 1000

interface SavedRoom {
  roomCode: string
  hostToken: string
  at: number
}

/**
 * Guarda a sala do host em disco (localStorage), nao so em memoria.
 *
 * Sem isto, fechar e abrir o app criava uma sala NOVA e todo mundo que estava
 * assistindo via "o host saiu" — mesmo o servidor ainda segurando a sala antiga
 * esperando a retomada. O link que voce mandou para os amigos continuava valido
 * do lado deles e morto do seu.
 */
function loadHostRoom(): SavedRoom | null {
  try {
    const raw = localStorage.getItem(HOST_ROOM_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedRoom
    if (!parsed.roomCode || !parsed.hostToken) return null
    if (Date.now() - parsed.at > HOST_ROOM_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function saveHostRoom(roomCode: string, hostToken: string): void {
  try {
    localStorage.setItem(
      HOST_ROOM_KEY,
      JSON.stringify({ roomCode, hostToken, at: Date.now() } satisfies SavedRoom)
    )
  } catch {
    // Sem armazenamento: perde a continuidade, mas o app segue funcionando.
  }
}

function clearHostRoom(): void {
  try {
    localStorage.removeItem(HOST_ROOM_KEY)
  } catch {
    // ignorado de proposito
  }
}

const RECONNECT_BASE_MS = 800
const RECONNECT_MAX_MS = 15_000
const PING_INTERVAL_MS = 5_000

export class SignalingClient {
  private socket: WebSocket | null = null
  private handlers = new Map<keyof EventMap, Set<Handler<never>>>()
  private intent: Intent | null = null
  private hostToken: string | null = null
  private roomCode: string | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private closedByUser = false
  /**
   * Ter socket aberto NAO significa estar numa sala. Enquanto essa distincao nao
   * existia, o cliente continuava mandando ICE depois de uma retomada recusada e
   * o servidor respondia "entre numa sala antes de sinalizar" em looping.
   */
  private inRoom = false

  status: ConnectionStatus = 'idle'
  serverRttMs = 0

  constructor(private readonly url: string) {}

  // -- eventos ---------------------------------------------------------------

  on<K extends keyof EventMap>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler as Handler<never>)
    return () => set!.delete(handler as Handler<never>)
  }

  private emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      ;(handler as Handler<K>)(payload)
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  // -- ciclo de vida ---------------------------------------------------------

  /** Cria uma sala nova e vira host dela. */
  createRoom(name: string, password?: string): void {
    this.intent = { kind: 'create', name, password }
    this.closedByUser = false

    // Se o app acabou de reiniciar, tenta voltar para a MESMA sala — o link que
    // ja esta com os amigos continua valendo.
    const salva = loadHostRoom()
    if (salva) {
      this.roomCode = salva.roomCode
      this.hostToken = salva.hostToken
    }

    this.connect()
  }

  /** Entra numa sala existente como viewer. */
  joinRoom(roomCode: string, name: string, password?: string): void {
    this.intent = { kind: 'join', roomCode, name, password }
    this.closedByUser = false
    this.connect()
  }

  close(): void {
    this.closedByUser = true
    this.inRoom = false
    this.clearTimers()
    this.socket?.close(1000, 'saiu')
    this.socket = null
    this.setStatus('closed')
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  /** Host removendo alguem. Com `block`, a pessoa nao volta nesta sala. */
  kick(peerId: string, block: boolean): void {
    this.send({ type: 'kick', peerId, block })
  }

  signal(to: string, payload: SignalPayload): void {
    // Fora de uma sala isto seria rejeitado pelo servidor; candidatos ICE
    // continuam pipocando por segundos depois de uma queda e nao vale inundar.
    if (!this.inRoom) return
    this.send({ type: 'signal', to, payload })
  }

  private connect(): void {
    this.clearTimers()
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      this.reconnectAttempt = 0
      this.sendIntent()
      this.pingTimer = setInterval(() => {
        this.send({ type: 'ping', t: Date.now() })
      }, PING_INTERVAL_MS)
    }

    socket.onmessage = (event) => {
      const message = parseServerMessage(String(event.data))
      if (message) this.handleMessage(message)
    }

    socket.onclose = () => {
      this.clearTimers()
      this.inRoom = false
      if (this.closedByUser) {
        this.setStatus('closed')
        return
      }
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // onclose vem logo em seguida e cuida da reconexao.
    }
  }

  private sendIntent(): void {
    if (!this.intent) return
    if (this.intent.kind === 'create') {
      // Se ja tivemos uma sala, tenta retomar o MESMO codigo em vez de gerar outro.
      const resume =
        this.roomCode && this.hostToken
          ? { roomCode: this.roomCode, hostToken: this.hostToken }
          : undefined
      this.send({
        type: 'create',
        name: this.intent.name,
        password: this.intent.password,
        resume
      })
    } else {
      this.send({
        type: 'join',
        roomCode: this.intent.roomCode,
        name: this.intent.name,
        password: this.intent.password,
        clientToken: clientToken()
      })
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.roomCode = message.roomCode
        this.inRoom = true
        if (message.hostToken) {
          this.hostToken = message.hostToken
          saveHostRoom(message.roomCode, message.hostToken)
        }
        this.setStatus('connected')
        this.emit('welcome', {
          selfId: message.selfId,
          roomCode: message.roomCode,
          role: message.role,
          peers: message.peers,
          iceServers: message.iceServers,
          hostToken: message.hostToken
        })
        return
      case 'peer-joined':
        this.emit('peer-joined', message.peer)
        return
      case 'peer-left':
        this.emit('peer-left', message.peerId)
        return
      case 'signal':
        this.emit('signal', { from: message.from, payload: message.payload })
        return
      case 'pong':
        this.serverRttMs = Date.now() - message.t
        this.emit('rtt', this.serverRttMs)
        return
      case 'error': {
        // Removido ou bloqueado nao e falha de rede: insistir em reconectar so
        // produziria um app tentando voltar para onde nao e mais bem-vindo.
        if (message.code === 'kicked' || message.code === 'blocked') {
          this.closedByUser = true
          this.inRoom = false
          this.clearTimers()
          this.emit('error', { code: message.code, message: message.message })
          this.setStatus('closed')
          return
        }

        const perdeuASala =
          message.code === 'room-not-found' || message.code === 'host-taken'

        if (perdeuASala) {
          this.hostToken = null
          this.roomCode = null
          this.inRoom = false
          clearHostRoom()

          /**
           * Retomada recusada (a sala expirou enquanto estavamos fora).
           *
           * Antes o cliente parava aqui: socket aberto, sem sala, status travado
           * em "reconectando" para sempre. Agora ele pede uma sala NOVA na hora.
           * Nao ha risco de looping porque este segundo pedido vai sem token de
           * retomada, e criar sala sempre funciona.
           */
          if (this.intent?.kind === 'create') {
            this.sendIntent()
            return
          }
        }

        this.emit('error', { code: message.code, message: message.message })
        return
      }
    }
  }

  private scheduleReconnect(): void {
    this.setStatus('reconnecting')
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_MS
    )
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.reconnectTimer = null
    this.pingTimer = null
  }
}
