export interface AudioFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

/** Um processo com stream de audio aberta agora. */
export interface AudioSession {
  pid: number
  /** Nome do executavel, ex.: "Discord.exe". E por ele que a UI casa com a janela. */
  executable: string
}

export interface CaptureOptions {
  /**
   * Caminho rapido: uma captura so, "tudo menos este processo".
   * Use para o caso comum de nao devolver o proprio audio do app.
   */
  excludePid?: number
  /**
   * Caminho de montagem: uma captura por processo, somadas aqui dentro.
   * Necessario quando ha MAIS DE UM processo a deixar de fora — os parametros
   * de ativacao do Windows so aceitam um alvo por captura.
   */
  includePids?: number[]
}

export declare function disponivel(): boolean
export declare function erroDeCarregamento(): string | null
export declare function pidFromWindowId(sourceId: string): number | null
export declare function currentProcessId(): number | null
export declare function ownProcessTree(): number[]
export declare function listAudioSessions(): AudioSession[]
export declare function startCapture(
  options: CaptureOptions,
  onPcm: (chunk: Buffer) => void
): boolean
export declare function setIncludePids(pids: number[]): boolean
export declare function stopCapture(): boolean
export declare function capturando(): boolean
export declare function ultimoErro(): string | null
export declare function formato(): AudioFormat
