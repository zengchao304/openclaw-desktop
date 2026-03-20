export const LOOPBACK_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export const RELAXED_GATEWAY_FRAME_ANCESTORS =
  "frame-ancestors 'self' file: http://localhost:* http://127.0.0.1:* http://[::1]:* https://localhost:* https://127.0.0.1:* https://[::1]:*"

export type GatewayResponseHeadersInput = Record<string, string[] | string | undefined>
export type GatewayResponseHeaders = Record<string, string[]>

export function isLoopbackGatewayResponseUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }
    const normalizedHost = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
    return LOOPBACK_GATEWAY_HOSTS.has(normalizedHost)
  } catch {
    return false
  }
}

export function relaxGatewayFrameAncestors(csp: string): string {
  if (/frame-ancestors\s+[^;]+/i.test(csp)) {
    return csp.replace(/frame-ancestors\s+[^;]+/i, RELAXED_GATEWAY_FRAME_ANCESTORS)
  }

  const trimmed = csp.trim()
  if (!trimmed) {
    return RELAXED_GATEWAY_FRAME_ANCESTORS
  }

  return `${trimmed}${trimmed.endsWith(';') ? '' : ';'} ${RELAXED_GATEWAY_FRAME_ANCESTORS}`
}

export function patchGatewayResponseHeaders(
  rawUrl: string,
  responseHeaders: GatewayResponseHeadersInput | undefined,
): GatewayResponseHeaders | null {
  if (!isLoopbackGatewayResponseUrl(rawUrl)) {
    return null
  }

  const headers: GatewayResponseHeaders = {}
  for (const [key, value] of Object.entries(responseHeaders ?? {})) {
    if (Array.isArray(value)) {
      headers[key] = value.map((item) => String(item))
    } else if (value !== undefined) {
      headers[key] = [String(value)]
    }
  }
  const headerKeys = Object.keys(headers)

  for (const key of headerKeys) {
    if (key.toLowerCase() === 'x-frame-options') {
      delete headers[key]
    }
  }

  const cspKey = headerKeys.find((key) => key.toLowerCase() === 'content-security-policy')
  if (cspKey) {
    const cspRaw = headers[cspKey]
    if (Array.isArray(cspRaw)) {
      headers[cspKey] = cspRaw.map((v) => relaxGatewayFrameAncestors(String(v)))
    } else if (cspRaw) {
      headers[cspKey] = [relaxGatewayFrameAncestors(String(cspRaw))]
    } else {
      headers[cspKey] = [RELAXED_GATEWAY_FRAME_ANCESTORS]
    }
  } else {
    headers['Content-Security-Policy'] = [RELAXED_GATEWAY_FRAME_ANCESTORS]
  }

  return headers
}
