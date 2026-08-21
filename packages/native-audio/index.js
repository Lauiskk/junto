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

  /**
   * Comeca a capturar. `include: true` pega SO o processo (e filhos);
   * `include: false` pega tudo MENOS ele — util para silenciar o Discord
   * quando se compartilha a tela inteira.
   */
  startCapture(pid, include, onPcm) {
    if (!native) throw new Error('modulo nativo indisponivel: ' + loadError)
    return native.startCapture(pid, Boolean(include), onPcm)
  },

  stopCapture() {
    if (!native) return false
    return native.stopCapture()
  },

  ultimoErro() {
    return native ? native.lastError() : loadError
  },

  formato() {
    return native ? native.formatInfo() : { sampleRate: 48000, channels: 2, bitsPerSample: 16 }
  }
}
