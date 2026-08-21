import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { Icon } from './Icon'

export interface ChatMessage {
  id: number
  from: string
  text: string
  at: number
  mine: boolean
}

interface Props {
  messages: ChatMessage[]
  onSend: (text: string) => void
  placeholder?: string
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

/**
 * Chat pelo canal de dados P2P — nao passa pelo servidor.
 *
 * Serve para o que voz nao resolve bem: mandar um link, um horario, um nome que
 * ninguem entende falado. E continua funcionando com o microfone fechado.
 */
export function Chat({ messages, onSend, placeholder }: Props): ReactElement {
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  // Rola para o fim so quando ja estava no fim: se a pessoa subiu para reler
  // algo, puxar a tela de volta no meio da leitura seria irritante.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80
    if (nearBottom) list.scrollTop = list.scrollHeight
  }, [messages])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    onSend(text)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat__list" ref={listRef}>
        {messages.length === 0 ? (
          <p className="chat__empty">Nenhuma mensagem ainda.</p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`chat__msg ${message.mine ? 'is-mine' : ''}`}>
              <span className="chat__meta">
                {message.from} · {formatClock(message.at)}
              </span>
              <span className="chat__text">{message.text}</span>
            </div>
          ))
        )}
      </div>

      <form className="chat__form" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder ?? 'Escreva uma mensagem…'}
          maxLength={2000}
        />
        <button className="button--primary" type="submit" disabled={!draft.trim()}>
          <Icon name="send" />
          <span className="only-wide">Enviar</span>
        </button>
      </form>
    </div>
  )
}
