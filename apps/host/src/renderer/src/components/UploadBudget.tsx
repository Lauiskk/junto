import { useState, type ReactElement } from 'react'
import type { UploadMode, UploadSetting } from '@junto/rtc'
import { Icon } from './Icon'

/**
 * Quanto da internet o app pode usar para transmitir.
 *
 * Este card existe por um pedido direto depois de um teste real: "pode autorizar
 * o aplicativo pegar muito da internet para transmitir". A estimativa de banda do
 * WebRTC e conservadora por projeto — ela foi feita para uma videochamada
 * conviver com o resto da casa — e quem esta transmitindo um filme quer o
 * oposto disso.
 *
 * O que o card NAO faz e prometer banda que nao existe. Forcar um piso acima da
 * capacidade real nao entrega mais imagem: entrega mais perda, e perda vira
 * congelamento. Por isso o aviso da trava aparece aqui mesmo, junto do botao que
 * a provocou.
 */

interface Props {
  value: UploadSetting
  measuredKbps: number
  warning: string | null
  onChange: (setting: UploadSetting) => void
}

const OPCOES: { mode: UploadMode; label: string; hint: string }[] = [
  {
    mode: 'auto',
    label: 'Automatico',
    hint: 'Obedece a estimativa do navegador. Seguro, e o mais conservador.'
  },
  {
    mode: 'max',
    label: 'Usar toda a minha internet',
    hint: 'Arranca no maximo medido em vez de subir em rampa, e nao deixa a estimativa estrangular a imagem.'
  },
  {
    mode: 'manual',
    label: 'Eu digo quanto',
    hint: 'Voce sabe seu upload melhor que a estimativa. Use o valor de subida do seu teste de velocidade.'
  }
]

export function UploadBudget({
  value,
  measuredKbps,
  warning,
  onChange
}: Props): ReactElement {
  const [mbps, setMbps] = useState(value.mbps || 10)

  return (
    <article className="card">
      <h2 className="card__title">
        <span className="card__step">4</span>Limite de upload
      </h2>

      <div className="presets presets--stack">
        {OPCOES.map((opcao) => (
          <button
            key={opcao.mode}
            className={`preset ${value.mode === opcao.mode ? 'is-active' : ''}`}
            onClick={() =>
              onChange({ mode: opcao.mode, mbps: opcao.mode === 'manual' ? mbps : 0 })
            }
          >
            <strong>{opcao.label}</strong>
            <em>{opcao.hint}</em>
          </button>
        ))}
      </div>

      {value.mode === 'manual' && (
        <label className="volume">
          Upload disponivel
          <input
            type="number"
            min={0.1}
            max={200}
            step={0.1}
            value={mbps}
            onChange={(event) => {
              const proximo = Number(event.target.value)
              setMbps(proximo)
              onChange({ mode: 'manual', mbps: proximo })
            }}
          />
          Mbps
        </label>
      )}

      <p className="card__hint">
        {measuredKbps > 0
          ? `Medido ate agora: ${(measuredKbps / 1000).toFixed(1)} Mbps de subida.`
          : 'Ainda medindo sua subida — o numero aparece quando alguem estiver assistindo.'}
        {value.mode !== 'auto' &&
          ' O total e dividido entre quem esta assistindo, entao cada pessoa a mais reduz a fatia de todas.'}
      </p>

      {warning && <p className="card__warning">{warning}</p>}
    </article>
  )
}
