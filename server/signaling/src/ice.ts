import { createHmac } from 'node:crypto'
import type { IceServer } from '@junto/protocol'

/**
 * Monta a lista de servidores ICE entregue aos clientes.
 *
 * STUN resolve a maioria das redes domesticas (o par fecha conexao direta).
 * TURN e a rede de seguranca para NAT simetrico / CGNAT — comum em internet movel
 * e em varios provedores brasileiros. Sem TURN, esses usuarios simplesmente nao
 * conseguem conectar, e o sintoma parece "o app nao funciona".
 *
 * Isso deixou de ser hipotese: um amigo tentou entrar pelo iPhone em 4G e ficou
 * em "Conectando..." para sempre. Nao havia bug de codigo nenhum — faltava para
 * onde relayar.
 *
 * Tres caminhos, nesta ordem de preferencia:
 *
 *  1. Cloudflare Realtime TURN (gerenciado, 1000 GB/mes gratis)
 *  2. coturn proprio com segredo compartilhado (credenciais efemeras)
 *  3. coturn proprio com usuario e senha fixos
 */

/**
 * O TURN da Cloudflare devolve URLs em varias portas, inclusive a 53. A propria
 * documentacao avisa que navegadores bloqueiam essa porta — e cada URL
 * bloqueada vira segundos de espera no gathering de candidatos, justamente na
 * hora em que a pessoa esta olhando para "Conectando...".
 */
const PORTA_BLOQUEADA = /:53(\?|$)/

interface CachedIce {
  servers: IceServer[]
  expiraEm: number
}

let cacheCloudflare: CachedIce | null = null
let buscaEmVoo: Promise<IceServer[] | null> | null = null

function stunServers(): IceServer[] {
  const stunUrls = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)

  return stunUrls.length > 0 ? [{ urls: stunUrls }] : []
}

/**
 * Credenciais de curta duracao da Cloudflare.
 *
 * Cacheadas porque cada `welcome` e cada `/ice` chamariam a API — com uma sala
 * cheia isso viraria dezenas de requisicoes por minuto para gerar credenciais
 * praticamente identicas. Renovamos a 80% do TTL para nunca entregar uma
 * credencial que expira no meio da sessao de alguem.
 */
async function cloudflareTurn(): Promise<IceServer[] | null> {
  const keyId = process.env.CF_TURN_KEY_ID
  const token = process.env.CF_TURN_API_TOKEN
  if (!keyId || !token) return null

  if (cacheCloudflare && Date.now() < cacheCloudflare.expiraEm) {
    return cacheCloudflare.servers
  }
  // Varias conexoes chegando juntas nao devem virar varias chamadas a API.
  if (buscaEmVoo) return buscaEmVoo

  const ttlSec = Number(process.env.CF_TURN_TTL_SECONDS ?? 12 * 60 * 60)

  buscaEmVoo = (async () => {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl: ttlSec }),
          signal: AbortSignal.timeout(5000)
        }
      )

      if (!response.ok) {
        console.warn(`[ice] Cloudflare TURN respondeu ${response.status}; seguindo so com STUN`)
        return null
      }

      const data = (await response.json()) as { iceServers?: IceServer | IceServer[] }
      // A API devolve um objeto; aceitar array tambem evita quebrar se mudar.
      const bruto = data.iceServers
      const lista = Array.isArray(bruto) ? bruto : bruto ? [bruto] : []

      const servers: IceServer[] = []
      for (const server of lista) {
        const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
          (url) => typeof url === 'string' && !PORTA_BLOQUEADA.test(url)
        )
        if (urls.length > 0) servers.push({ ...server, urls })
      }

      if (servers.length === 0) return null

      cacheCloudflare = { servers, expiraEm: Date.now() + ttlSec * 800 }
      console.log(`[ice] credenciais TURN da Cloudflare renovadas (ttl ${ttlSec}s)`)
      return servers
    } catch (err) {
      // Nunca derruba o servidor: sem TURN o app ainda funciona na maioria das
      // redes domesticas, e o diagnostico do viewer explica o resto.
      console.warn('[ice] falha ao buscar TURN da Cloudflare:', err)
      return null
    } finally {
      buscaEmVoo = null
    }
  })()

  return buscaEmVoo
}

function coturn(): IceServer[] {
  const turnUrls = (process.env.TURN_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)

  if (turnUrls.length === 0) return []

  const secret = process.env.TURN_SECRET
  if (secret) {
    // Credenciais efemeras (REST API do coturn): usuario = "<expiracao>:<id>",
    // senha = HMAC-SHA1 do usuario. Assim o segredo do TURN nunca sai do servidor
    // e um link vazado expira sozinho.
    const ttlSec = Number(process.env.TURN_TTL_SECONDS ?? 12 * 60 * 60)
    const username = `${Math.floor(Date.now() / 1000) + ttlSec}:junto`
    const credential = createHmac('sha1', secret).update(username).digest('base64')
    return [{ urls: turnUrls, username, credential }]
  }

  const username = process.env.TURN_USERNAME
  const credential = process.env.TURN_PASSWORD
  if (username && credential) return [{ urls: turnUrls, username, credential }]

  return []
}

export async function buildIceServers(): Promise<IceServer[]> {
  const servers = stunServers()

  const cloudflare = await cloudflareTurn()
  if (cloudflare) {
    servers.push(...cloudflare)
    return servers
  }

  servers.push(...coturn())
  return servers
}

/** true quando existe algum TURN configurado — usado no log de inicializacao. */
export function turnConfigured(): boolean {
  return Boolean(
    (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_API_TOKEN) ||
      (process.env.TURN_URLS ?? '').trim()
  )
}
