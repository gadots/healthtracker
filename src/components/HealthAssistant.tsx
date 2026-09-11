import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantRuntime,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from '@assistant-ui/react'
import { ArrowDown, ArrowLeftRight, ArrowUp, Plus, Sparkles, Square, TriangleAlert, X } from 'lucide-react'
import { normalizeFitbitData } from '@/data/normalize'
import {
  buildHealthAssistantContext,
  parseAssistantNavigation,
  stripAssistantNavigation,
  visibleAssistantText,
  type AssistantNavigation,
} from '@/lib/health-assistant'
import { relativeTime } from '@/lib/format'
import { fitbitBridge } from '@/lib/bridge'
import type {
  AssistantProviderDescriptor,
  AssistantProviderId,
  AssistantProviderStatus,
  DashboardData,
  HealthAssistantEvent,
  HealthAssistantStatus,
  PageId,
  RawHealthArchive,
} from '@/types'

const unavailableStatus: HealthAssistantStatus = {
  activeProvider: 'claude',
  providers: {},
  lastFallback: null,
}

const unavailableProviderStatus: AssistantProviderStatus = {
  provider: 'claude',
  state: 'idle',
  available: false,
  connected: false,
  authenticated: false,
  busy: false,
  threadId: null,
  turnId: null,
  lastError: null,
  version: null,
}

const DEFAULT_PROVIDERS: AssistantProviderDescriptor[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
]

const SIGN_IN_HINT: Record<AssistantProviderId, string> = {
  claude: 'Run `claude login` (or `claude setup-token`) in a terminal.',
  codex: 'Open Codex Desktop and sign in.',
}

interface LastResponseMeta {
  provider: AssistantProviderId
  fallbackFrom: AssistantProviderId | null
  cacheHit: boolean
  turnsUsed: number | null
  costUsd: number | null
  at: string
}

