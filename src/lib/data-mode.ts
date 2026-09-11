import type { DataModePreference, DataSource, HealthProvider } from '@/types'

export type DataModeTone = 'live' | 'demo' | 'cache'

export interface DataModeState {
  /** What the dashboard is actually showing. */
  mode: 'live' | 'demo'
  /** Demo is being shown even though an account is connected (the user forced it). */
  forced: boolean
  tone: DataModeTone
  /** Short text for the badge. */
  label: string
  /** Longer explanation for the tooltip / Devices view. */
  detail: string
  /** False when choosing "live" could not possibly produce live data. */
  canUseLive: boolean
}

function providerLabel(provider: HealthProvider) {
  return provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'
}

/**
 * Single place that turns the persisted preference plus the connection state
 * into everything the UI needs to say about where the numbers came from.
 * Every indicator (topbar badge, sidebar label, Devices card) derives from
 * one call to this, so they cannot drift apart.
 */
export function resolveDataMode(input: {
  preference: DataModePreference
  connected: boolean
  provider: HealthProvider
  source: DataSource
}): DataModeState {
  const { preference, connected, provider, source } = input

  if (preference === 'demo') {
    return {
      mode: 'demo',
      forced: connected,
      tone: 'demo',
      label: 'Demo data',
      detail: connected
        ? `Sample data. Your ${providerLabel(provider)} account stays connected — live sync is paused.`
        : 'Sample data. Connect a provider to see your own measurements.',
      canUseLive: connected,
    }
  }

  if (connected) {
    return {
      mode: 'live',
      forced: false,
      tone: 'live',
      label: `Live · ${providerLabel(provider)}`,
      detail: `Synced from your ${providerLabel(provider)} account.`,
      canUseLive: true,
    }
  }

  // Not connected: whatever is on screen is either the last cached sync or demo.
  if (source === 'cache') {
    return {
      mode: 'live',
      forced: false,
      tone: 'cache',
      label: 'Local cache',
      detail: 'Showing the last data synced to this computer. Reconnect to refresh it.',
      canUseLive: false,
    }
  }

  return {
    mode: 'demo',
    forced: false,
    tone: 'demo',
    label: 'Demo data',
    detail: 'Sample data. Connect a provider to see your own measurements.',
    canUseLive: false,
  }
}
