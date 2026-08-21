import { useEffect, useState, type ReactElement } from 'react'
import type { PlayerState } from '@junto/rtc'

interface Props {
  player: PlayerState
  /** Diferenca estimada entre o relogio do host e o nosso. */
  clockOffsetMs: number
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`
}

/**
 * Posicao do filme que o host esta tocando.
 *
 * O host avisa a posicao a cada 2s; entre um aviso e outro, extrapolamos com o
 * relogio local corrigido pelo offset medido no canal de controle. Sem isso o
 * contador andaria aos saltos de 2 em 2 segundos.
 */
export function PlayerBadge({ player, clockOffsetMs }: Props): ReactElement {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (player.state !== 'playing') return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [player.state])

  const elapsedSec =
    player.state === 'playing'
      ? Math.max(0, now + clockOffsetMs - player.hostTimeMs) / 1000
      : 0

  const position = player.positionSec + elapsedSec
  const capped = player.durationSec ? Math.min(position, player.durationSec) : position

  return (
    <span className="player-badge">
      <span className="player-badge__icon">
        {player.state === 'playing' ? '▶' : player.state === 'paused' ? '❚❚' : '■'}
      </span>
      {formatTime(capped)}
      {player.durationSec ? ` / ${formatTime(player.durationSec)}` : ''}
    </span>
  )
}
