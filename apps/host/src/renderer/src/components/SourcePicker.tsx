import { useEffect, useState, type ReactElement } from 'react'
import type { CaptureSource } from '../../../main/capture'

interface Props {
  open: boolean
  withSystemAudio: boolean
  onToggleAudio: (value: boolean) => void
  /** Id da janela cujo app deve ficar MUDO ao compartilhar a tela inteira. */
  silenceSourceId: string | null
  onSilenceChange: (sourceId: string | null) => void
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
  silenceSourceId,
  onSilenceChange,
  onPick,
  onClose
}: Props): ReactElement | null {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'screen' | 'window'>('all')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    window.junto
      .listSources()
      .then(setSources)
      .finally(() => setLoading(false))
  }, [open])

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
          <label className="field field--inline">
            <span>
              Ao compartilhar a <strong>tela inteira</strong>, silenciar o audio de:
            </span>
            <select
              className="field__input"
              value={silenceSourceId ?? ''}
              onChange={(e) => onSilenceChange(e.target.value || null)}
            >
              <option value="">nenhum app (som do sistema inteiro)</option>
              {sources
                .filter((s) => s.kind === 'window')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <em>
              Escolhendo o Discord aqui, a conversa de voz nao vai junto com o
              filme. Compartilhando apenas uma janela isto e desnecessario — ali o
              som ja sai isolado.
            </em>
          </label>
        )}

        {loading && <p className="modal__loading">Procurando telas e janelas…</p>}

        <div className="sources">
          {visible.map((source) => (
            <button key={source.id} className="source" onClick={() => onPick(source)}>
              <img className="source__thumb" src={source.thumbnailDataUrl} alt="" />
              <span className="source__name">
                {source.appIconDataUrl && (
                  <img className="source__icon" src={source.appIconDataUrl} alt="" />
                )}
                {source.name}
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
