import { DEFAULT_GATEWAY_PORT } from '../../shared/constants.js'

const LOOPBACK_GATEWAY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const GATEWAY_REQUEST_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:'])

export interface GatewayRequestAuthContext {
  port?: number
  token?: string
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')
}

function resolveGatewayPort(rawPort: number | undefined): number {
  if (typeof rawPort !== 'number' || !Number.isFinite(rawPort)) {
    return DEFAULT_GATEWAY_PORT
  }
  return rawPort > 0 ? Math.floor(rawPort) : DEFAULT_GATEWAY_PORT
}

export function rewriteGatewayRequestUrlWithToken(rawUrl: string, context: GatewayRequestAuthContext): string | null {
  const token = context.token?.trim()
  if (!token) {
    return null
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (!GATEWAY_REQUEST_PROTOCOLS.has(url.protocol)) {
    return null
  }
  if (!LOOPBACK_GATEWAY_HOSTS.has(normalizeHost(url.hostname))) {
    return null
  }

  const expectedPort = String(resolveGatewayPort(context.port))
  if (url.port !== expectedPort) {
    return null
  }
  if (url.searchParams.has('token')) {
    return null
  }

  url.searchParams.set('token', token)
  return url.toString()
}
