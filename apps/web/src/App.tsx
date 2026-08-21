import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  ViewerSession,
  closeMicrophone,
  computePlaybackCorrection,
  formatBytes,
  openMicrophone,
  projectHostPosition,
  type ViewerState
} from '@junto/rtc'
import { JoinForm } from './components/JoinForm'
import { Hud } from './components/Hud'
import { PlayerBadge } from './components/PlayerBadge'
import { Chat, type ChatMessage } from './components/Chat'
import { Icon } from './components/Icon'

/**
 * Viewer: a metade que NAO instala nada.
 *
 * Todo o esforco de UX aqui e para que a pessoa so precise clicar no link,
 * apertar "Entrar" e ver a tela do amigo — com som. O clique nao e decoracao:
 * navegadores bloqueiam audio automatico, entao ele e o gesto que libera o som.
 */

/**
 * Em producao o Caddy serve o site e faz proxy de /ws no MESMO dominio, entao a
 * URL sai da propria origem. Em dev o signaling roda separado, na porta 8787.
 */
const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL ??
  (location.protocol === 'https:'
    ? `wss://${location.host}/ws`
    : `ws://${location.hostname}:8787/ws`)

function roomCodeFromUrl(): string {
  const params = new URLSearchParams(location.search)
  return (params.get('sala') ?? params.get('room') ?? '').toUpperCase()
}

