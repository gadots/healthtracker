import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.mjs'
import { parseCookies, unseal, SESSION_COOKIE } from './session.mjs'
import { sendJson } from './http.mjs'
import { registerAuthRoutes } from './routes/auth.mjs'
import { registerSyncRoutes } from './routes/sync.mjs'
import { mockProvider } from './mock-provider.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(here, '..', process.env.STATIC_DIR || 'dist-web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

// Stricter than the desktop CSP (electron/main.cjs): the browser never talks to
// Google directly, so `connect-src` is limited to this origin.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

function securityHeaders(secure) {
  const headers = {
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
  }
  if (secure) headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  return headers
}

async function serveStatic(url, response, baseHeaders) {
  const requested = decodeURIComponent(url.pathname)
  // Resolve, then confirm the result is still inside dist/ — this is what stops
  // `../` traversal, not the string check.
  const candidate = path.resolve(DIST, `.${requested}`)
  const withinDist = candidate === DIST || candidate.startsWith(DIST + path.sep)

  let target = withinDist ? candidate : DIST
  let stats = await fsp.stat(target).catch(() => null)

  // Unknown paths fall back to index.html so the SPA can route them.
  if (!stats || stats.isDirectory()) {
    target = path.join(DIST, 'index.html')
    stats = await fsp.stat(target).catch(() => null)
  }
  if (!stats) {
    response.writeHead(404, { ...baseHeaders, 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }

  const extension = path.extname(target)
  const immutable = target.includes(`${path.sep}assets${path.sep}`)
  response.writeHead(200, {
    ...baseHeaders,
    'content-type': MIME[extension] || 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  fs.createReadStream(target).pipe(response)
}

export async function createServer(config, provider) {
  const cookies = (request) => parseCookies(request.headers.cookie)
  const session = (request) => unseal(config.sessionKey, cookies(request)[SESSION_COOKIE])

  const routes = {
    ...registerAuthRoutes({ config, provider, cookies, session }),
    ...registerSyncRoutes({ config, provider, session }),
  }

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
    const secure = request.socket?.encrypted
      || (config.trustProxy && String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https')
    const baseHeaders = securityHeaders(secure)

    try {
      const handler = routes[`${request.method} ${url.pathname}`]
      if (handler) {
        response.setHeader('content-security-policy', CSP)
        response.setHeader('x-content-type-options', 'nosniff')
        await handler(request, response, url)
        return
      }
      if (url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { message: 'Unknown endpoint.' }, baseHeaders)
        return
      }
      await serveStatic(url, response, baseHeaders)
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { message: 'Unexpected server error.' }, baseHeaders)
      else response.end()
      console.error('[openfit]', error?.message || error)
    }
  })
}

async function main() {
  const config = loadConfig()
  // The desktop adapter needs only `node:crypto` and global fetch, so it runs
  // unchanged here.
  const provider = config.mockHealth
    ? mockProvider
    : (await import('../electron/google-health-service.cjs')).default

  const server = await createServer(config, provider)
  server.listen(config.port, config.host, () => {
    console.log(`[openfit] listening on http://${config.host}:${config.port}${config.mockHealth ? ' (MOCK_HEALTH)' : ''}`)
    console.log(`[openfit] oauth callback ${config.oauth.redirectUri}`)
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[openfit] ${error.message}`)
    process.exit(1)
  })
}
