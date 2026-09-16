import type { DashboardData, PageId } from '@/types'
import type { AssistantNavigation } from '@/lib/health-assistant'

/**
 * Web build stand-in for `HealthAssistant`.
 *
 * The real assistant drives the local `claude` / `codex` CLI binaries through
 * `child_process.spawn` in the Electron main process, which a browser cannot do.
 * `vite.config.ts` aliases the assistant module to this stub in `--mode web` so
 * `@assistant-ui/react` never enters the bundle.
 */
export function HealthAssistant(_props: {
  open: boolean
  data: DashboardData
  page: PageId
  archiveDays: DashboardData[]
  onOpenChange: (open: boolean) => void
  onNavigate: (navigation: AssistantNavigation) => void
}) {
  return null
}
