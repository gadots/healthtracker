/// <reference types="vite/client" />

import type { FitbitBridge, HealthAssistantBridge } from './types'

declare global {
  interface Window {
    fitbit?: FitbitBridge
    healthAssistant?: HealthAssistantBridge
  }

  /** Injected by vite `define`. True only in the hosted web build. */
  const __WEB_TARGET__: boolean
}

export {}
