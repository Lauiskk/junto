import { contextBridge, ipcRenderer } from 'electron'
import type { CaptureSelection, CaptureSource } from '../main/capture.js'
import type { ProcessAudioStatus } from '../main/process-audio.js'

/**
 * Superficie IPC exposta ao renderer.
 *
 * Deliberadamente pequena: o renderer nao tem Node, nao tem acesso a arquivos e
 * nao pode invocar nada alem destas cinco funcoes. Se um dia carregarmos
 * conteudo de terceiros numa aba, o estrago possivel continua limitado a isto.
 */
const api = {
  getConfig: (): Promise<{ signalingUrl: string; webUrl: string }> =>
    ipcRenderer.invoke('app:config'),

  getGpuStatus: (): Promise<{
    features: Record<string, string>
    vendor: string | null
  }> => ipcRenderer.invoke('app:gpu-status'),

  getLanAddresses: (): Promise<string[]> => ipcRenderer.invoke('app:lan-addresses'),

  // -- audio por processo ----------------------------------------------------

  audioStatus: (): Promise<ProcessAudioStatus> => ipcRenderer.invoke('audio:status'),

  /**
   * include: captura SO este processo (a janela compartilhada).
   * exclude: captura tudo MENOS ele — para silenciar o Discord em tela cheia.
   */
  startProcessAudio: (
    sourceId: string,
    mode: 'include' | 'exclude'
  ): Promise<ProcessAudioStatus & { started: boolean }> =>
    ipcRenderer.invoke('audio:start-process', sourceId, mode),

  probeAudio: (pid: number, include: boolean): Promise<{ packets: number; rms: number; error: string | null }> =>
    ipcRenderer.invoke('audio:probe', pid, include),

  stopProcessAudio: (): Promise<ProcessAudioStatus> =>
    ipcRenderer.invoke('audio:stop-process'),

  /**
   * Fluxo de PCM cru vindo do modulo nativo. Devolve a funcao de cancelamento —
   * sem ela, trocar de fonte varias vezes empilharia ouvintes e o audio sairia
   * duplicado.
   */
  onAudioPcm: (handler: (chunk: Uint8Array) => void): (() => void) => {
    const listener = (_event: unknown, chunk: Uint8Array): void => handler(chunk)
    ipcRenderer.on('audio:pcm', listener)
    return () => {
      ipcRenderer.off('audio:pcm', listener)
    }
  },

  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:list-sources'),

  selectSource: (selection: CaptureSelection | null): Promise<boolean> =>
    ipcRenderer.invoke('capture:select', selection),

  keepAwake: (on: boolean): Promise<boolean> => ipcRenderer.invoke('power:keep-awake', on),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke('shell:open-external', url)
}

contextBridge.exposeInMainWorld('junto', api)

export type JuntoApi = typeof api
