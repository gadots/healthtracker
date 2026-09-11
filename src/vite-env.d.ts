/// <reference types="vite/client" />

import type { FitbitBridge, HealthAssistantBridge } from './types'

declare global {
  /** Injected by Vite from package.json at build time. */
  const __APP_VERSION__: string

  interface Window {
    fitbit?: FitbitBridge
    healthAssistant?: HealthAssistantBridge
  }
}

export {}
