import { z } from 'zod'

/**
 * Protocolo do Junto.
 *
 * Duas camadas, propositalmente separadas:
 *
 *  1. SIGNALING (este servidor, via WebSocket) — apenas texto: quem esta na sala e
 *     troca de SDP/ICE. O servidor NUNCA ve midia.
 *  2. CONTROL (via RTCDataChannel, P2P) — chat, estado do player, sync de relogio e
 *     stats do viewer. Nao passa pelo servidor.
 */

// ---------------------------------------------------------------------------
// Sala
// ---------------------------------------------------------------------------

/** Alfabeto sem caracteres ambiguos (0/O, 1/I/L) para codigo ditado por voz. */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const ROOM_CODE_LENGTH = 6

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(ROOM_CODE_LENGTH)
  .regex(new RegExp(`^[${ROOM_CODE_ALPHABET}]+$`), 'codigo de sala invalido')

export const roleSchema = z.enum(['host', 'viewer'])
export type Role = z.infer<typeof roleSchema>

export const peerSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: roleSchema,
  joinedAt: z.number()
})
export type Peer = z.infer<typeof peerSchema>

export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional()
})
export type IceServer = z.infer<typeof iceServerSchema>

// ---------------------------------------------------------------------------
// Signaling: payload opaco (o servidor so repassa)
// ---------------------------------------------------------------------------

export const signalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sdp'),
    type: z.enum(['offer', 'answer']),
    sdp: z.string()
  }),
  z.object({
    kind: z.literal('ice'),
    /** RTCIceCandidateInit; null sinaliza fim de candidatos. */
    candidate: z.unknown().nullable()
  }),
  /**
   * Pedido de oferta nova, do viewer para o host.
   *
   * Quem responde a oferta nao pode reiniciar o ICE sozinho — so quem oferta
   * pode. Sem este pedido, um viewer que travou em `checking` so tinha uma
   * saida: recarregar a pagina. Com ele, a propria pagina se recupera, e o
   * `relay` avisa ao host que ja tentamos caminho direto e falhamos.
   */
  z.object({
    kind: z.literal('renegotiate'),
    /** true = por favor, ofereca ja contando com TURN. */
    relay: z.boolean().optional(),
    /**
     * true = nao tenho conexao nenhuma deste lado (aba recarregada, primeira
     * entrada). O host precisa CONSTRUIR uma conexao nova, nao reiniciar o ICE
     * de uma que so existe para ele.
     */
    fresh: z.boolean().optional()
  })
])
export type SignalPayload = z.infer<typeof signalPayloadSchema>

// ---------------------------------------------------------------------------
// Cliente -> Servidor
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create'),
    name: z.string().min(1).max(40),
    password: z.string().max(100).optional(),
    /**
     * Retomada de sala: se a conexao do host cair (Wi-Fi, sleep, restart do app),
     * ele volta com o MESMO codigo dentro da janela de graca, em vez de mandar um
     * link novo para todo mundo no meio da sessao.
     */
    resume: z
      .object({ roomCode: roomCodeSchema, hostToken: z.string() })
      .optional()
  }),
  z.object({
    type: z.literal('join'),
    roomCode: roomCodeSchema,
    name: z.string().min(1).max(40),
    password: z.string().max(100).optional(),
    /**
     * Identificador que o navegador guarda e reenvia. E o que permite bloquear
     * alguem de fato: o id de peer muda a cada conexao, entao sozinho ele nao
     * serviria para nada. Nao e a prova de tudo (limpar o navegador zera), mas
     * resolve o caso real de tirar alguem da sala.
     */
    clientToken: z.string().max(80).optional()
  }),
  z.object({
    type: z.literal('signal'),
    to: z.string(),
    payload: signalPayloadSchema
  }),
  z.object({ type: z.literal('leave') }),
  /**
   * Host tirando alguem da sala.
   *
   * Dois niveis de proposito: com block=false a pessoa pode voltar pelo mesmo
   * link (util para destravar uma conexao emperrada); com block=true ela nao
   * volta mais naquela sala.
   */
  z.object({
    type: z.literal('kick'),
    peerId: z.string(),
    block: z.boolean()
  }),
  z.object({ type: z.literal('ping'), t: z.number() })
])
export type ClientMessage = z.infer<typeof clientMessageSchema>

// ---------------------------------------------------------------------------
// Servidor -> Cliente
// ---------------------------------------------------------------------------

export const errorCodeSchema = z.enum([
  'room-not-found',
  'room-full',
  'bad-password',
  'already-in-room',
  'host-taken',
  'invalid-message',
  'rate-limited',
  'kicked',
  'blocked',
  'not-host',
  'internal'
])
export type ErrorCode = z.infer<typeof errorCodeSchema>

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    selfId: z.string(),
    roomCode: z.string(),
    role: roleSchema,
    /** Quem ja estava na sala (nao inclui voce). */
    peers: z.array(peerSchema),
    iceServers: z.array(iceServerSchema),
    /** So para o host: segredo que permite retomar esta sala apos queda. */
    hostToken: z.string().optional()
  }),
  z.object({ type: z.literal('peer-joined'), peer: peerSchema }),
  z.object({ type: z.literal('peer-left'), peerId: z.string() }),
  z.object({
    type: z.literal('signal'),
    from: z.string(),
    payload: signalPayloadSchema
  }),
  z.object({
    type: z.literal('error'),
    code: errorCodeSchema,
    message: z.string()
  }),
  z.object({ type: z.literal('pong'), t: z.number(), serverTime: z.number() })
])
export type ServerMessage = z.infer<typeof serverMessageSchema>

