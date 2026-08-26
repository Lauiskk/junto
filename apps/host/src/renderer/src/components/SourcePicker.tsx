import { useEffect, useState, type ReactElement } from 'react'
import type { CaptureSource } from '../../../main/capture'
import { Icon } from './Icon'

interface Props {
  open: boolean
  withSystemAudio: boolean
  onToggleAudio: (value: boolean) => void
  /**
   * Executaveis que devem ficar MUDOS ao compartilhar a tela inteira,
   * ex.: ["discord.exe"].
   *
   * Por nome de executavel e nao por janela: o Discord roda com mais de um
   * processo e o Chromium renderiza audio num filho. Silenciar "Discord" tem
   * que pegar todos eles.
   */
  mutedApps: string[]
  onMutedChange: (executables: string[]) => void
  onPick: (source: CaptureSource) => void
  onClose: () => void
}

/**
 * Seletor de fonte proprio (em vez do seletor do sistema).
 *
 * A razao e concreta: o seletor nativo nao permite marcar "com audio" ao
 * compartilhar UMA JANELA. Desenhando o nosso, "compartilhar a janela do jogo
 * com o som do jogo" vira uma caixinha marcada, e nao um recurso indisponivel.
 */
export function SourcePicker({
  open,
  withSystemAudio,
  onToggleAudio,
  mutedApps,
  onMutedChange,
  onPick,
  onClose
}: Props): ReactElement | null {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'screen' | 'window'>('all')
  const [apps, setApps] = useState<{ pid: number; executable: string }[]>([])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.junto
      .listSources()
      .then(setSources)
      .finally(() => setLoading(false))
  }, [open])

  /**
   * Aplicativos com som aberto AGORA.
   *
   * A lista vem das sessoes de audio, e nao das janelas, porque stream e a unica
   * coisa que ha para deixar de fora — um app aberto e calado nao tem o que
   * silenciar. Processos repetidos do mesmo executavel viram uma linha so.
   */
  useEffect(() => {
    if (!open || !withSystemAudio) return
    let vivo = true
    const carregar = (): void => {
      void window.junto.audioSessions().then((sessoes) => {
        if (!vivo) return
        const porExecutavel = new Map<string, { pid: number; executable: string }>()
        for (const s of sessoes) {
          if (!s.executable) continue
          if (!porExecutavel.has(s.executable.toLowerCase())) {
            porExecutavel.set(s.executable.toLowerCase(), s)
          }
        }
        setApps([...porExecutavel.values()])
      })
    }
    carregar()
    const timer = setInterval(carregar, 3000)
    return () => {
      vivo = false
      clearInterval(timer)
    }
  }, [open, withSystemAudio])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const visible = sources.filter((s) => filter === 'all' || s.kind === filter)

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
        <header className="modal__head">
          <h2>O que voce quer transmitir?</h2>
          <div className="segmented">
            {(['all', 'screen', 'window'] as const).map((value) => (
              <button
                key={value}
                className={filter === value ? 'is-active' : ''}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'Tudo' : value === 'screen' ? 'Telas' : 'Janelas'}
              </button>
            ))}
          </div>
        </header>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={withSystemAudio}
            onChange={(e) => onToggleAudio(e.target.checked)}
          />
          <span>
            <strong>Incluir o som do computador</strong>
            <em>
              <strong className="warn">Atencao: captura o som do sistema INTEIRO</strong>
              , nao apenas o da janela escolhida. Chamadas de Discord, notificacoes e
              qualquer outro app tocando serao ouvidos por quem estiver assistindo.
            </em>
          </span>
        </label>

        {withSystemAudio && (
          <div className="field">
            <span>
              Ao compartilhar a <strong>tela inteira</strong>, silenciar:
            </span>

            {apps.length === 0 ? (
              <em className="muted">Nenhum aplicativo tocando som no momento.</em>
            ) : (
              <div className="mute-list">
                {apps.map((app) => {
                  const nome = app.executable
                  const marcado = mutedApps.some(
                    (m) => m.toLowerCase() === nome.toLowerCase()
                  )
                  return (
                    <label key={nome} className="mute-item">
                      <input
                        type="checkbox"
                        checked={marcado}
                        onChange={(e) =>
                          onMutedChange(
                            e.target.checked
                              ? [...mutedApps, nome]
                              : mutedApps.filter(
                                  (m) => m.toLowerCase() !== nome.toLowerCase()
                                )
                          )
                        }
                      />
                      <span>{nome.replace(/\.exe$/i, '')}</span>
                    </label>
                  )
                })}
              </div>
            )}

            <em>
              Da para marcar quantos quiser. O proprio Junto ja fica de fora
              sempre — sem isso, a voz de quem esta assistindo voltaria como eco.
              Compartilhando apenas uma janela nada disso e necessario: ali o som
              ja sai isolado.
            </em>
          </div>
        )}

        {loading && <p className="modal__loading">Procurando telas e janelas…</p>}

        <div className="sources">
          {visible.map((source) => (
            <button key={source.id} className="source" onClick={() => onPick(source)}>
              <img className="source__thumb" src={source.thumbnailDataUrl} alt="" />
              <span className="source__name">
                {/* Sem icone proprio (telas nunca tem, e algumas janelas
                    tambem nao), um simbolo generico mantem o alinhamento do
                    nome igual em todos os cartoes. */}
                {source.appIconDataUrl ? (
                  <img className="source__icon" src={source.appIconDataUrl} alt="" />
                ) : (
                  <Icon
                    className="source__icon"
                    name={source.id.startsWith('screen:') ? 'monitor' : 'window'}
                  />
                )}
                <span>{source.name}</span>
              </span>
            </button>
          ))}
        </div>

        {!loading && visible.length === 0 && (
          <p className="modal__loading">Nenhuma fonte encontrada.</p>
        )}
      </div>
    </div>
  )
}