function messageText(message: ThreadMessage | undefined) {
  if (!message) return ''
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function archiveData(archive: RawHealthArchive | null | undefined) {
  if (!archive) return []
  return Object.values(archive.days)
    .map((payload) => normalizeFitbitData(payload))
    .sort((left, right) => left.selectedDate.localeCompare(right.selectedDate))
}

function activeProviderStatus(status: HealthAssistantStatus): AssistantProviderStatus {
  return status.providers[status.activeProvider] ?? { ...unavailableProviderStatus, provider: status.activeProvider }
}

function providerLabel(id: AssistantProviderId, providers: AssistantProviderDescriptor[]) {
  return providers.find((entry) => entry.id === id)?.label ?? id
}

function statusLabel(status: HealthAssistantStatus, providers: AssistantProviderDescriptor[], hasBridge: boolean) {
  if (!hasBridge) return 'Desktop only'
  const current = activeProviderStatus(status)
  const label = providerLabel(status.activeProvider, providers)
  if (current.available === false) return `${label} not found`
  if (!current.authenticated) return `Sign in to ${label}`
  return current.connected ? `${label} connected` : `${label} ready`
}

function createQueue() {
  const events: HealthAssistantEvent[] = []
  let wake: ((event: HealthAssistantEvent) => void) | null = null

  return {
    push(event: HealthAssistantEvent) {
      if (wake) {
        const resolve = wake
        wake = null
        resolve(event)
      } else {
        events.push(event)
      }
    },
    next() {
      const event = events.shift()
      if (event) return Promise.resolve(event)
      return new Promise<HealthAssistantEvent>((resolve) => { wake = resolve })
    },
  }
}

export function HealthAssistant({
  open,
  data,
  page,
  onOpenChange,
  onNavigate,
}: {
  open: boolean
  data: DashboardData
  page: PageId
  onOpenChange: (open: boolean) => void
  onNavigate: (navigation: AssistantNavigation) => void
}) {
  const dataRef = useRef(data)
  const pageRef = useRef(page)
  const navigateRef = useRef(onNavigate)
  const [status, setStatus] = useState(unavailableStatus)
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const [lastResponse, setLastResponse] = useState<LastResponseMeta | null>(null)
  const activeProviderRef = useRef(status.activeProvider)

  useEffect(() => { dataRef.current = data }, [data])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { navigateRef.current = onNavigate }, [onNavigate])
  useEffect(() => { activeProviderRef.current = status.activeProvider }, [status.activeProvider])

  const refreshStatus = useCallback(async () => {
    if (!window.healthAssistant) {
      setStatus(unavailableStatus)
      return
    }
    try {
      setStatus(await window.healthAssistant.getStatus())
    } catch {
      setStatus(unavailableStatus)
    }
  }, [])

  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => {
    if (open) void refreshStatus()
  }, [open, refreshStatus])
  useEffect(() => {
    if (!window.healthAssistant) return
    window.healthAssistant.getProviders()
      .then((list) => { if (list?.length) setProviders(list) })
      .catch(() => undefined)
  }, [])

  const switchProvider = useCallback(async (id: AssistantProviderId) => {
    if (!window.healthAssistant || id === activeProviderRef.current || switchingProvider) return
    setSwitchingProvider(true)
    try {
      setStatus(await window.healthAssistant.setProvider(id))
      setLastResponse(null)
    } catch {
      await refreshStatus()
    } finally {
      setSwitchingProvider(false)
    }
  }, [refreshStatus, switchingProvider])

  const modelAdapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const bridge = window.healthAssistant
      if (!bridge) throw new Error('Launch OpenFit in the desktop app to use the health assistant.')

      const prompt = messageText(messages.at(-1))
      if (!prompt) throw new Error('Write a question before sending it.')

      let archived: DashboardData[] = []
      if (fitbitBridge && dataRef.current.source !== 'demo') {
        try {
          archived = archiveData(await fitbitBridge.getCachedArchive())
        } catch {
          archived = []
        }
      }

      const healthContext = buildHealthAssistantContext(dataRef.current, archived, pageRef.current)
      const requestId = crypto.randomUUID()
      const queue = createQueue()
      let fullText = ''
      let lastVisibleText = ''
      let completed = false

      const unsubscribe = bridge.onEvent((event) => {
        if (event.requestId === requestId) queue.push(event)
      })
      const onAbort = () => queue.push({ requestId, type: 'cancelled' })
      abortSignal.addEventListener('abort', onAbort, { once: true })

      try {
        await bridge.startTurn({ requestId, message: prompt, healthContext })
        void refreshStatus()

        while (!completed) {
          const event = await queue.next()
          if (event.type === 'delta') {
            fullText += event.delta
            const visible = visibleAssistantText(fullText)
            if (visible && visible !== lastVisibleText) {
              lastVisibleText = visible
              yield { content: [{ type: 'text', text: visible }] }
            }
          } else if (event.type === 'complete') {
            completed = true
            if (event.text) fullText = event.text
            setLastResponse({
              provider: event.provider ?? activeProviderRef.current,
              fallbackFrom: event.fallbackFrom ?? null,
              cacheHit: Boolean(event.cacheHit),
              turnsUsed: event.meta?.turnsUsed ?? null,
              costUsd: event.meta?.costUsd ?? null,
              at: new Date().toISOString(),
            })
          } else if (event.type === 'error') {
            throw new Error(event.message)
          } else {
            return
          }
        }

        const navigation = parseAssistantNavigation(fullText)
        const finalText = stripAssistantNavigation(fullText)
        if (navigation) navigateRef.current(navigation)
        if (!finalText) throw new Error('The assistant completed the turn without a response.')
        if (finalText !== lastVisibleText) {
          yield { content: [{ type: 'text', text: finalText }] }
        }
      } finally {
        abortSignal.removeEventListener('abort', onAbort)
        unsubscribe()
        if (!completed || abortSignal.aborted) void bridge.cancel(requestId)
        void refreshStatus()
      }
    },
  }), [refreshStatus])

  const runtime = useLocalRuntime(modelAdapter)
  const currentProviderStatus = activeProviderStatus(status)
  const ready = Boolean(window.healthAssistant && currentProviderStatus.available && currentProviderStatus.authenticated)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside
        id="health-assistant"
        className={`health-assistant ${open ? 'is-open' : ''}`}
        aria-label="Health assistant"
        aria-hidden={!open}
        inert={!open}
      >
        <AssistantHeader
          status={status}
          providers={providers}
          switchingProvider={switchingProvider}
          ready={ready}
          onClose={() => onOpenChange(false)}
          onStatusRefresh={refreshStatus}
          onSwitchProvider={switchProvider}
        />
        <AssistantThread ready={ready} activeProvider={status.activeProvider} lastResponse={lastResponse} providers={providers} />
      </aside>
      {open && <button className="assistant-scrim" aria-label="Close health assistant" onClick={() => onOpenChange(false)} />}
    </AssistantRuntimeProvider>
  )
}