// ---------------------------------------------------------------------------
// Control channel (P2P, via RTCDataChannel)
// ---------------------------------------------------------------------------

export const CONTROL_CHANNEL_LABEL = 'junto-control'

export const sourceKindSchema = z.enum(['screen', 'window', 'file', 'none'])
export type SourceKind = z.infer<typeof sourceKindSchema>

export const controlMessageSchema = z.discriminatedUnion('type', [
  /** Host anuncia o que esta transmitindo (aparece no viewer sem precisar de chat). */
  z.object({
    type: z.literal('source-state'),
    kind: sourceKindSchema,
    title: z.string(),
    hasAudio: z.boolean(),
    /** Preset ativo, so para exibicao no HUD do viewer. */
    preset: z.string().optional()
  }),

  /**
   * Estado do player, base do Modo Cinema (fase 4/6).
   * hostTimeMs e o relogio do host no instante do envio; o viewer converte usando
   * o offset estimado em clock-ping/pong antes de comparar com o proprio relogio.
   */
  z.object({
    type: z.literal('player-state'),
    state: z.enum(['playing', 'paused', 'ended']),
    positionSec: z.number(),
    durationSec: z.number().nullable(),
    hostTimeMs: z.number()
  }),

  /** Sync de relogio estilo NTP: t0 = saida do viewer, t1 = chegada no host. */
  z.object({ type: z.literal('clock-ping'), id: z.number(), t0: z.number() }),
  z.object({
    type: z.literal('clock-pong'),
    id: z.number(),
    t0: z.number(),
    t1: z.number()
  }),

  /**
   * Viewer reporta o que esta realmente recebendo. E isso que deixa o HUD do host
   * util: da pra ver o gargalo do OUTRO lado, nao so o seu.
   */
  z.object({
    type: z.literal('viewer-stats'),
    fps: z.number(),
    width: z.number(),
    height: z.number(),
    kbps: z.number(),
    packetsLostPct: z.number(),
    jitterMs: z.number(),
    freezeCount: z.number()
  }),

  z.object({
    type: z.literal('chat'),
    text: z.string().max(2000),
    at: z.number(),
    /**
     * Preenchido pelo host ao retransmitir. Espectadores nao se enxergam — todo
     * mundo fala so com o host —, entao e ele quem carimba quem falou e repassa
     * para os demais. Um espectador nao consegue se passar por outro.
     */
    from: z.string().max(40).optional()
  }),

  // ------------------------------------------------------------- Modo Cinema
  //
  // Em vez de recodificar o filme e mandar pixels (limitado pelo upload do
  // host), mandamos os BYTES ORIGINAIS uma vez e cada um reproduz localmente.
  // A qualidade passa a ser a do arquivo, nao a da rede, e o que trafega depois
  // e so a posicao do player.

  /** Host anuncia um filme disponivel para baixar. */
  z.object({
    type: z.literal('film-offer'),
    name: z.string().max(300),
    size: z.number().int().nonnegative(),
    mimeType: z.string().max(120),
    durationSec: z.number().nullable()
  }),
  /**
   * Viewer aceita e pede o envio.
   *
   * `from` e a posicao de onde continuar, em bytes. Quem recebe e o unico que
   * sabe quanto ja tem — por isso e ele quem dita o ponto de partida. Ausente
   * ou 0 significa "manda desde o comeco".
   */
  z.object({
    type: z.literal('film-accept'),
    from: z.number().int().nonnegative().optional()
  }),
  /** Progresso do download, para o host ver quem ja pode comecar. */
  z.object({
    type: z.literal('film-progress'),
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  }),
  /** Viewer tem o arquivo inteiro e esta pronto para tocar em sincronia. */
  z.object({ type: z.literal('film-ready') }),
  z.object({ type: z.literal('film-cancel'), reason: z.string().max(200).optional() })
])
export type ControlMessage = z.infer<typeof controlMessageSchema>

/** Canal de dados dedicado aos bytes do filme (binario, ordenado, confiavel). */
export const FILM_CHANNEL_LABEL = 'junto-film'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidRoomCode(code: string): boolean {
  return roomCodeSchema.safeParse(code).success
}

/** Parse defensivo: entrada de rede nunca vira objeto tipado sem validacao. */
export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    return serverMessageSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    return clientMessageSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function parseControlMessage(raw: string): ControlMessage | null {
  try {
    return controlMessageSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Mapa de trilhas da conexao
// ---------------------------------------------------------------------------

/**
 * O host cria SEMPRE tres transceivers, nesta ordem, no momento em que o
 * espectador entra — mesmo antes de existir qualquer midia. Isso fixa os "mid"
 * do SDP e da dois ganhos:
 *
 *  1. Comecar/parar de transmitir, trocar de fonte ou ligar o microfone nunca
 *     renegocia SDP (basta replaceTrack), o que elimina tela preta e travadas.
 *  2. Quem recebe consegue distinguir SOM DO SISTEMA de VOZ — as duas sao
 *     trilhas de audio e, sem esse mapa, chegariam indistinguiveis, impedindo
 *     ter controle de volume separado para cada uma.
 */
export const MID_VIDEO = '0'
export const MID_SYSTEM_AUDIO = '1'
export const MID_VOICE = '2'
