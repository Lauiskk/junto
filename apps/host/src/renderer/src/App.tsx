import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactElement
} from 'react'
import {
  DEFAULT_PRESET_ID,
  HostSession,
  PRESET_LIST,
  closeMicrophone,
  getPreset,
  openMicrophone,
  type HostState
} from '@junto/rtc'
import type { CaptureSource } from '../../main/capture'
import {
  describeVideoTrack,
  startCapture,
  stopCapture,
  stopStreamTracks
} from './capture'
import {
  FileLoadError,
  formatTime,
  loadFileIntoPlayer,
  revokeCurrentSource
} from './filePlayer'
import { SourcePicker } from './components/SourcePicker'
import { ViewerList } from './components/ViewerList'
import { UploadBudget } from './components/UploadBudget'
import { Icon } from './components/Icon'
import { Chat, type ChatMessage } from './components/Chat'

/**
 * Painel do host.
 *
 * Duas fontes possiveis, mesmo caminho de saida: a tela (com audio do sistema)
 * ou um arquivo de video do computador. Quem assiste nao precisa saber a
 * diferenca — dos dois lados chega uma stream so.
 */

type Mode = 'none' | 'screen' | 'file'

/** Posicao do filme reenviada a cada 2s enquanto toca. */
const POSITION_HEARTBEAT_MS = 2000

