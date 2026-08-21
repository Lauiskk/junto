import type { ReactElement } from 'react'
import type { LinkStats } from '@junto/rtc'

interface Props {
  stats: LinkStats
  offsetMs: number
}

/**
 * Diagnostico ao vivo.
 *
 * A pergunta que este painel responde e "por que esta ruim AGORA": rede, CPU do
 * host, ou nada disso. Sem ele, "ta travando" nao tem como ser investigado.
 */
export function Hud({ stats, offsetMs }: Props): ReactElement {
  const { video, audio, network } = stats

  const lossClass =
    network.packetsLostPct > 3 ? 'bad' : network.packetsLostPct > 0.5 ? 'warn' : 'good'
  const rttClass = network.rttMs > 150 ? 'bad' : network.rttMs > 60 ? 'warn' : 'good'

  return (
    <aside className="hud">
      <h3 className="hud__title">Recebendo</h3>

      <dl className="hud__grid">
        <div>
          <dt>Imagem</dt>
          <dd>
            {video.width}x{video.height} @ {Math.round(video.fps)}fps
          </dd>
        </div>
        <div>
          <dt>Codec</dt>
          <dd>{video.codec ?? '—'}</dd>
        </div>
        <div>
          <dt>Banda</dt>
          <dd>
            {video.kbps} kbps <span className="hud__muted">+ {audio.kbps} audio</span>
          </dd>
        </div>
        <div>
          <dt>Ida e volta</dt>
          <dd className={rttClass}>{Math.round(network.rttMs)} ms</dd>
        </div>
        <div>
          <dt>Jitter</dt>
          <dd>{Math.round(network.jitterMs)} ms</dd>
        </div>
        <div>
          <dt>Perda (video)</dt>
          <dd className={lossClass}>{network.packetsLostPct.toFixed(1)}%</dd>
        </div>
        <div>
          {/* Separado do video de proposito: as duas trilhas dividem a mesma
              banda, e sem os dois numeros nao da para saber qual esta sofrendo. */}
          <dt>Perda (audio)</dt>
          <dd>{network.packetsLostPctAudio.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Congelamentos</dt>
          <dd>{video.freezeCount}</dd>
        </div>
        <div>
          <dt>Decoder</dt>
          <dd className="hud__muted">{video.implementation ?? '—'}</dd>
        </div>
        <div>
          <dt>Caminho</dt>
          <dd className={network.relayed ? 'warn' : 'good'}>
            {network.relayed
              ? 'via TURN (relay)'
              : `direto (${network.localCandidateType ?? '?'})`}
          </dd>
        </div>
        <div>
          <dt>Relogio</dt>
          <dd className="hud__muted">{offsetMs > 0 ? '+' : ''}{offsetMs} ms</dd>
        </div>
      </dl>

      <p className="hud__note">
        O atraso de rede e cerca de METADE do valor de ida e volta. Se "Caminho"
        mostrar TURN, o trafego esta passando pelo servidor — funciona, mas custa
        latencia.
      </p>
    </aside>
  )
}
