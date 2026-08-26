import type { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

/**
 * Ponte entre o modulo nativo e o renderer.
 *
 * Existe para resolver o vazamento de audio: compartilhando UMA janela, o app
 * mandava o som do sistema inteiro — numa sessao real a chamada de Discord do
 * usuario foi ouvida por quem assistia. Aqui o audio passa a vir do processo
 * dono da janela escolhida, e de mais ninguem.
 *
 * Depois vieram duas exigencias que a API do Windows nao atende de frente,
 * porque os parametros de ativacao carregam UM alvo por captura:
 *
 *  - silenciar MAIS DE UM aplicativo;
 *  - nunca devolver o audio da propria sala (o app toca a voz de cada
 *    espectador pelos alto-falantes; capturado de volta, todos se ouvem com
 *    atraso).
 *
 * Os dois se resolvem pela mesma inversao: em vez de excluir, capturar uma a
 * uma as aplicacoes que devem ser ouvidas e somar. E o que esta aqui embaixo em
 * `startSystemAudio`.
 */

interface AudioSession {
  pid: number
  executable: string
}

interface NativeAudio {
  disponivel(): boolean
  erroDeCarregamento(): string | null
  pidFromWindowId(sourceId: string): number | null
  currentProcessId(): number | null
  ownProcessTree(): number[]
  listAudioSessions(): AudioSession[]
  startCapture(
    options: { excludePid?: number; includePids?: number[] },
    onPcm: (chunk: Buffer) => void
  ): boolean
  setIncludePids(pids: number[]): boolean
  stopCapture(): boolean
  capturando(): boolean
  ultimoErro(): string | null
  formato(): { sampleRate: number; channels: number; bitsPerSample: number }
}

/**
 * `__filename` e nao `import.meta.url`: o processo main e empacotado como
 * CommonJS (o mesmo motivo pelo qual `__dirname` funciona no index.ts). Com
 * import.meta aqui, o app quebraria em runtime, nao na compilacao.
 */
const require_ = createRequire(__filename)

/**
 * O carregamento nunca pode derrubar o app: sem o addon (Windows antigo, build
 * que falhou), o host segue funcionando com o audio do sistema e a interface
 * avisa do risco.
 */
let native: NativeAudio | null = null
let loadError: string | null = null

try {
  native = require_('@junto/native-audio') as NativeAudio
  if (!native.disponivel()) {
    loadError = native.erroDeCarregamento() ?? 'modulo nativo indisponivel'
    native = null
  }
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}

export interface ProcessAudioStatus {
  available: boolean
  capturing: boolean
  pid: number | null
  /** Executaveis silenciados agora, em minusculas. */
  muted: string[]
  error: string | null
  format: { sampleRate: number; channels: number; bitsPerSample: number }
}

let capturingPid: number | null = null
let mutedExecutables: string[] = []
let rescanTimer: ReturnType<typeof setInterval> | null = null

export function processAudioStatus(): ProcessAudioStatus {
  return {
    available: native !== null,
    capturing: capturingPid !== null || rescanTimer !== null,
    pid: capturingPid,
    muted: mutedExecutables,
    error: loadError ?? native?.ultimoErro() ?? null,
    format: native?.formato() ?? { sampleRate: 48000, channels: 2, bitsPerSample: 16 }
  }
}

/** "window:<HWND>:0" -> pid, quando a fonte e uma janela. */
export function pidForSource(sourceId: string): number | null {
  if (!native || !sourceId.startsWith('window:')) return null
  return native.pidFromWindowId(sourceId)
}

/** Processos com stream de audio aberta agora — a lista sobre a qual agir. */
export function audioSessions(): AudioSession[] {
  return native?.listAudioSessions() ?? []
}

/** Este processo e todos os filhos — o conjunto que nunca deve ser capturado. */
export function ownProcessTree(): number[] {
  return native?.ownProcessTree() ?? []
}

/**
 * Quais processos devem ser CAPTURADOS: todos os que tem audio aberto, menos o
 * nosso e menos os que o usuario silenciou.
 *
 * O casamento e pelo NOME DO EXECUTAVEL, e nao por PID, e isso importa: o
 * Discord aparece com dois processos, e o Chromium renderiza audio num processo
 * filho de servico. Silenciar "Discord" precisa pegar todos eles — foi medido:
 * a mesma maquina listou `Discord.exe` em dois PIDs diferentes ao mesmo tempo.
 */
function pidsParaCapturar(muted: string[]): number[] {
  if (!native) return []

  /**
   * A ARVORE inteira, nao so o processo principal.
   *
   * O Chromium renderiza audio num processo filho de servico — nesta maquina o
   * Electron roda com quatro processos. Excluir apenas o principal deixaria o
   * proprio som do app passar, que e exatamente o eco que isto existe para
   * evitar: ele toca a voz de cada espectador, captura de volta, e todos se
   * ouvem com atraso.
   */
  const nossos = new Set(native.ownProcessTree())
  const silenciados = new Set(muted.map((nome) => nome.toLowerCase()))

  return native
    .listAudioSessions()
    .filter((sessao) => {
      if (nossos.has(sessao.pid)) return false
      return !silenciados.has(sessao.executable.toLowerCase())
    })
    .map((sessao) => sessao.pid)
}

/**
 * Comeca a capturar o audio de UM processo (a janela escolhida) e envia o PCM
 * para o renderer.
 *
 * O PCM vai cru (s16 intercalado, 48 kHz) porque e exatamente o formato que o
 * outro lado precisa para montar um MediaStreamTrack — nenhuma conversao no meio.
 */
export function startProcessAudio(window: BrowserWindow, pid: number): boolean {
  if (!native) return false
  stopProcessAudio()

  try {
    native.startCapture({ includePids: [pid] }, (chunk) => {
      if (window.isDestroyed()) return
      window.webContents.send('audio:pcm', chunk)
    })
    capturingPid = pid
    return true
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    return false
  }
}

/**
 * Som do computador inteiro, menos o proprio app e menos o que foi silenciado.
 *
 * Rescaneia porque aplicativos comecam e param de tocar o tempo todo: quem abre
 * o Spotify no meio da sessao precisa passar a ser ouvido. E a diferenca de
 * comportamento que o modo INCLUDE traz — o EXCLUDE pegava os novos de graca —
 * e o preco de poder silenciar mais de um.
 */
const RESCAN_MS = 2000

export function startSystemAudio(window: BrowserWindow, muted: string[] = []): boolean {
  if (!native) return false
  stopProcessAudio()
  mutedExecutables = muted

  try {
    native.startCapture({ includePids: pidsParaCapturar(muted) }, (chunk) => {
      if (window.isDestroyed()) return
      window.webContents.send('audio:pcm', chunk)
    })

    rescanTimer = setInterval(() => {
      if (window.isDestroyed()) return
      native?.setIncludePids(pidsParaCapturar(mutedExecutables))
    }, RESCAN_MS)

    return true
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
    return false
  }
}

/** Troca a lista de silenciados sem interromper o audio. */
export function setMutedExecutables(muted: string[]): boolean {
  mutedExecutables = muted
  if (!native || rescanTimer === null) return false
  return native.setIncludePids(pidsParaCapturar(muted))
}

/**
 * Diagnostico: captura por alguns segundos e devolve a energia do audio, medida
 * AQUI no processo main.
 *
 * Serve para separar dois suspeitos que se parecem: "o nativo nao filtra dentro
 * do Electron" e "o nativo filtra, mas o caminho ate a trilha esta misturando
 * algo". Sem medir no meio, os dois produzem o mesmo sintoma.
 */
export async function probeProcessAudio(
  options: { excludePid?: number; includePids?: number[] },
  ms = 2500
): Promise<{ packets: number; rms: number; error: string | null }> {
  if (!native) return { packets: 0, rms: 0, error: loadError }

  stopProcessAudio()

  let packets = 0
  let sum = 0
  let samples = 0

  native.startCapture(options, (chunk) => {
    packets++
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const s = chunk.readInt16LE(i) / 32768
      sum += s * s
      samples++
    }
  })

  await new Promise((resolve) => setTimeout(resolve, ms))
  native.stopCapture()

  return {
    packets,
    rms: samples ? Number(Math.sqrt(sum / samples).toFixed(5)) : 0,
    error: native.ultimoErro()
  }
}

export function stopProcessAudio(): void {
  if (rescanTimer) clearInterval(rescanTimer)
  rescanTimer = null
  if (!native) return
  native.stopCapture()
  capturingPid = null
}
