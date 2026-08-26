import { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } from 'electron'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import {
  listSources,
  registerDisplayMediaHandler,
  setSelection,
  type CaptureSelection
} from './capture.js'
import {
  audioSessions,
  ownProcessTree,
  pidForSource,
  probeProcessAudio,
  processAudioStatus,
  setMutedExecutables,
  startProcessAudio,
  startSystemAudio,
  stopProcessAudio
} from './process-audio.js'

const isDev = !app.isPackaged

/**
 * Porta de depuracao remota, so quando pedida explicitamente.
 *
 * Serve para inspecionar a transmissao de fora do app: ler `getStats()` e os
 * parametros reais dos senders numa sessao de verdade. Boa parte do que este
 * projeto sabe sobre encoder e bitrate veio de medir por aqui em vez de supor —
 * inclusive a descoberta de que o audio estava comendo a banda do video.
 * Fica atras de uma variavel de ambiente porque abre a porta para quem estiver
 * na maquina.
 */
const debugPort = process.env.JUNTO_DEBUG_PORT
if (debugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
  console.log(`[main] depuracao remota em http://localhost:${debugPort}`)
}

const signalingUrl = process.env.JUNTO_SIGNALING_URL ?? 'ws://localhost:8787/ws'

/**
 * O site sai do MESMO servidor do signaling, entao o endereco dele e derivado —
 * e nao um segundo valor para manter em sincronia. Isso tambem evita o erro
 * classico de mandar para os amigos um link "localhost", que so funciona na sua
 * propria maquina.
 */
function deriveWebUrl(ws: string): string {
  try {
    const url = new URL(ws)
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
    url.pathname = '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return 'http://localhost:8787'
  }
}

const config = {
  signalingUrl,
  webUrl: process.env.JUNTO_WEB_URL ?? deriveWebUrl(signalingUrl)
}

let mainWindow: BrowserWindow | null = null
let powerBlockerId: number | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#0b0d12',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Link externo (convite, docs) abre no navegador padrao, nunca dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerDisplayMediaHandler()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------
// IPC — superficie minima e explicita entre renderer e main
// ---------------------------------------------------------------------------

ipcMain.handle('app:config', () => config)

/**
 * Enderecos IPv4 da maquina na rede local.
 *
 * Serve ao caso mais comum de "assistir junto": alguem na mesma casa, no mesmo
 * Wi-Fi. Nesse cenario nao e preciso tunel nem servidor na internet — basta a
 * outra pessoa abrir o IP da sua maquina. Sem isto, o unico link oferecido seria
 * localhost, que nao funciona para mais ninguem.
 */
ipcMain.handle('app:lan-addresses', () => {
  const addresses: string[] = []
  for (const nics of Object.values(networkInterfaces())) {
    for (const nic of nics ?? []) {
      if (nic.family === 'IPv4' && !nic.internal) addresses.push(nic.address)
    }
  }
  // Redes 192.168.x e 10.x primeiro: sao as domesticas de verdade. Faixas de VPN
  // e adaptadores virtuais (172.x costuma ser Docker/WSL) caem para o fim.
  return addresses.sort((a, b) => {
    const rank = (ip: string): number =>
      ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2
    return rank(a) - rank(b)
  })
})

/**
 * Status de aceleracao por GPU.
 *
 * Existe porque o encoder de video e a diferenca entre transmitir e jogar ao
 * mesmo tempo ou nao: em software, 1080p60 come CPU justamente enquanto o jogo
 * precisa dela. `video_encode` responde de forma objetiva se a GPU esta
 * disponivel para codificar — o que separa "o Chromium nao tem encoder" de
 * "o Chromium tem, mas escolheu nao usar".
 */
ipcMain.handle('app:gpu-status', async () => {
  const features = app.getGPUFeatureStatus() as unknown as Record<string, string>
  let vendor: string | null = null
  try {
    const info = (await app.getGPUInfo('basic')) as {
      gpuDevice?: Array<{ vendorId?: number; deviceId?: number; active?: boolean }>
    }
    const active = info.gpuDevice?.find((d) => d.active) ?? info.gpuDevice?.[0]
    if (active) vendor = `vendor ${active.vendorId} / device ${active.deviceId}`
  } catch {
    // Informacao de GPU e opcional; nao vale derrubar o diagnostico por ela.
  }
  return { features, vendor }
})

ipcMain.handle('capture:list-sources', () => listSources())

ipcMain.handle('audio:status', () => processAudioStatus())

/** Aplicativos com som aberto agora — o que o seletor lista para silenciar. */
ipcMain.handle('audio:sessions', () => audioSessions())

/** Diagnostico: nossa arvore de processos, a que nunca pode ser capturada. */
ipcMain.handle('audio:own-tree', () => ownProcessTree())

/**
 * Liga a captura de audio do processo dono da JANELA escolhida.
 *
 * Retorna o status para o renderer decidir: com audio por processo, o som que
 * sai e so o daquela janela; sem ele, cai no audio do sistema e a interface
 * precisa avisar que Discord e notificacoes vao junto.
 */
ipcMain.handle('audio:start-process', (_event, sourceId: string) => {
  const pid = pidForSource(sourceId)
  if (pid === null || !mainWindow) return { ...processAudioStatus(), started: false }
  const started = startProcessAudio(mainWindow, pid)
  return { ...processAudioStatus(), started }
})

/**
 * Som do computador inteiro, menos o proprio app e menos os silenciados.
 *
 * O proprio app sai SEMPRE, e nao por opcao: ele toca a voz de cada espectador
 * pelos alto-falantes, e captura-la de volta faria todo mundo se ouvir com
 * atraso.
 */
ipcMain.handle('audio:start-system', (_event, muted: string[]) => {
  if (!mainWindow) return { ...processAudioStatus(), started: false }
  const started = startSystemAudio(mainWindow, muted ?? [])
  return { ...processAudioStatus(), started }
})

ipcMain.handle('audio:set-muted', (_event, muted: string[]) => {
  setMutedExecutables(muted ?? [])
  return processAudioStatus()
})

ipcMain.handle(
  'audio:probe',
  (_event, options: { excludePid?: number; includePids?: number[] }) =>
    probeProcessAudio(options)
)

ipcMain.handle('audio:stop-process', () => {
  stopProcessAudio()
  return processAudioStatus()
})

ipcMain.handle('capture:select', (_event, selection: CaptureSelection | null) => {
  setSelection(selection)
  return true
})

/**
 * Transmissao longa e o caso de uso principal: sem isto o Windows apaga a tela
 * no meio do filme e a captura vira imagem congelada para quem assiste.
 */
ipcMain.handle('power:keep-awake', (_event, keepAwake: boolean) => {
  if (keepAwake && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (!keepAwake && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId)
    powerBlockerId = null
  }
  return powerBlockerId !== null
})

ipcMain.handle('shell:open-external', (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
})
