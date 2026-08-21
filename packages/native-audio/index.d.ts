export interface AudioFormat {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export declare function disponivel(): boolean
export declare function erroDeCarregamento(): string | null
export declare function pidFromWindowId(sourceId: string): number | null
export declare function startCapture(
  pid: number,
  include: boolean,
  onPcm: (chunk: Buffer) => void
): boolean
export declare function stopCapture(): boolean
export declare function ultimoErro(): string | null
export declare function formato(): AudioFormat
