import type { FitbitBridge } from '@/types'
import { createWebBridge } from './web-bridge'

/**
 * Single entry point to the privileged data layer.
 *
 * In Electron the preload script has already installed `window.fitbit` by the
 * time this module is evaluated, so reading it at module scope is safe. In the
 * hosted web build there is no preload, and the bridge is backed by the BFF.
 */
export const isElectron = Boolean(window.fitbit)

export const fitbitBridge: FitbitBridge | null =
  window.fitbit ?? (__WEB_TARGET__ ? createWebBridge() : null)

/** True only when running as a plain page with no data backend (demo only). */
export const isDemoOnly = fitbitBridge === null
