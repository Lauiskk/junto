/**
 * Envolucro do addon nativo.
 *
 * Carregar isto NUNCA pode derrubar o app: em Windows antigo, sem toolchain de
 * build ou com o addon ausente, o host continua funcionando com o audio do
 * sistema — pior em privacidade, mas funcional, e a interface avisa.
 */
let native = null
let loadError = null

try {
  if (process.platform !== 'win32') {
    throw new Error('captura por processo so existe no Windows')
  }
  native = require('./build/Release/junto_audio.node')
} catch (err) {
  loadError = err instanceof Error ? err.message : String(err)
}

const disponivel = () => native !== null

module.exports = {
  disponivel,
  erroDeCarregamento: () => loadError,

  /** "window:<HWND>:0" -> pid do processo dono da janela (null se nao der). */
  pidFromWindowId(sourceId) {
    if (!native) return null
    try {
      return native.pidFromWindowId(String(sourceId))
    } catch {
      return null
    }
  },

  /** PID deste proprio processo — o que NUNCA deve entrar na captura. */
  currentProcessId() {
    if (!native) return null
    try {
      return native.currentProcessId()
    } catch {
      return null
    }
  },

  /**
   * Este processo e TODOS os filhos.
   *
   * O Chromium renderiza audio num processo filho de servico, entao excluir so o
   * principal deixaria o proprio som do app passar — e voltar como eco para quem
   * esta assistindo.
   */
  ownProcessTree() {
    if (!native) return []
    try {
      return native.ownProcessTree()
    } catch {
      return []
    }
  },

  /** Processos com stream de audio aberta agora, com o nome do executavel. */
  listAudioSessions() {
    if (!native) return []
    try {
      return native.listAudioSessions()
    } catch {
      return []
    }
  },

  /**
   * Comeca a capturar.
   *
   * `{ excludePid }` pega tudo MENOS aquele processo (e filhos) — uma captura
   * so, e o caminho do caso comum. `{ includePids }` pega exatamente aqueles
   * processos e soma; e o unico jeito de deixar MAIS DE UM de fora, porque os
   * parametros de ativacao do Windows so aceitam um alvo por captura.
   */
  startCapture(options, onPcm) {
    if (!native) throw new Error('modulo nativo indisponivel: ' + loadError)
    return native.startCapture(options ?? {}, onPcm)
  },

  /** Troca o conjunto de processos capturados sem interromper o audio. */
  setIncludePids(pids) {
    if (!native) return false
    try {
      return native.setIncludePids(pids)
    } catch {
      return false
    }
  },

  stopCapture() {
    if (!native) return false
    return native.stopCapture()
  },

  /** Alguma fonte chegou a ativar? Se nao, quem chama precisa do plano B. */
  capturando() {
    if (!native) return false
    try {
      return native.capturando()
    } catch {
      return false
    }
  },

  ultimoErro() {
    return native ? native.lastError() : loadError
  },

  formato() {
    return native ? native.formatInfo() : { sampleRate: 48000, channels: 2, bitsPerSample: 16 }
  }
}
