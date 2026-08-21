import type { IceServer } from '@junto/protocol'

/**
 * Diagnostico de rede, feito ANTES de entrar na sala.
 *
 * Este arquivo existe por causa de um modo de falha especifico e cruel: em
 * CGNAT (internet movel e varios provedores brasileiros), a conexao direta nao
 * fecha e, sem TURN, o app simplesmente nao conecta — sem erro, sem mensagem,
 * so uma tela preta eterna. Do lado de quem usa, parece que "o app nao
 * funciona".
 *
 * Rodar esta checagem transforma isso numa frase objetiva: "seu provedor exige
 * TURN e o TURN nao esta configurado".
 */

export interface NetworkCheckResult {
  /** Descobriu o proprio IP publico: a maioria das redes domesticas conecta direto. */
  stunOk: boolean
  /** Existe TURN configurado no servidor. */
  turnConfigured: boolean
  /** O TURN respondeu e alocou relay — a rede de seguranca funciona. */
  turnOk: boolean
  /** Conseguiu candidato direto (host/srflx) alem do relay. */
  directPossible: boolean
  candidateTypes: string[]
  durationMs: number
  /** Frase pronta para mostrar a quem nao conhece WebRTC. */
  verdict: string
}

interface Gathered {
  types: Set<string>
}

/**
 * Junta candidatos ICE ate a coleta terminar ou estourar o tempo.
 * Um data channel e necessario: sem midia nem canal, nao ha o que negociar e o
 * navegador nao coleta nada.
 */
async function gather(
  iceServers: IceServer[],
  policy: RTCIceTransportPolicy,
  timeoutMs: number
): Promise<Gathered> {
  const pc = new RTCPeerConnection({
    iceServers: iceServers as RTCIceServer[],
    iceTransportPolicy: policy
  })
  const types = new Set<string>()

  try {
    pc.createDataChannel('probe')

    const finished = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          clearTimeout(timer)
          resolve()
          return
        }
        const type = event.candidate.type
        if (type) types.add(type)
        // Achou relay: e a resposta que interessa, nao precisa esperar o resto.
        if (policy === 'relay' && type === 'relay') {
          clearTimeout(timer)
          resolve()
        }
      }
    })

    await pc.setLocalDescription(await pc.createOffer())
    await finished
  } finally {
    pc.close()
  }

  return { types }
}

export async function checkNetwork(
  iceServers: IceServer[],
  timeoutMs = 8000
): Promise<NetworkCheckResult> {
  const startedAt = Date.now()

  const turnConfigured = iceServers.some((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) =>
      url.startsWith('turn')
    )
  )

  const all = await gather(iceServers, 'all', timeoutMs)

  // Segunda rodada forcando relay: e a unica forma de saber se o TURN funciona
  // de verdade. Na primeira rodada o navegador pode nem tentar o TURN quando ja
  // conseguiu um caminho direto.
  let turnOk = false
  if (turnConfigured) {
    const relayOnly = await gather(iceServers, 'relay', timeoutMs)
    turnOk = relayOnly.types.has('relay')
    for (const type of relayOnly.types) all.types.add(type)
  }

  const candidateTypes = [...all.types]
  const stunOk = all.types.has('srflx')
  const directPossible = all.types.has('host') || stunOk

  let verdict: string
  if (turnOk) {
    verdict = 'Conexao garantida: caminho direto e TURN funcionando.'
  } else if (directPossible && turnConfigured) {
    verdict =
      'Caminho direto ok, mas o TURN nao respondeu. Vai funcionar na maioria das redes e falhar em 4G/CGNAT.'
  } else if (directPossible) {
    verdict =
      'Caminho direto ok. Sem TURN configurado — quem estiver em 4G ou CGNAT pode nao conseguir conectar.'
  } else {
    verdict = 'Nenhum caminho de rede encontrado. Verifique firewall e conexao.'
  }

  return {
    stunOk,
    turnConfigured,
    turnOk,
    directPossible,
    candidateTypes,
    durationMs: Date.now() - startedAt,
    verdict
  }
}

/** Busca a configuracao de ICE no servidor de signaling. */
export async function fetchIceServers(signalingUrl: string): Promise<IceServer[]> {
  const httpUrl = signalingUrl.replace(/^ws/, 'http').replace(/\/ws$/, '/ice')
  const response = await fetch(httpUrl)
  if (!response.ok) throw new Error(`servidor respondeu ${response.status}`)
  const data = (await response.json()) as { iceServers?: IceServer[] }
  return data.iceServers ?? []
}
