import { useEffect, useRef, type ReactElement } from 'react'
import {
  describeLimitation,
  describeQuality,
  formatBytes,
  type ViewerConnection
} from '@junto/rtc'
import { Icon } from './Icon'

interface Props {
  viewers: ViewerConnection[]
  onKick: (peerId: string, block: boolean) => void
}

/**
 * Voz de um espectador.
 *
 * Elemento de audio por pessoa em vez de mixagem manual: o proprio navegador
 * soma as vozes, e cada uma pode ganhar volume proprio depois sem refazer nada.
 */
function VoiceAudio({ stream }: { stream: MediaStream }): ReactElement {
  const ref = useRef<HTMLAudioElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream
  }, [stream])

  return <audio ref={ref} autoPlay />
}

const STATE_LABEL: Record<string, string> = {
  new: 'iniciando',
  connecting: 'conectando',
  connected: 'conectado',
  disconnected: 'desconectado',
  failed: 'falhou',
  closed: 'fechado'
}

/**
 * Lista de quem esta assistindo — com as DUAS pontas da medicao.
 *
 * "Enviando" e o que sai daqui; "recebendo" e o que a pessoa do outro lado
 * relata estar recebendo de fato, via canal de controle. A diferenca entre os
 * dois numeros e o diagnostico: se sai 8000 kbps e chega 2000, o problema esta
 * na rede dela (ou no meio do caminho), nao no seu encoder.
 */
export function ViewerList({ viewers, onKick }: Props): ReactElement {
  if (viewers.length === 0) {
    return (
      <div className="empty">
        <p>
          <strong>Ninguem assistindo ainda.</strong>
        </p>
        <p>
          Mande o link da sala. Enquanto nao houver ninguem, nada e transmitido —
          seu upload e sua CPU ficam livres.
        </p>
      </div>
    )
  }

  return (
    <ul className="viewers">
      {viewers.map((viewer) => {
        const sending = viewer.stats
        const receiving = viewer.reported
        const limitation = sending ? describeLimitation(sending) : null
        const stale = receiving ? Date.now() - receiving.at > 8000 : false

        return (
          <li key={viewer.peerId} className="viewer-card">
            <header className="viewer-card__head">
              <span className={`dot dot--${viewer.connectionState}`} />
              <strong>{viewer.name}</strong>
              <span className="viewer-card__state">
                {STATE_LABEL[viewer.connectionState] ?? viewer.connectionState}
              </span>
              {viewer.voice && (
                <span className="tag tag--live" title="Microfone aberto">
                  microfone
                </span>
              )}
              {sending?.network.relayed && (
                <span className="tag tag--warn" title="Trafego passando pelo TURN">
                  relay
                </span>
              )}

              <span className="viewer-card__actions">
                <button
                  onClick={() => onKick(viewer.peerId, false)}
                  title="Derruba a conexao; a pessoa pode voltar pelo mesmo link"
                >
                  <Icon name="x" size={13} />
                  Remover
                </button>
                <button
                  className="is-live"
                  onClick={() => onKick(viewer.peerId, true)}
                  title="Derruba e impede o retorno nesta sala"
                >
                  <Icon name="ban" size={13} />
                  Bloquear
                </button>
              </span>
            </header>

            {viewer.voice && <VoiceAudio stream={viewer.voice} />}

            <div className="viewer-card__cols">
              <div>
                <h4>Enviando</h4>
                <p className="metric">
                  {sending ? `${sending.video.kbps} kbps` : '—'}
                  <span>
                    {sending
                      ? `${sending.video.width}x${sending.video.height} @ ${Math.round(sending.video.fps)}fps`
                      : 'aguardando'}
                  </span>
                </p>
                {/*
                  O audio aparece separado porque ele disputa a MESMA banda que a
                  imagem — e ja ganhou essa disputa uma vez, num teste real, com
                  88 kbps de som e 3 de video. Sem os dois numeros lado a lado,
                  isso e invisivel.
                */}
                <p className="submetric">
                  audio {sending ? sending.audio.kbps : '—'} kbps · RTT{' '}
                  {sending ? Math.round(sending.network.rttMs) : '—'} ms
                </p>
                <p className="submetric">
                  perda video {sending ? sending.network.packetsLostPct.toFixed(1) : '—'}%
                  {' · '}
                  audio {sending ? sending.network.packetsLostPctAudio.toFixed(1) : '—'}%
                </p>
              </div>

              <div>
                <h4>Recebendo (relato dele)</h4>
                {receiving && !stale ? (
                  <>
                    <p className="metric">
                      {receiving.kbps} kbps
                      <span>
                        {receiving.width}x{receiving.height} @ {receiving.fps}fps
                      </span>
                    </p>
                    <p className="submetric">
                      congelou {receiving.freezeCount}x · jitter {receiving.jitterMs} ms
                    </p>
                    {/*
                      O tamanho em que a imagem realmente aparece na tela dele.
                      Quando e menor que o que sai daqui, o host esta pagando
                      upload e CPU por pixels que ninguem ve — e e por isso que
                      a resolucao passa a ser limitada por este numero.
                    */}
                    {receiving.renderedHeight > 0 && (
                      <p className="submetric">
                        exibindo em {receiving.renderedWidth}x{receiving.renderedHeight}
                      </p>
                    )}
                  </>
                ) : (
                  <p className="submetric">sem relato ainda</p>
                )}
              </div>
            </div>

            {viewer.film && (
              <div className="film-progress">
                <div className="film-progress__bar">
                  <span
                    style={{
                      width: `${Math.min(100, (viewer.film.sent / Math.max(1, viewer.film.total)) * 100)}%`
                    }}
                  />
                </div>
                <p className="submetric">
                  {viewer.film.ready ? (
                    <strong className="good">filme recebido — pronto para tocar</strong>
                  ) : (
                    <>
                      baixando o filme: {formatBytes(viewer.film.sent)} de{' '}
                      {formatBytes(viewer.film.total)}
                      {viewer.film.bytesPerSecond > 0 &&
                        ` · ${formatBytes(viewer.film.bytesPerSecond)}/s`}
                    </>
                  )}
                </p>
              </div>
            )}

            {viewer.quality && (
              <p className="submetric">
                Enviando em <strong>{viewer.quality.label}</strong> ·{' '}
                {describeQuality(viewer.quality, viewers.length)}
              </p>
            )}

            {limitation && <p className="viewer-card__warn">{limitation}</p>}
          </li>
        )
      })}
    </ul>
  )
}
