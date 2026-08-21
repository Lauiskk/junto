import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Serve o viewer web pelo MESMO processo e pela MESMA porta do signaling.
 *
 * Isso existe para tornar a publicacao possivel na pratica. Com dois servicos em
 * portas diferentes, colocar o app no ar exige proxy reverso ou dois tuneis, e o
 * viewer ainda teria que adivinhar onde fica o WebSocket. Com tudo numa origem
 * so, o endereco do signaling e sempre "wss://<o mesmo host>/ws" — e mandar o
 * link para os amigos passa a ser mandar UM link.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

export function resolveWebRoot(): string | null {
  const configured = process.env.JUNTO_WEB_DIR
  if (configured) return existsSync(configured) ? resolve(configured) : null

  // Layout padrao do monorepo, a partir de server/signaling/dist/.
  const guess = resolve(import.meta.dirname, '../../../apps/web/dist')
  return existsSync(guess) ? guess : null
}

/**
 * Retorna true se serviu o arquivo. Falso significa "nao e minha
 * responsabilidade" — quem chama decide o 404.
 */
export function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  const requested = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let filePath = join(root, requested)

  // Barreira contra path traversal: depois de resolver, o caminho tem que
  // continuar dentro da raiz. Sem isto, "/../../.env" seria servido.
  if (!resolve(filePath).startsWith(resolve(root) + sep) && resolve(filePath) !== resolve(root)) {
    res.writeHead(403).end('acesso negado')
    return true
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, 'index.html')
  }

  // Fallback de SPA: qualquer rota desconhecida devolve o index, para que
  // /?sala=XXXXXX funcione mesmo recarregando a pagina.
  if (!existsSync(filePath)) filePath = join(root, 'index.html')
  if (!existsSync(filePath)) return false

  const ext = extname(filePath)
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // Os assets do Vite tem hash no nome, entao podem ser cacheados para sempre.
    // O index.html nao pode, senao uma atualizacao nunca chegaria.
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable'
  })

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  createReadStream(filePath).pipe(res)
  return true
}