function AssistantHeader({
  status,
  providers,
  switchingProvider,
  ready,
  onClose,
  onStatusRefresh,
  onSwitchProvider,
}: {
  status: HealthAssistantStatus
  providers: AssistantProviderDescriptor[]
  switchingProvider: boolean
  ready: boolean
  onClose: () => void
  onStatusRefresh: () => Promise<void>
  onSwitchProvider: (id: AssistantProviderId) => Promise<void>
}) {
  const runtime = useAssistantRuntime()

  const newConversation = async () => {
    runtime.thread.cancelRun()
    runtime.thread.reset()
    await window.healthAssistant?.reset()
    await onStatusRefresh()
  }

  return (
    <header className="assistant-header">
      <div className="assistant-title">
        <span className="assistant-mark"><Sparkles aria-hidden="true" /></span>
        <span>
          <strong>Health assistant</strong>
          <small><i className={ready ? 'is-ready' : ''} />{statusLabel(status, providers, Boolean(window.healthAssistant))}</small>
        </span>
      </div>
      <div className="assistant-header-actions">
        <button type="button" aria-label="New conversation" title="New conversation" onClick={() => void newConversation()}>
          <Plus aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close assistant" title="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
      {providers.length > 1 && (
        <div className="assistant-provider-switch" role="radiogroup" aria-label="Assistant provider">
          {providers.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="radio"
              aria-checked={status.activeProvider === entry.id}
              className={status.activeProvider === entry.id ? 'is-active' : ''}
              disabled={switchingProvider}
              onClick={() => void onSwitchProvider(entry.id)}
            >
              {entry.label}
            </button>
          ))}
          {switchingProvider && <ArrowLeftRight className="assistant-provider-switch-spin" aria-hidden="true" />}
        </div>
      )}
    </header>
  )
}

function responseMetaLabel(lastResponse: LastResponseMeta | null, providers: AssistantProviderDescriptor[]) {
  if (!lastResponse) return null
  const parts = [providerLabel(lastResponse.provider, providers)]
  if (lastResponse.cacheHit) parts.push('cached answer')
  if (lastResponse.turnsUsed !== null) parts.push(`${lastResponse.turnsUsed} turn${lastResponse.turnsUsed === 1 ? '' : 's'}`)
  if (lastResponse.costUsd !== null) parts.push(`$${lastResponse.costUsd.toFixed(4)}`)
  parts.push(relativeTime(lastResponse.at))
  return parts.join(' · ')
}

function AssistantThread({
  ready,
  activeProvider,
  lastResponse,
  providers,
}: {
  ready: boolean
  activeProvider: AssistantProviderId
  lastResponse: LastResponseMeta | null
  providers: AssistantProviderDescriptor[]
}) {
  const fallbackNotice = lastResponse?.fallbackFrom
    ? `${providerLabel(lastResponse.fallbackFrom, providers)} wasn't available — this answer came from ${providerLabel(lastResponse.provider, providers)}.`
    : null
  const meta = responseMetaLabel(lastResponse, providers)
  return (
    <ThreadPrimitive.Root className="assistant-thread">
      <ThreadPrimitive.Viewport className="assistant-viewport">
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <div className="assistant-welcome">
            <h2>Ask your health data.</h2>
            <p>I can compare days, explain trends, and take you to the relevant view.</p>
            <div className="assistant-suggestions" aria-label="Suggested questions">
              <ThreadPrimitive.Suggestion prompt="How did I sleep last night?" send disabled={!ready}>How did I sleep?</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Compare my activity over the last seven days." send disabled={!ready}>Compare this week</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Show me my heart health data." send disabled={!ready}>Open heart data</ThreadPrimitive.Suggestion>
            </div>
          </div>
        </AuiIf>

        <div className="assistant-messages">
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
          </ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="assistant-viewport-footer">
          <ThreadPrimitive.ScrollToBottom className="assistant-scroll-bottom" aria-label="Scroll to latest response">
            <ArrowDown aria-hidden="true" />
          </ThreadPrimitive.ScrollToBottom>
          {fallbackNotice && (
            <p className="assistant-fallback-notice" role="status">
              <TriangleAlert aria-hidden="true" />{fallbackNotice}
            </p>
          )}
          <ComposerPrimitive.Root className="assistant-composer">
            <ComposerPrimitive.Input
              className="assistant-composer-input"
              rows={1}
              disabled={!ready}
              placeholder={ready ? 'Ask about your health…' : SIGN_IN_HINT[activeProvider]}
              aria-label="Message health assistant"
            />
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send className="assistant-send" disabled={!ready} aria-label="Send message">
                <ArrowUp aria-hidden="true" />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel className="assistant-send is-cancel" aria-label="Stop response">
                <Square aria-hidden="true" />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </ComposerPrimitive.Root>
          <p className="assistant-disclaimer">{meta ? `${meta} · Health context, not medical advice.` : 'Health context, not medical advice.'}</p>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="assistant-user-message">
      <div><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="assistant-ai-message">
      <span className="assistant-response-mark" aria-hidden="true">+</span>
      <div><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  )
}
