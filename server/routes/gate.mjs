import { buildCookie, SESSION_COOKIE } from '../session.mjs'
import { isSecureRequest, redirect } from '../http.mjs'
import {
  GATE_COOKIE,
  clientAddress,
  isUnlocked,
  loginPage,
  passphraseMatches,
  safeNextPath,
  sealGate,
} from '../gate.mjs'

const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30

function sendHtml(response, status, html, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(html)
}

async function readForm(request, limitBytes = 4_096) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('Request body too large.')
    chunks.push(chunk)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export function registerGateRoutes({ config, cookies, limiter }) {
  return {
    'GET /login': (request, response, url) => {
      if (isUnlocked(config, cookies(request)[GATE_COOKIE])) {
        redirect(response, safeNextPath(url.searchParams.get('next')))
        return
      }
      const retryAfterMs = limiter.retryAfterMs(clientAddress(request, config.trustProxy))
      sendHtml(response, 200, loginPage({
        nextPath: safeNextPath(url.searchParams.get('next')),
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      }))
    },

    'POST /login': async (request, response) => {
      const secure = isSecureRequest(request, config.trustProxy)
      const address = clientAddress(request, config.trustProxy)

      const retryAfterMs = limiter.retryAfterMs(address)
      if (retryAfterMs > 0) {
        const seconds = Math.ceil(retryAfterMs / 1000)
        sendHtml(response, 429, loginPage({ retryAfterSeconds: seconds }), { 'retry-after': String(seconds) })
        return
      }

      let form
      try {
        form = await readForm(request)
      } catch {
        sendHtml(response, 400, loginPage({ error: 'That request could not be read. Try again.' }))
        return
      }

      const nextPath = safeNextPath(form.get('next'))

      if (!passphraseMatches(config.passphrase, form.get('passphrase') || '')) {
        limiter.recordFailure(address)
        // Never log the submitted value.
        console.warn(`[openfit] failed unlock attempt from ${address}`)
        sendHtml(response, 401, loginPage({ error: 'That passphrase is not correct.', nextPath }))
        return
      }

      limiter.recordSuccess(address)
      const ttl = form.get('remember') === '1' ? REMEMBER_TTL_SECONDS : config.gateTtlSeconds
      redirect(response, nextPath, {
        'set-cookie': buildCookie(GATE_COOKIE, sealGate(config, ttl), { maxAge: ttl, secure }),
      })
    },

    // Leaving the device drops the Google session too, not just the gate.
    'POST /logout': (request, response) => {
      const secure = isSecureRequest(request, config.trustProxy)
      redirect(response, '/login', {
        'set-cookie': [
          buildCookie(GATE_COOKIE, '', { maxAge: 0, secure }),
          buildCookie(SESSION_COOKIE, '', { maxAge: 0, secure }),
        ],
      })
    },
  }
}
