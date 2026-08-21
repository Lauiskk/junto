import { useState, type FormEvent, type ReactElement } from 'react'
import { ROOM_CODE_LENGTH } from '@junto/protocol'
import { checkNetwork, fetchIceServers, type NetworkCheckResult } from '@junto/rtc'

interface Props {
  initialCode: string
  onJoin: (roomCode: string, name: string, password?: string) => void
  signalingUrl: string
}

/**
 * Entrada da sala.
 *
 * O botao "Entrar" tem uma segunda funcao alem da obvia: ele e o gesto do
 * usuario que o navegador exige para permitir audio. Por isso a conexao so
 * comeca no clique, e nao automaticamente ao abrir o link.
 */
export function JoinForm({ initialCode, onJoin, signalingUrl }: Props): ReactElement {
  const [code, setCode] = useState(initialCode)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<NetworkCheckResult | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)

  const codeIsValid = code.length === ROOM_CODE_LENGTH

  const runCheck = async (): Promise<void> => {
    setChecking(true)
    setCheck(null)
    setCheckError(null)
    try {
      const iceServers = await fetchIceServers(signalingUrl)
      setCheck(await checkNetwork(iceServers))
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'falha ao testar a rede')
    } finally {
      setChecking(false)
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!codeIsValid) return
    onJoin(code, name.trim() || 'Convidado', password)
  }

  return (
    <div className="join">
      <form className="join__card" onSubmit={submit}>
        <h1 className="join__title">Junto</h1>
        <p className="join__subtitle">
          Entre na sala para assistir a tela do seu amigo, com som e sem atraso.
        </p>

        <label className="field">
          <span>Codigo da sala</span>
          <input
            className="field__input field__input--code"
            value={code}
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z0-9]/g, '')
                  .slice(0, ROOM_CODE_LENGTH)
              )
            }
            placeholder="XXXXXX"
            autoFocus
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Seu nome</span>
          <input
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Convidado"
            maxLength={40}
          />
        </label>

        <label className="field">
          <span>
            Senha <em>(so se o host tiver definido uma)</em>
          </span>
          <input
            className="field__input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
        </label>

        <button className="button button--primary" type="submit" disabled={!codeIsValid}>
          Entrar e ouvir
        </button>

        <p className="join__hint">
          Dica: aperte <kbd>i</kbd> durante a transmissao para ver latencia, fps e
          perda de pacotes.
        </p>

        <div className="netcheck">
          <button type="button" onClick={() => void runCheck()} disabled={checking}>
            {checking ? 'Testando a rede…' : 'Testar minha conexao'}
          </button>

          {checkError && <p className="netcheck__error">{checkError}</p>}

          {check && (
            <div className="netcheck__result">
              <ul>
                <li className={check.directPossible ? 'good' : 'bad'}>
                  {check.directPossible ? '✓' : '✗'} Conexao direta
                </li>
                <li className={check.stunOk ? 'good' : 'warn'}>
                  {check.stunOk ? '✓' : '!'} STUN (descoberta de IP)
                </li>
                <li
                  className={
                    check.turnOk ? 'good' : check.turnConfigured ? 'bad' : 'warn'
                  }
                >
                  {check.turnOk ? '✓' : check.turnConfigured ? '✗' : '—'} TURN
                  {!check.turnConfigured && ' (nao configurado)'}
                </li>
              </ul>
              <p>{check.verdict}</p>
            </div>
          )}
        </div>
      </form>
    </div>
  )
}
