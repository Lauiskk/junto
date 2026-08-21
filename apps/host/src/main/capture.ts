import { desktopCapturer, session, type DesktopCapturerSource } from 'electron'

/**
 * Captura de tela e de audio do sistema.
 *
 * ESTE ARQUIVO E A RAZAO DO HOST SER UM APP NATIVO.
 *
 * No navegador, getDisplayMedia so entrega audio quando voce compartilha a tela
 * inteira (e nem isso no Firefox/Safari). Compartilhar UMA JANELA COM SOM —
 * exatamente o caso de "mostrar o jogo/o filme para os amigos" — e impossivel
 * na web. No Electron, setDisplayMediaRequestHandler aceita audio: 'loopback',
 * que captura a saida de audio do Windows sem driver virtual e independe da
 * fonte de video escolhida.
 *
 * Limitacao conhecida (Fase 2 do plano): loopback pega TODO o audio do sistema,
 * inclusive notificacoes. Capturar so o audio de um processo exige WASAPI
 * process loopback via modulo nativo.
 */

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string
  appIconDataUrl: string | null
  displayId: string
}

export interface CaptureSelection {
  sourceId: string
  withSystemAudio: boolean
}

let selection: CaptureSelection | null = null

export function setSelection(next: CaptureSelection | null): void {
  selection = next
}

export function getSelection(): CaptureSelection | null {
  return selection
}

export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true
  })

  return sources
    .filter((source) => !source.thumbnail.isEmpty())
    .map((source: DesktopCapturerSource): CaptureSource => {
      const icon = source.appIcon
      return {
        id: source.id,
        name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: source.thumbnail.toDataURL(),
        appIconDataUrl: icon && !icon.isEmpty() ? icon.toDataURL() : null,
        displayId: source.display_id
      }
    })
}

/**
 * Intercepta getDisplayMedia() do renderer e responde com a fonte que o usuario
 * ja escolheu na nossa propria UI — em vez do seletor do sistema, que nao deixa
 * marcar "com audio" para janelas.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void (async () => {
        const current = selection
        if (!current) {
          // Sem selecao, nega: o renderer trata como "escolha uma fonte".
          callback({})
          return
        }

        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 1, height: 1 }
        })
        const source = sources.find((s) => s.id === current.sourceId)
        if (!source) {
          callback({})
          return
        }

        callback({
          video: source,
          // 'loopback' mantem o som tocando nos SEUS alto-falantes enquanto
          // transmite. 'loopbackWithMute' silenciaria a sua propria maquina.
          audio: current.withSystemAudio ? 'loopback' : undefined
        })
      })()
    },
    // useSystemPicker: false — quem desenha o seletor somos nos.
    { useSystemPicker: false }
  )
}