export function App(): ReactElement {
  const [joined, setJoined] = useState(false)
  const [state, setState] = useState<ViewerState | null>(null)
  const [showHud, setShowHud] = useState(false)
  /**
   * O video comeca MUDO de proposito.
   *
   * O Safari do iPhone recusa `play()` com som sem um gesto, e a recusa nao tem
   * aparencia de erro: fica so uma tela preta, indistinguivel de "nao conectou".
   * Mudo, o autoplay e sempre permitido — a imagem aparece na hora e o unico que
   * falta e um toque para liberar o som, que a pessoa entende.
   */
  const [muted, setMuted] = useState(true)
  const [volume, setVolume] = useState(1)
  const [voiceVolume, setVoiceVolume] = useState(1)
  const [micOn, setMicOn] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])

  const [drift, setDrift] = useState(0)

  const sessionRef = useRef<ViewerSession | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const filmRef = useRef<HTMLVideoElement>(null)
  const voiceRef = useRef<HTMLAudioElement>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const nameRef = useRef('Convidado')
  const chatOpenRef = useRef(false)
  const messageId = useRef(0)

  useEffect(() => {
    chatOpenRef.current = chatOpen
    if (chatOpen) setUnread(0)
  }, [chatOpen])

  const pushMessage = useCallback((from: string, text: string, mine: boolean): void => {
    setMessages((current) => [
      ...current.slice(-199),
      { id: ++messageId.current, from, text, at: Date.now(), mine }
    ])
    if (!mine && !chatOpenRef.current) setUnread((n) => n + 1)
  }, [])

  const join = useCallback(
    (roomCode: string, name: string, password?: string) => {
      if (sessionRef.current) return
      nameRef.current = name
      const session = new ViewerSession({
        signalingUrl: SIGNALING_URL,
        roomCode,
        displayName: name,
        password: password || undefined,
        onState: setState,
        onChat: (text, from) => pushMessage(from, text, false)
      })
      sessionRef.current = session
      session.start()
      setJoined(true)

      const url = new URL(location.href)
      url.searchParams.set('sala', roomCode)
      history.replaceState(null, '', url)
    },
    [pushMessage]
  )

  useEffect(() => {
    return () => {
      closeMicrophone(micTrackRef.current)
      sessionRef.current?.stop()
    }
  }, [])

  // Calculado aqui em cima porque os efeitos abaixo dependem dele — trocar entre
  // o video ao vivo e o do Modo Cinema remonta o elemento.
  const film = state?.film ?? null
  const cinemaReady = Boolean(film?.ready && film.url)

  // Tela + som do sistema.
  useEffect(() => {
    const video = videoRef.current
    const stream = state?.stream
    if (!video || !stream) return
    if (video.srcObject === stream) return

    video.srcObject = stream
    void video.play().catch(() => undefined)
    // `cinemaReady` na dependencia porque sair do Modo Cinema REMONTA este
    // <video>: sem reanexar, o elemento novo ficaria em branco para sempre.
  }, [state?.stream, cinemaReady])

  // Voz do host, em elemento proprio para ter volume independente do filme.
  useEffect(() => {
    const audio = voiceRef.current
    const stream = state?.voiceStream
    if (!audio || !stream) return
    if (audio.srcObject === stream) return
    audio.srcObject = stream
    void audio.play().catch(() => undefined)
  }, [state?.voiceStream])

  /**
   * Modo Cinema: o filme toca AQUI, do arquivo original, e o unico trabalho e
   * manter a posicao colada na do host.
   *
   * A correcao e deliberadamente assimetrica: desvio grande vira um pulo unico,
   * desvio pequeno vira uma variacao de ate 3% na velocidade — imperceptivel no
   * audio — ate encostar. Pular a cada pequeno desvio deixaria a imagem
   * engasgando o tempo todo.
   */
  useEffect(() => {
    const video = filmRef.current
    const film = state?.film
    const player = state?.player
    const offset = state?.clockOffsetMs ?? 0
    if (!video || !film?.ready || !player) return

    const apply = (): void => {
      const playing = player.state === 'playing'
      const target = projectHostPosition(
        player.positionSec,
        player.hostTimeMs,
        offset,
        playing
      )

      if (!playing) {
        if (!video.paused) video.pause()
        if (Math.abs(video.currentTime - target) > 0.3) video.currentTime = target
        video.playbackRate = 1
        setDrift(0)
        return
      }

      if (video.paused) {
        void video.play().catch(() => undefined)
      }

      const correction = computePlaybackCorrection(target, video.currentTime)
      if (correction.action === 'seek' && correction.seekTo !== undefined) {
        video.currentTime = correction.seekTo
      }
      video.playbackRate = correction.playbackRate
      setDrift(correction.driftSec)
    }

    apply()
    const timer = setInterval(apply, 1000)
    return () => clearInterval(timer)
  }, [state?.film?.ready, state?.player, state?.clockOffsetMs])

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = muted
    }
    if (filmRef.current) {
      filmRef.current.volume = volume
      filmRef.current.muted = muted
    }
  }, [volume, muted])

  useEffect(() => {
    if (voiceRef.current) voiceRef.current.volume = voiceVolume
  }, [voiceVolume])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'i') setShowHud((v) => !v)
      if (event.key === 'c') setChatOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleMic = async (): Promise<void> => {
    setMicError(null)
    try {
      if (micOn) {
        await sessionRef.current?.setMicTrack(null)
        closeMicrophone(micTrackRef.current)
        micTrackRef.current = null
        setMicOn(false)
        return
      }
      const track = await openMicrophone()
      micTrackRef.current = track
      await sessionRef.current?.setMicTrack(track)
      setMicOn(true)
    } catch (err) {
      setMicError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Permissao de microfone negada pelo navegador.'
          : 'Nao foi possivel abrir o microfone.'
      )
    }
  }

  const unlockAudio = (): void => {
    setMuted(false)
    if (videoRef.current) videoRef.current.muted = false
    if (filmRef.current) filmRef.current.muted = false
    void videoRef.current?.play()
    void filmRef.current?.play()
    void voiceRef.current?.play()
  }

  const toggleFullscreen = (): void => {
    const video = videoRef.current
    if (!video) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void video.requestFullscreen()
  }

  const togglePip = (): void => {
    const video = videoRef.current as
      | (HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> })
      | null
    if (!video?.requestPictureInPicture) return
    if (document.pictureInPictureElement) void document.exitPictureInPicture()
    else void video.requestPictureInPicture()
  }

  // Removido pelo host: fim de linha explicito, em vez de "reconectando" eterno.
  if (state?.removed) {
    return (
      <div className="join">
        <div className="join__card">
          <h1 className="join__title">
            {state.removed === 'blocked' ? 'Voce foi bloqueado' : 'Voce saiu da sala'}
          </h1>
          <p className="join__subtitle">
            {state.removed === 'blocked'
              ? 'O host bloqueou seu acesso a esta sala. Falar com ele e o caminho — entrar de novo pelo link nao vai funcionar.'
              : 'O host removeu voce da sala. Se foi para destravar a conexao, e so entrar de novo pelo mesmo link.'}
          </p>
          {state.removed === 'kicked' && (
            <button
              className="button button--primary"
              onClick={() => location.reload()}
            >
              Entrar de novo
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!joined) {
    return (
      <JoinForm
        initialCode={roomCodeFromUrl()}
        onJoin={join}
        signalingUrl={SIGNALING_URL}
      />
    )
  }

  // A conexao fica pronta ANTES de existir imagem: os transceivers sao criados
  // vazios de proposito (evita renegociar a cada troca de fonte). Por isso quem
  // manda no placeholder e o aviso do host, nao a presenca de um track — senao a
  // tela ficaria preta em silencio em vez de explicar o que falta.
  const sharing = state?.source ? state.source.kind !== 'none' : false
  const hasVideo = sharing && Boolean(state?.stream?.getVideoTracks().length)
  const connection = state?.connectionState ?? 'new'

  const downloadPct = film ? Math.min(100, (film.received / Math.max(1, film.size)) * 100) : 0

  const diagnosis = state?.diagnosis ?? {
    candidateTypes: [],
    turnAvailable: false,
    triedRelay: false,
    timedOut: false
  }
  // "Travou" e diferente de "ainda esta tentando": ou o navegador desistiu, ou
  // estouramos o tempo de paciencia e ja tentamos o que havia para tentar.
  const travou = connection === 'failed' || diagnosis.timedOut

  return (
    <div className="viewer">
      <header className="viewer__bar">
        <div className="viewer__identity">
          <span className={`dot dot--${connection}`} />
          <strong>Sala {state?.roomCode ?? '—'}</strong>
          {state?.source && (
            <span className="viewer__source">
              {state.source.title}
              {state.source.hasAudio ? ' · com som' : ' · sem som'}
            </span>
          )}
          {state?.source?.kind === 'file' && state.player && (
            <PlayerBadge player={state.player} clockOffsetMs={state.clockOffsetMs} />
          )}
          {cinemaReady && (
            <span
              className={`player-badge ${Math.abs(drift) > 0.5 ? 'warn' : 'good'}`}
              title="Diferenca entre a sua posicao e a do host"
            >
              cinema · {drift >= 0 ? '+' : ''}
              {drift.toFixed(2)}s
            </span>
          )}
        </div>

        <div className="viewer__controls">
          {/* O icone do volume vira o botao de mudo: o controle e o estado no
              mesmo lugar, que e onde qualquer player o coloca. */}
          <label className="volume" title="Volume da tela">
            <button
              type="button"
              className="volume__toggle"
              onClick={() => (muted ? unlockAudio() : setMuted(true))}
              aria-label={muted ? 'Ativar o som' : 'Silenciar'}
            >
              <Icon name={muted ? 'volume-x' : 'volume'} />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              value={volume}
              aria-label="Volume da tela"
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </label>

          {/* Rotulo em texto, e nao icone: o de microfone ja e o botao do MEU
              microfone, ali do lado. Dois significados no mesmo desenho e pior
              que uma palavra curta. */}
          {state?.voiceStream && (
            <label className="volume" title="Volume da voz do host">
              <span className="volume__label">voz</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={voiceVolume}
                aria-label="Volume da voz"
                onChange={(e) => setVoiceVolume(Number(e.target.value))}
              />
            </label>
          )}

          <button
            onClick={() => void toggleMic()}
            className={micOn ? 'is-live' : ''}
            title="Falar com o host"
          >
            <Icon name={micOn ? 'mic' : 'mic-off'} />
            <span className="only-wide">{micOn ? 'Falando' : 'Microfone'}</span>
          </button>
          <button
            onClick={() => setChatOpen((v) => !v)}
            className={chatOpen ? 'is-active' : ''}
            title="Chat (tecla c)"
          >
            <Icon name="chat" />
            <span className="only-wide">Chat</span>
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <button onClick={togglePip} title="Picture-in-picture">
            <Icon name="pip" />
          </button>
          <button onClick={toggleFullscreen} title="Tela cheia">
            <Icon name="fullscreen" />
          </button>
          <button
            onClick={() => setShowHud((v) => !v)}
            className={showHud ? 'is-active' : ''}
            title="Diagnostico (tecla i)"
          >
            <Icon name="activity" />
            <span className="only-wide">Stats</span>
          </button>
        </div>
      </header>

      {micError && <p className="viewer__error">{micError}</p>}

      <div className="viewer__body">
        <main className="viewer__stage">
          {/* No Modo Cinema o filme vem do arquivo local, em qualidade original. */}
          {cinemaReady ? (
            <video
              ref={filmRef}
              src={film?.url ?? undefined}
              playsInline
              muted={muted}
              className="viewer__video"
            />
          ) : (
            /**
             * `muted` como prop, e nao so no efeito: o efeito depende de
             * [volume, muted] e nao roda quando o elemento e remontado com os
             * mesmos valores — dava para o <video> voltar com som enquanto o
             * botao ainda pedia um toque para liberar. E, no iPhone, o mudo
             * precisa estar valendo no PRIMEIRO paint, antes do autoplay.
             */
            <video
              ref={videoRef}
              playsInline
              autoPlay
              muted={muted}
              className="viewer__video"
            />
          )}
          <audio ref={voiceRef} autoPlay />

          {film && !film.ready && (
            <div className="viewer__placeholder">
              <h2>Recebendo o filme… {downloadPct.toFixed(0)}%</h2>
              <div className="download-bar">
                <span style={{ width: `${downloadPct}%` }} />
              </div>
              <p>
                {formatBytes(film.received)} de {formatBytes(film.size)}
                {film.bytesPerSecond > 0 && ` · ${formatBytes(film.bytesPerSecond)}/s`}
                <br />
                Voce esta recebendo o arquivo original, entao a qualidade nao
                depende da internet do host. Quando terminar, comeca em sincronia.
              </p>
            </div>
          )}

          {!hasVideo && !film && (
            <div className="viewer__placeholder">
              {travou ? (
                /**
                 * Dizer o que aconteceu, em vez de continuar prometendo.
                 *
                 * Este bloco existe por causa de um teste real: alguem tentou
                 * entrar pelo iPhone em 4G e ficou em "Conectando…" para sempre.
                 * Nao havia erro em lugar nenhum — a conexao direta nao fecha em
                 * CGNAT e nao havia TURN para onde ir. A informacao que faltava e
                 * exatamente a que esta aqui embaixo.
                 */
                <>
                  <h2>Nao consegui conectar</h2>
                  <p>{state?.error ?? 'A conexao com o computador do host nao fechou.'}</p>
                  <p className="viewer__diag">
                    Caminhos encontrados:{' '}
                    <strong>{diagnosis.candidateTypes.join(', ') || 'nenhum'}</strong>
                    <br />
                    Retransmissao (TURN):{' '}
                    <strong>
                      {diagnosis.turnAvailable ? 'disponivel' : 'nao configurada'}
                    </strong>
                    {diagnosis.triedRelay && ' · ja tentamos por ela'}
                  </p>
                  <p>
                    {diagnosis.turnAvailable
                      ? 'Trocar de rede (do Wi-Fi para os dados do celular, ou o contrario) costuma resolver.'
                      : 'Redes de celular e alguns provedores precisam de um servidor de retransmissao. Avise o host: falta configurar o TURN.'}
                  </p>
                  <button
                    className="button button--primary"
                    onClick={() => sessionRef.current?.retry()}
                  >
                    <Icon name="refresh" />
                    Tentar de novo
                  </button>
                </>
              ) : state?.error ? (
                <>
                  <h2>{state.error}</h2>
                  <p>
                    {diagnosis.triedRelay
                      ? 'Segunda tentativa em andamento, agora pelo servidor de retransmissao.'
                      : 'A pagina reconecta sozinha assim que o host voltar.'}
                  </p>
                </>
              ) : connection === 'connected' ? (
                <>
                  <h2>Conectado — esperando a transmissao</h2>
                  <p>
                    O host ainda nao escolheu o que compartilhar. A imagem aparece
                    aqui no instante em que ele escolher, sem recarregar a pagina.
                  </p>
                </>
              ) : (
                <>
                  <h2>Conectando…</h2>
                  <p>
                    Procurando um caminho de rede ate o computador do host
                    {diagnosis.candidateTypes.length > 0 &&
                      ` (${diagnosis.candidateTypes.join(', ')})`}
                    .
                  </p>
                </>
              )}
            </div>
          )}

          {muted && (hasVideo || cinemaReady) && (
            <button className="viewer__unlock" onClick={unlockAudio}>
              <Icon name="volume" size={18} />
              Toque para ativar o som
            </button>
          )}

          {showHud && state?.stats && (
            <Hud stats={state.stats} offsetMs={state.clockOffsetMs} />
          )}
        </main>

        {chatOpen && (
          <aside className="viewer__chat">
            <Chat
              messages={messages}
              onSend={(text) => {
                sessionRef.current?.sendChat(text)
                pushMessage(nameRef.current, text, true)
              }}
            />
          </aside>
        )}
      </div>
    </div>
  )
}