export function App(): ReactElement {
  const [config, setConfig] = useState<{ signalingUrl: string; webUrl: string } | null>(
    null
  )
  const [state, setState] = useState<HostState | null>(null)
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID)
  const [withSystemAudio, setWithSystemAudio] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('none')
  const [source, setSource] = useState<CaptureSource | null>(null)
  const [fileTitle, setFileTitle] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null)
  const [copied, setCopied] = useState<'principal' | 'rede' | null>(null)
  const [lanAddresses, setLanAddresses] = useState<string[]>([])

  const [micOn, setMicOn] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cinema, setCinema] = useState(false)
  const [audioCortado, setAudioCortado] = useState(false)
  const [audioMode, setAudioMode] = useState<
    'processo' | 'montado' | 'sistema' | 'nenhum'
  >('nenhum')
  /**
   * Executaveis silenciados, ex.: ["discord.exe"].
   *
   * Por NOME e nao por PID: o Discord roda com mais de um processo, e o Chromium
   * renderiza audio num processo filho. Silenciar "Discord" precisa pegar todos —
   * medido na propria maquina, `Discord.exe` aparece em dois PIDs ao mesmo tempo.
   */
  const [mutedApps, setMutedApps] = useState<string[]>([])
  const filmFileRef = useRef<File | null>(null)

  /**
   * Corta o audio que sai daqui, na hora.
   *
   * `enabled = false` para de enviar amostras imediatamente, sem renegociar nada
   * e sem derrubar a transmissao de video. Existe porque hoje o audio capturado e
   * o do sistema inteiro: se uma chamada privada comecar no meio da sessao, tem
   * que haver um botao de panico a um clique de distancia.
   */
  const alternarAudio = useCallback((): void => {
    const track = streamRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setAudioCortado(!track.enabled)
  }, [])

  const sessionRef = useRef<HostSession | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const previewRef = useRef<HTMLVideoElement>(null)
  const fileVideoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const messageId = useRef(0)

  const pushMessage = useCallback((from: string, text: string, mine: boolean): void => {
    setMessages((current) => [
      ...current.slice(-199),
      { id: ++messageId.current, from, text, at: Date.now(), mine }
    ])
  }, [])

  // -- sessao ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false
    void window.junto.getConfig().then((cfg) => {
      if (cancelled) return
      setConfig(cfg)
      const session = new HostSession({
        signalingUrl: cfg.signalingUrl,
        displayName: 'Host',
        presetId: DEFAULT_PRESET_ID,
        onState: setState,
        onChat: (from, text) => pushMessage(from, text, false)
      })
      sessionRef.current = session
      session.start()
    })
    void window.junto.getLanAddresses().then((addresses) => {
      if (!cancelled) setLanAddresses(addresses)
    })
    return () => {
      cancelled = true
      closeMicrophone(micTrackRef.current)
      sessionRef.current?.stop()
      stopCapture(streamRef.current)
    }
  }, [pushMessage])

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
          ? 'Permissao de microfone negada.'
          : 'Nao foi possivel abrir o microfone.'
      )
    }
  }

  // Espelho local do que sai daqui (mudo, para nao duplicar o audio).
  useEffect(() => {
    if (previewRef.current && mode !== 'file') previewRef.current.srcObject = stream
  }, [stream, mode])

  const stopStreaming = useCallback(async (): Promise<void> => {
    stopCapture(streamRef.current)
    streamRef.current = null
    if (fileVideoRef.current) revokeCurrentSource(fileVideoRef.current)
    sessionRef.current?.stopFilm()
    filmFileRef.current = null
    setCinema(false)
    setAudioMode('nenhum')
    setStream(null)
    setSource(null)
    setFileTitle(null)
    setMode('none')
    setNotice(null)
    await sessionRef.current?.setStream(null)
    void window.junto.keepAwake(false)
  }, [])

  // -- fonte: tela / janela --------------------------------------------------

  const pickSource = useCallback(
    async (picked: CaptureSource): Promise<void> => {
      setPickerOpen(false)
      setError(null)

      /**
       * Adquire a fonte NOVA antes de soltar a antiga.
       *
       * Fazer o contrario deixava o sender segurando uma trilha morta durante os
       * segundos da aquisicao — quem assistia congelava no ultimo quadro. E se a
       * aquisicao falhasse (fonte sumiu, permissao negada), congelava para
       * sempre: foi exatamente o que aconteceu ao trocar de janela para tela
       * cheia num teste real.
       */
      const anterior = streamRef.current

      try {
        if (fileVideoRef.current) revokeCurrentSource(fileVideoRef.current)

        const result = await startCapture(
          picked,
          withSystemAudio,
          getPreset(presetId),
          mutedApps
        )

        streamRef.current = result.stream
        setStream(result.stream)
        setSource(picked)
        setFileTitle(null)
        setMode('screen')
        await sessionRef.current?.setStream(result.stream, {
          kind: picked.kind === 'screen' ? 'screen' : 'window',
          title: picked.name
        })

        // A troca ja aconteceu para quem assiste; agora sim a fonte antiga pode ir.
        stopStreamTracks(anterior)

        void window.junto.keepAwake(true)

        setAudioMode(result.audioMode)

        if (withSystemAudio && result.stream.getAudioTracks().length === 0) {
          setNotice(
            'Compartilhado, mas sem trilha de audio. No Windows isso costuma ser driver de audio em modo exclusivo — feche o app que segurou o dispositivo e escolha a fonte de novo.'
          )
        } else if (result.audioMode === 'processo') {
          setNotice(
            'Audio isolado: esta saindo APENAS o som desta janela. Chamadas e notificacoes de outros apps nao vao junto.'
          )
        } else if (result.audioMode === 'montado') {
          setNotice(
            mutedApps.length > 0
              ? `Som do computador com ${mutedApps.length} app(s) silenciado(s). O Junto nunca entra: a voz de quem assiste nao volta como eco.`
              : 'Som do computador, sem o proprio Junto — a voz de quem assiste nao volta como eco. Notificacoes e outros programas vao junto.'
          )
        } else if (result.audioNote) {
          setNotice(result.audioNote)
        } else if (result.usedFallback) {
          setNotice('Captura feita pelo caminho de compatibilidade (sem problema).')
        } else {
          setNotice(null)
        }

        result.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
          void stopStreaming()
        })
      } catch (err) {
        // A fonte anterior continua no ar de proposito: falhar em trocar nao
        // pode significar parar de transmitir.
        setError({
          message: err instanceof Error ? err.message : String(err),
          hint: anterior
            ? 'A fonte anterior continua sendo transmitida — ninguem ficou sem imagem.'
            : undefined
        })
      }
    },
    [presetId, withSystemAudio, mutedApps, stopStreaming]
  )

  // -- fonte: arquivo local --------------------------------------------------

  const pickFile = useCallback(
    async (file: File): Promise<void> => {
      const video = fileVideoRef.current
      if (!video) return

      setError(null)
      setNotice(null)
      try {
        stopCapture(streamRef.current)
        streamRef.current = null
        setSource(null)
        setMode('file')
        setCinema(false)
        // Reescolher o MESMO arquivo nao cancela nada: cancelar mandaria quem
        // ja esta baixando recomecar do zero sem motivo.
        const anterior = filmFileRef.current
        const mesmoArquivo =
          anterior?.name === file.name && anterior?.size === file.size
        if (!mesmoArquivo) sessionRef.current?.stopFilm()
        filmFileRef.current = file

        const loaded = await loadFileIntoPlayer(video, file)

        streamRef.current = loaded.stream
        setStream(loaded.stream)
        setFileTitle(loaded.title)

        // Filme e conteudo em movimento: 'motion' no encoder e audio estereo alto.
        setPresetId('movie')

        await sessionRef.current?.setStream(loaded.stream, {
          kind: 'file',
          title: loaded.title
        })
        void window.junto.keepAwake(true)

        setNotice(
          'O filme esta sendo recodificado ao vivo, entao a qualidade fica limitada pelo seu upload. Dar play aqui inicia para todo mundo.'
        )
      } catch (err) {
        setMode('none')
        if (err instanceof FileLoadError) setError({ message: err.message, hint: err.hint })
        else setError({ message: err instanceof Error ? err.message : String(err) })
      }
    },
    []
  )

  /**
   * Modo Cinema: para de mandar pixels e passa a mandar o ARQUIVO.
   *
   * A troca vale a pena quando o filme e bom demais para caber no upload: em vez
   * de recodificar 8 Mbps continuamente por duas horas, manda os bytes uma vez e
   * depois so a posicao do player. O custo e a espera do download.
   */
  const toggleCinema = useCallback(async (): Promise<void> => {
    const session = sessionRef.current
    const file = filmFileRef.current
    const video = fileVideoRef.current
    if (!session || !file || !video) return

    if (cinema) {
      session.stopFilm('o host voltou para a transmissao normal')
      setCinema(false)
      // Volta a mandar pixels do proprio player.
      const capturable = video as HTMLVideoElement & { captureStream?: () => MediaStream }
      const stream = capturable.captureStream?.()
      if (stream) {
        streamRef.current = stream
        setStream(stream)
        await session.setStream(stream, { kind: 'file', title: file.name })
      }
      return
    }

    // Para o envio de video: cada um vai reproduzir o proprio arquivo.
    stopCapture(streamRef.current)
    streamRef.current = null
    setStream(null)
    await session.setStream(null, { kind: 'file', title: file.name })
    session.startFilm(file, Number.isFinite(video.duration) ? video.duration : null)
    setCinema(true)
    setNotice(
      'Modo Cinema ligado: cada pessoa baixa o arquivo original e reproduz localmente, em sincronia. A qualidade passa a ser a do arquivo, nao a do seu upload.'
    )
  }, [cinema])

  /** Espelha play/pause/seek/posicao para quem assiste. */
  useEffect(() => {
    const video = fileVideoRef.current
    if (!video || mode !== 'file') return

    const report = (playerState: 'playing' | 'paused' | 'ended'): void => {
      sessionRef.current?.broadcastPlayerState(
        playerState,
        video.currentTime,
        Number.isFinite(video.duration) ? video.duration : null
      )
    }

    const onPlay = (): void => report('playing')
    const onPause = (): void => report('paused')
    const onEnded = (): void => report('ended')
    const onSeeked = (): void => report(video.paused ? 'paused' : 'playing')

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('seeked', onSeeked)

    const heartbeat = setInterval(() => {
      if (!video.paused) report('playing')
    }, POSITION_HEARTBEAT_MS)

    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('seeked', onSeeked)
      clearInterval(heartbeat)
    }
  }, [mode])

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    const file = event.dataTransfer.files[0]
    if (file) void pickFile(file)
  }

  // -- preset ----------------------------------------------------------------

  useEffect(() => {
    const preset = getPreset(presetId)
    void sessionRef.current?.setPreset(preset)
    // Em modo arquivo o fps vem do proprio video; a constraint so vale na captura.
    if (mode === 'screen') {
      const track = streamRef.current?.getVideoTracks()[0]
      void track?.applyConstraints({ frameRate: { max: preset.maxFramerate } })
    }
  }, [presetId, mode])

  // -- link ------------------------------------------------------------------

  const inviteLink =
    config && state?.roomCode ? `${config.webUrl}?sala=${state.roomCode}` : null

  /**
   * Link alternativo com o IP da maquina na rede.
   *
   * Quando o servidor esta rodando aqui mesmo, o link principal aponta para
   * localhost — e mandar isso para alguem e o erro mais facil de cometer, porque
   * abre normalmente na SUA maquina e em nenhuma outra.
   */
  const lanLink = (():  string | null => {
    if (!config || !state?.roomCode || lanAddresses.length === 0) return null
    if (!/localhost|127\.0\.0\.1/.test(config.webUrl)) return null
    try {
      const url = new URL(config.webUrl)
      url.hostname = lanAddresses[0]!
      return `${url.origin}?sala=${state.roomCode}`
    } catch {
      return null
    }
  })()

  const copyLink = async (link: string, qual: 'principal' | 'rede'): Promise<void> => {
    await navigator.clipboard.writeText(link)
    setCopied(qual)
    setTimeout(() => setCopied(null), 1600)
  }

  const viewers = state?.viewers ?? []
  const firstStats = viewers.find((v) => v.stats)?.stats ?? null
  const temAudio = Boolean(stream?.getAudioTracks().length)

  /**
   * Encoders por software (OpenH264, libvpx, libaom) funcionam, mas comem CPU —
   * o que aparece como travada justo quando voce esta jogando E transmitindo.
   * O nome do encoder e a unica forma de saber qual esta em uso, entao vale
   * traduzir isso em vez de deixar so a sigla no painel.
   */
  const encoder = firstStats?.video.implementation ?? null
  const softwareEncoder = encoder ? /openh264|libvpx|libaom|ffmpeg/i.test(encoder) : false

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__dot" />
          Junto <em>host</em>
        </div>
        <div className="topbar__status">
          <button
            onClick={() => void toggleMic()}
            className={micOn ? 'is-live' : ''}
            title="Falar com quem esta assistindo"
          >
            <Icon name={micOn ? 'mic' : 'mic-off'} />
            {micOn ? 'Microfone aberto' : 'Microfone'}
          </button>
          <span className={`chip chip--${state?.status ?? 'idle'}`}>
            {state?.status === 'connected'
              ? 'conectado ao servidor'
              : state?.status === 'reconnecting'
                ? 'reconectando…'
                : state?.status === 'connecting'
                  ? 'conectando…'
                  : 'offline'}
          </span>
          {stream && <span className="chip chip--live">no ar</span>}
        </div>
      </header>

      {/* O aviso so aparece quando ha risco real: audio do sistema saindo daqui. */}
      {temAudio && mode === 'screen' && audioMode !== 'processo' && (
        <div className={`audio-warning ${audioCortado ? 'is-muted' : ''}`}>
          <span>
            {audioCortado ? (
              <>
                <strong>Audio cortado.</strong> Ninguem esta ouvindo seu computador.
              </>
            ) : audioMode === 'montado' ? (
              <>
                <strong>
                  {mutedApps.length > 0
                    ? `${mutedApps.length} app(s) silenciado(s)`
                    : 'Nenhum app silenciado'}
                </strong>
                , mas o resto do som do computador continua saindo — notificacoes e
                outros programas vao junto.
              </>
            ) : (
              <>
                <strong>Estao ouvindo o som do sistema inteiro</strong> — inclusive
                chamadas, notificacoes, outros apps e ate a voz de quem esta
                assistindo, que volta como eco.
              </>
            )}
          </span>
          <button onClick={alternarAudio} className={audioCortado ? '' : 'is-live'}>
            <Icon name={audioCortado ? 'volume' : 'volume-x'} />
            {audioCortado ? 'Voltar o audio' : 'Cortar audio agora'}
          </button>
        </div>
      )}

      <main className="grid">
        <section className="col">
          {/* --------------------------------------------------------- sala */}
          <article className="card">
            <h2 className="card__title">
              <span className="card__step">1</span>Sua sala
            </h2>
            <div className="room-code">{state?.roomCode ?? '······'}</div>
            {inviteLink ? (
              <>
                <div className="link-row">
                  <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
                  <button
                    className="button--primary"
                    onClick={() => void copyLink(inviteLink, 'principal')}
                  >
                    <Icon name={copied === 'principal' ? 'check' : 'copy'} />
                    {copied === 'principal' ? 'Copiado!' : 'Copiar'}
                  </button>
                </div>

                {lanLink ? (
                  <>
                    <div className="link-row">
                      <input readOnly value={lanLink} onFocus={(e) => e.target.select()} />
                      <button onClick={() => void copyLink(lanLink, 'rede')}>
                        <Icon name={copied === 'rede' ? 'check' : 'copy'} />
                        {copied === 'rede' ? 'Copiado!' : 'Copiar'}
                      </button>
                    </div>
                    <p className="card__hint">
                      O primeiro link so abre <strong>nesta maquina</strong>. Para
                      alguem na mesma casa ou no mesmo Wi-Fi, mande o segundo. Para
                      alguem em outra cidade, e preciso publicar o servidor — veja o
                      README.
                    </p>
                  </>
                ) : (
                  <p className="card__hint">
                    Quem receber esse link so precisa abrir no navegador. Sem instalar
                    nada, sem criar conta.
                  </p>
                )}
              </>
            ) : (
              <p className="card__hint">Criando a sala…</p>
            )}
            {state?.error && <p className="alert">{state.error}</p>}
          </article>

          {/* ------------------------------------------------------- fonte */}
          <article className="card">
            <h2 className="card__title">
              <span className="card__step">2</span>O que transmitir
            </h2>

            <div
              className={`preview ${dragging ? 'is-dragging' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {/* Escondido tambem quando nao ha nada: um <video> vazio pinta
                  um retangulo preto por cima do fundo quadriculado, e o vazio
                  fica parecendo uma transmissao de tela preta. */}
              <video
                ref={previewRef}
                className={mode === 'screen' ? '' : 'is-hidden'}
                muted
                autoPlay
                playsInline
              />
              <video
                ref={fileVideoRef}
                className={mode === 'file' ? '' : 'is-hidden'}
                controls
                playsInline
              />
              {mode === 'none' && (
                <div className="preview__empty">
                  {dragging
                    ? 'Solte o arquivo para transmitir'
                    : 'Nada sendo transmitido — arraste um video aqui'}
                </div>
              )}
            </div>

            <div className="row">
              <button className="button--primary" onClick={() => setPickerOpen(true)}>
                <Icon name="monitor" />
                {mode === 'screen' ? 'Trocar tela' : 'Tela ou janela'}
              </button>
              <button onClick={() => fileInputRef.current?.click()}>
                <Icon name="film" />
                {mode === 'file' ? 'Trocar arquivo' : 'Arquivo do PC'}
              </button>
              {mode === 'file' && (
                <button
                  onClick={() => void toggleCinema()}
                  className={cinema ? 'is-active' : ''}
                  title="Manda o arquivo original em vez de recodificar"
                >
                  <Icon name="film" />
                  Modo Cinema
                </button>
              )}
              {mode !== 'none' && (
                <button onClick={() => void stopStreaming()}>
                  <Icon name="stop" />
                  Parar
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void pickFile(file)
                e.target.value = ''
              }}
            />

            {mode === 'screen' && stream && (
              <p className="card__hint">
                <strong>{source?.name}</strong> · {describeVideoTrack(stream)} ·{' '}
                {stream.getAudioTracks().length > 0 ? 'com som' : 'sem som'}
              </p>
            )}
            {mode === 'file' && fileTitle && (
              <p className="card__hint">
                <strong>{fileTitle}</strong>
                {fileVideoRef.current?.duration
                  ? ` · ${formatTime(fileVideoRef.current.duration)}`
                  : ''}{' '}
                · use os controles do player acima; play, pause e seek valem para
                todo mundo
              </p>
            )}
            {notice && <p className="alert alert--soft">{notice}</p>}
            {error && (
              <p className="alert">
                {error.message}
                {error.hint && (
                  <>
                    <br />
                    <span className="alert__hint">{error.hint}</span>
                  </>
                )}
              </p>
            )}
          </article>

          {/* ------------------------------------------------------ preset */}
          <article className="card">
            <h2 className="card__title">
              <span className="card__step">3</span>Prioridade da qualidade
            </h2>
            <div className="presets">
              {PRESET_LIST.map((preset) => (
                <button
                  key={preset.id}
                  className={`preset ${presetId === preset.id ? 'is-active' : ''}`}
                  onClick={() => setPresetId(preset.id)}
                >
                  <strong>{preset.label}</strong>
                  <em>{preset.description}</em>
                  <span>
                    {preset.maxHeight}p{preset.maxFramerate} ·{' '}
                    {(preset.maxBitrateKbps / 1000).toFixed(1)} Mbps
                  </span>
                </button>
              ))}
            </div>
            <p className="card__hint">
              Sob rede ou CPU apertada, algo tem que ceder. O preset decide o que:
              nitidez (trabalho) ou fluidez (jogo).
            </p>
          </article>

          {/* ------------------------------------------------ upload */}
          <UploadBudget
            value={state?.upload ?? { mode: 'auto', mbps: 0 }}
            measuredKbps={state?.uploadMeasuredKbps ?? 0}
            warning={state?.uploadWarning ?? null}
            onChange={(setting) => void sessionRef.current?.setUploadSetting(setting)}
          />
        </section>

        <section className="col">
          <article className="card card--grow">
            <h2 className="card__title">
              <Icon name="users" size={15} />
              Quem esta assistindo{' '}
              {viewers.length > 0 && <span>{viewers.length} conectado{viewers.length > 1 ? 's' : ''}</span>}
            </h2>
            <ViewerList
              viewers={viewers}
              onKick={(peerId, block) => sessionRef.current?.kickViewer(peerId, block)}
            />
          </article>

          <article className="card card--chat">
            <h2 className="card__title">
              <Icon name="chat" size={15} />
              Chat da sala
            </h2>
            {micError && <p className="alert">{micError}</p>}
            <Chat
              messages={messages}
              onSend={(text) => {
                sessionRef.current?.sendChat(text)
                pushMessage('Voce', text, true)
              }}
            />
          </article>

          <article className="card">
            <h2 className="card__title">
              <Icon name="activity" size={15} />
              Diagnostico
            </h2>
            <dl className="diag">
              <div>
                <dt>Codec negociado</dt>
                <dd>{state?.codec?.replace('video/', '') ?? '—'}</dd>
              </div>
              <div>
                <dt>Encoder</dt>
                <dd
                  className={softwareEncoder ? 'warn' : undefined}
                  title="Nomes com 'External'/'NvEnc'/'QuickSync' indicam GPU"
                >
                  {encoder ?? '—'}
                  {softwareEncoder && ' (CPU)'}
                </dd>
              </div>
              <div>
                <dt>Banda disponivel</dt>
                <dd>
                  {firstStats?.network.availableOutgoingKbps
                    ? `${Math.round(firstStats.network.availableOutgoingKbps / 100) / 10} Mbps`
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Servidor</dt>
                <dd className="muted">{config?.signalingUrl ?? '—'}</dd>
              </div>
            </dl>

            {softwareEncoder && (
              <p className="card__hint">
                <strong className="warn">Codificando por software.</strong> Funciona,
                mas gasta CPU — em 1080p60 isso pode travar o jogo que voce esta
                transmitindo. Se acontecer, use o preset <em>Internet ruim</em> ou
                baixe para 30fps.
              </p>
            )}
          </article>
        </section>
      </main>

      <SourcePicker
        open={pickerOpen}
        withSystemAudio={withSystemAudio}
        onToggleAudio={setWithSystemAudio}
        mutedApps={mutedApps}
        onMutedChange={(apps) => {
          setMutedApps(apps)
          // Sem interromper o audio: quem esta assistindo nao ouve um buraco
          // porque voce marcou uma caixinha.
          void window.junto.setMutedApps(apps)
        }}
        onPick={(picked) => void pickSource(picked)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  )
}
