import type { BrowserWindow } from 'electron'
import { createRequire } from 'node:module'

/**
 * Ponte entre o modulo nativo e o renderer.
 *
 * Existe para resolver o vazamento de audio: compartilhando UMA janela, o app
 * mandava o som do sistema inteiro — numa sessao real a chamada de Discord do
 * usuario foi ouvida por quem assistia. Aqui o audio passa a vir do processo
 * dono da janela escolhida, e de mais ninguem.
 */

interface NativeAudio {
  disponivel(): boolean
  erroDeCarregamento(): string | null
  pidFromWindowId(sourceId: string): number | null
  startCapture(pid: number, include: boolean, onPcm: (chunk: Buffer) => void): boolean
  stopCapture(): boolean
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
  error: string | null
  format: { sampleRate: number; channels: number; bitsPerSample: number }
}

let capturingPid: number | null = null

export function processAudioStatus(): ProcessAudioStatus {
  return {
    available: native !== null,
    capturing: capturingPid !== null,
    pid: capturingPid,
    error: loadError ?? native?.ultimoErro() ?? null,
    format: native?.formato() ?? { sampleRate: 48000, channels: 2, bitsPerSample: 16 }
  }
}

/** "window:<HWND>:0" -> pid, quando a fonte e uma janela. */
export function pidForSource(sourceId: string): number | null {
  if (!native || !sourceId.startsWith('window:')) return null
  return native.pidFromWindowId(sourceId)
}

/**
 * Comeca a capturar o audio de um processo e envia o PCM para o renderer.
 *
 * O PCM vai cru (s16 intercalado, 48 kHz) porque e exatamente o formato que o
 * outro lado precisa para montar um MediaStreamTrack — nenhuma conversao no meio.
 */
export function startProcessAudio(
  window: BrowserWindow,
  pid: number,
  include: boolean
): boolean {
  if (!native) return false
  stopProcessAudio()

  try {
    native.startCapture(pid, include, (chunk) => {
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
 * Diagnostico: captura um PID por alguns segundos e devolve a energia do audio,
 * medida AQUI no processo main.
 *
 * Serve para separar dois suspeitos que se parecem: "o nativo nao filtra dentro
 * do Electron" e "o nativo filtra, mas o caminho ate a trilha esta misturando
 * algo". Sem medir no meio, os dois produzem o mesmo sintoma.
 */
export async function probeProcessAudio(
  pid: number,
  include: boolean,
  ms = 2500
): Promise<{ packets: number; rms: number; error: string | null }> {
  if (!native) return { packets: 0, rms: 0, error: loadError }

  const wasCapturing = capturingPid
  stopProcessAudio()

  let packets = 0
  let sum = 0
  let samples = 0

  native.startCapture(pid, include, (chunk) => {
    packets++
    for (let i = 0; i + 1 < chunk.length; i += 2) {
      const s = chunk.readInt16LE(i) / 32768
      sum += s * s
      samples++
    }
  })

  await new Promise((resolve) => setTimeout(resolve, ms))
  native.stopCapture()
  capturingPid = wasCapturing === null ? null : capturingPid

  return {
    packets,
    rms: samples ? Number(Math.sqrt(sum / samples).toFixed(5)) : 0,
    error: native.ultimoErro()
  }
}

export function stopProcessAudio(): void {
  if (!native || capturingPid === null) return
  native.stopCapture()
  capturingPid = null
}
