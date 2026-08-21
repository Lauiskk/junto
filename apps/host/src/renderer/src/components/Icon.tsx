import type { ReactElement } from 'react'

/**
 * Icones em SVG inline.
 *
 * Inline e nao fonte de icones, e nao arquivos soltos, por tres razoes que
 * importam neste app especifico: nao ha requisicao de rede (o Electron abre
 * offline), a cor sai de `currentColor` — entao um botao que fica vermelho leva
 * o icone junto sem CSS extra — e o traco continua nitido em qualquer escala de
 * DPI do Windows.
 *
 * Todos desenhados na mesma grade de 24, com traco de 1.75 e pontas
 * arredondadas. Misturar espessuras e o que faz um conjunto de icones parecer
 * remendado.
 */

export type IconName =
  | 'monitor'
  | 'film'
  | 'mic'
  | 'mic-off'
  | 'copy'
  | 'check'
  | 'users'
  | 'chat'
  | 'send'
  | 'stop'
  | 'activity'
  | 'gauge'
  | 'sliders'
  | 'shield'
  | 'volume-x'
  | 'volume'
  | 'ban'
  | 'x'
  | 'link'
  | 'window'

const PATHS: Record<IconName, ReactElement> = {
  monitor: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M8.5 21h7M12 17v4" />
    </>
  ),
  window: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M2.5 8.5h19" />
    </>
  ),
  film: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M2.5 12h19M2.5 8h4.5M2.5 16h4.5M17 8h4.5M17 16h4.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </>
  ),
  'mic-off': (
    <>
      <path d="M15 5a3 3 0 0 0-6 0v5m0 2.5a3 3 0 0 0 5.2 1.6" />
      <path d="M5.5 11a6.5 6.5 0 0 0 10 5.5M18.5 11v.5M12 17.5V21" />
      <path d="m3 3 18 18" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 5.2a3.5 3.5 0 0 1 0 6.6M18.5 20a6.6 6.6 0 0 0-3-5.5" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12Z" />,
  send: <path d="M21 3 10.5 13.5M21 3l-6.8 18-3.7-7.5L3 9.8 21 3Z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2.5" />,
  activity: <path d="M2.5 12h4l3-8 4.5 16 3-8h4.5" />,
  gauge: (
    <>
      <path d="M3.5 17a9 9 0 1 1 17 0" />
      <path d="m15 9-3.6 3.6" />
      <circle cx="12" cy="14" r="1.6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h10M18 18h2" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="18" r="2" />
    </>
  ),
  shield: <path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.6 7.5 10 4.4-1.4 7.5-5.4 7.5-10v-6L12 2.5Z" />,
  'volume-x': (
    <>
      <path d="M11 4.5 6.5 8.5H3v7h3.5L11 19.5v-15Z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  volume: (
    <>
      <path d="M11 4.5 6.5 8.5H3v7h3.5L11 19.5v-15Z" />
      <path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4M18.5 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.6 5.6 12.8 12.8" />
    </>
  ),
  x: <path d="M6 6l12 12M18 6 6 18" />,
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.7 1.7" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.7-1.7" />
    </>
  )
}

interface Props {
  name: IconName
  /** Tamanho em px. 16 nos botoes, 18-20 em titulos. */
  size?: number
  className?: string
}

export function Icon({ name, size = 16, className }: Props): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorativo: o texto do botao ao lado ja diz o que ele faz, e um leitor
      // de tela anunciando "imagem" no meio seria so ruido.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
