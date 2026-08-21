/**
 * Microfone.
 *
 * Repare no contraste com `disableAudioProcessing()`, usado no som do sistema:
 * aqui o processamento fica todo LIGADO, e de proposito. Sem cancelamento de
 * eco, o som do filme sai pelos seus alto-falantes, volta pelo seu microfone e
 * o pessoal do outro lado ouve tudo duplicado com meio segundo de atraso.
 *
 * A mesma configuracao que estragaria a musica e a que salva a conversa.
 */

export async function openMicrophone(deviceId?: string): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    },
    video: false
  })

  const track = stream.getAudioTracks()[0]
  if (!track) {
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('nenhum microfone disponivel')
  }
  return track
}

export function closeMicrophone(track: MediaStreamTrack | null): void {
  track?.stop()
}

/**
 * Nivel de voz de 0 a 1, para desenhar o indicador de "quem esta falando".
 * Retorna uma funcao de parada — chame ao fechar o microfone.
 */
export function meterVoiceLevel(
  track: MediaStreamTrack,
  onLevel: (level: number) => void,
  intervalMs = 120
): () => void {
  const context = new AudioContext()
  const source = context.createMediaStreamSource(new MediaStream([track]))
  const analyser = context.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)

  const buffer = new Uint8Array(analyser.frequencyBinCount)
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buffer)
    let peak = 0
    for (const sample of buffer) peak = Math.max(peak, Math.abs(sample - 128))
    onLevel(Math.min(1, peak / 64))
  }, intervalMs)

  return () => {
    clearInterval(timer)
    source.disconnect()
    void context.close()
  }
}
