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

  /** Diagnostico: nossa arvore de processos, que nunca deve ser capturada. */
  ownProcessTree: (): Promise<number[]> => ipcRenderer.invoke('audio:own-tree'),

  /** Aplicativos com som aberto agora, para o seletor de silenciamento. */
  audioSessions: (): Promise<{ pid: number; executable: string }[]> =>
    ipcRenderer.invoke('audio:sessions'),

  /** Captura SO o processo dono desta janela — o caso de compartilhar 1 janela. */
  startProcessAudio: (
    sourceId: string
  ): Promise<ProcessAudioStatus & { started: boolean }> =>
    ipcRenderer.invoke('audio:start-process', sourceId),

  /**
   * Som do computador, menos o proprio app (sempre) e menos os executaveis
   * silenciados. Montado somando uma captura por aplicativo, porque o Windows
   * so aceita um alvo de exclusao por vez.
   */
  startSystemAudio: (
    muted: string[]
  ): Promise<ProcessAudioStatus & { started: boolean }> =>
    ipcRenderer.invoke('audio:start-system', muted),

  /** Troca os silenciados sem interromper o audio. */
  setMutedApps: (muted: string[]): Promise<ProcessAudioStatus> =>
    ipcRenderer.invoke('audio:set-muted', muted),

  probeAudio: (options: {
    excludePid?: number
    includePids?: number[]
  }): Promise<{ packets: number; rms: number; error: string | null }> =>
    ipcRenderer.invoke('audio:probe', options),

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
