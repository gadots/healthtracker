/** Small helpers over `node:http` so the route modules stay readable. */

export function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  response.end(payload)
}

export function redirect(response, location, extraHeaders = {}) {
  response.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders })
  response.end()
}

export async function readJsonBody(request, limitBytes = 16_384) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) throw new Error('Request body too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('Invalid JSON body.')
  }
}

/** True when the original client request arrived over TLS. */
export function isSecureRequest(request, trustProxy) {
  if (request.socket?.encrypted) return true
  if (!trustProxy) return false
  const forwarded = request.headers['x-forwarded-proto']
  return String(forwarded || '').split(',')[0].trim() === 'https'
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function validSyncDate(value, today) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) return false
  return value <= today
}

export function localIsoDate(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}
