import type { JuntoApi } from '../../preload'

declare global {
  interface Window {
    junto: JuntoApi
  }
}

export {}
