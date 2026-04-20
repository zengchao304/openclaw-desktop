import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENTERPRISE_ENV_PREFIX = 'OPENCLAW_ENTERPRISE_'
const MANIFEST_OVERRIDE_ENV_KEYS = ['OPENCLAW_ENTERPRISE_INSTALL_MANIFEST', 'OPENCLAW_ENTERPRISE_MANIFEST_PATH'] as const
const DEFAULT_MANIFEST_SUBPATH = ['OpenClawEnterpriseShell', 'support', 'install-manifest.json'] as const

type EnterpriseRuntimeReasonCode =
  | 'active'
  | 'not-found'
  | 'manifest-read-failed'
  | 'manifest-parse-failed'
  | 'manifest-invalid'
  | 'asset-missing'
  | 'openclaw-entry-incompatible'

type JsonRecord = Record<string, unknown>

export interface EnterpriseRuntimeLaunchStatus {
  status: 'active' | 'inactive'
  reasonCode: EnterpriseRuntimeReasonCode
  reason: string
  manifestPath: string
  manifestSource: 'override' | 'default'
  supportDir?: string
  decryptLoaderPath?: string
  esmBootstrapPath?: string
  wrapperPath?: string
  openclawEntryPath?: string
  env: Record<string, string>
}

interface EnterpriseRuntimeDiscoveryOptions {
  bundledOpenClawPath: string
}

function toPathSegments(value: readonly string[]): string {
  return path.join(...value)
}

function getDefaultEnterpriseManifestPath(): string {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
  return path.join(localAppData, ...DEFAULT_MANIFEST_SUBPATH)
}

function getManifestPathCandidate(): { manifestPath: string; manifestSource: 'override' | 'default' } {
  for (const key of MANIFEST_OVERRIDE_ENV_KEYS) {
    const candidate = process.env[key]?.trim()
    if (candidate) {
      return {
        manifestPath: candidate,
        manifestSource: 'override',
      }
    }
  }
  return {
    manifestPath: getDefaultEnterpriseManifestPath(),
    manifestSource: 'default',
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isPathAbsoluteLike(rawPath: string): boolean {
  return path.isAbsolute(rawPath) || /^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith('\\\\')
}

function resolveManifestPathValue(manifestPath: string, rawValue: string): string {
  const trimmed = rawValue.trim()
  if (!trimmed) return trimmed
  if (isPathAbsoluteLike(trimmed)) {
    return process.platform === 'win32' ? path.normalize(trimmed) : trimmed
  }
  return path.resolve(path.dirname(manifestPath), trimmed)
}

function walkJson(
  value: unknown,
  visitor: (record: JsonRecord) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      walkJson(entry, visitor)
    }
    return
  }
  if (!isRecord(value)) {
    return
  }
  visitor(value)
  for (const nested of Object.values(value)) {
    walkJson(nested, visitor)
  }
}

function collectEnterpriseEnv(manifest: unknown): Record<string, string> {
  const env: Record<string, string> = {}
  walkJson(manifest, (record) => {
    for (const [key, value] of Object.entries(record)) {
      if (!key.startsWith(ENTERPRISE_ENV_PREFIX)) continue
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed) continue
      env[key] = trimmed
    }
  })
  return env
}

function findFirstStringByKeys(manifest: unknown, candidateKeys: readonly string[]): string | undefined {
  const wanted = new Set(candidateKeys.map(normalizeLookupKey))
  let match: string | undefined
  walkJson(manifest, (record) => {
    if (match) return
    for (const [key, value] of Object.entries(record)) {
      if (!wanted.has(normalizeLookupKey(key))) continue
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (!trimmed) continue
      match = trimmed
      return
    }
  })
  return match
}

function resolvePathCandidate(
  manifest: unknown,
  manifestPath: string,
  env: Record<string, string>,
  candidateKeys: readonly string[],
  envKeys: readonly string[],
): string | undefined {
  const rawFromManifest = findFirstStringByKeys(manifest, candidateKeys)
  if (rawFromManifest) {
    return resolveManifestPathValue(manifestPath, rawFromManifest)
  }
  for (const envKey of envKeys) {
    const rawFromEnv = env[envKey]?.trim()
    if (rawFromEnv) {
      return resolveManifestPathValue(manifestPath, rawFromEnv)
    }
  }
  return undefined
}

function directoryExists(targetPath: string | undefined): boolean {
  if (!targetPath) return false
  try {
    return fs.statSync(targetPath).isDirectory()
  } catch {
    return false
  }
}

function fileExists(targetPath: string | undefined): boolean {
  if (!targetPath) return false
  try {
    return fs.statSync(targetPath).isFile()
  } catch {
    return false
  }
}

function createInactiveStatus(
  params: Omit<EnterpriseRuntimeLaunchStatus, 'status' | 'env'> & { env?: Record<string, string> },
): EnterpriseRuntimeLaunchStatus {
  return {
    status: 'inactive',
    env: params.env ?? {},
    ...params,
  }
}

export function discoverEnterpriseRuntimeLaunch(
  options: EnterpriseRuntimeDiscoveryOptions,
): EnterpriseRuntimeLaunchStatus {
  const { manifestPath, manifestSource } = getManifestPathCandidate()
  if (!fs.existsSync(manifestPath)) {
    return createInactiveStatus({
      reasonCode: 'not-found',
      reason: `enterprise manifest not found at ${manifestPath}`,
      manifestPath,
      manifestSource,
    })
  }

  let manifestRaw: string
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf-8')
  } catch (error) {
    return createInactiveStatus({
      reasonCode: 'manifest-read-failed',
      reason: error instanceof Error ? error.message : String(error),
      manifestPath,
      manifestSource,
    })
  }

  let manifest: unknown
  try {
    manifest = JSON.parse(manifestRaw)
  } catch (error) {
    return createInactiveStatus({
      reasonCode: 'manifest-parse-failed',
      reason: error instanceof Error ? error.message : String(error),
      manifestPath,
      manifestSource,
    })
  }

  if (!isRecord(manifest)) {
    return createInactiveStatus({
      reasonCode: 'manifest-invalid',
      reason: 'enterprise manifest root must be a JSON object',
      manifestPath,
      manifestSource,
    })
  }

  const enterpriseEnv = collectEnterpriseEnv(manifest)
  const supportDir =
    resolvePathCandidate(
      manifest,
      manifestPath,
      enterpriseEnv,
      ['supportDir', 'supportDirectory', 'runtimeSupportDir', 'supportRoot'],
      ['OPENCLAW_ENTERPRISE_SUPPORT_DIR'],
    ) ?? path.dirname(manifestPath)
  const decryptLoaderPath = resolvePathCandidate(
    manifest,
    manifestPath,
    enterpriseEnv,
    ['decryptLoaderPath', 'decryptLoader', 'nodeDecryptLoaderPath', 'runtimeDecryptLoaderPath'],
    ['OPENCLAW_ENTERPRISE_DECRYPT_LOADER', 'OPENCLAW_ENTERPRISE_DECRYPT_LOADER_PATH'],
  )
  const esmBootstrapPath = resolvePathCandidate(
    manifest,
    manifestPath,
    enterpriseEnv,
    [
      'esmBootstrapPath',
      'esmBootstrap',
      'esmHookBootstrapPath',
      'bootstrapPath',
      'openclawEsmRunHookBootstrapPath',
    ],
    [
      'OPENCLAW_ENTERPRISE_ESM_BOOTSTRAP',
      'OPENCLAW_ENTERPRISE_ESM_BOOTSTRAP_PATH',
      'OPENCLAW_ENTERPRISE_ESM_HOOK_BOOTSTRAP',
    ],
  )
  const wrapperPath = resolvePathCandidate(
    manifest,
    manifestPath,
    enterpriseEnv,
    ['wrapperPath', 'runtimeWrapperPath', 'wrapperEntryPath', 'bridgeWrapperPath', 'payloadWrapperPath'],
    ['OPENCLAW_ENTERPRISE_WRAPPER_PATH'],
  )
  const manifestOpenClawEntry = resolvePathCandidate(
    manifest,
    manifestPath,
    enterpriseEnv,
    ['openclawEntryPath', 'openclawPath', 'entryPath', 'runtimeEntryPath'],
    ['OPENCLAW_ENTERPRISE_OPENCLAW_ENTRY'],
  )

  const missingAssets: string[] = []
  if (!directoryExists(supportDir)) {
    missingAssets.push(`supportDir=${supportDir}`)
  }
  if (!fileExists(decryptLoaderPath)) {
    missingAssets.push(`decryptLoader=${decryptLoaderPath ?? '<missing>'}`)
  }
  if (!fileExists(esmBootstrapPath)) {
    missingAssets.push(`esmBootstrap=${esmBootstrapPath ?? '<missing>'}`)
  }
  if (!fileExists(wrapperPath)) {
    missingAssets.push(`wrapper=${wrapperPath ?? '<missing>'}`)
  }
  if (missingAssets.length > 0) {
    return createInactiveStatus({
      reasonCode: 'asset-missing',
      reason: `enterprise runtime assets missing or invalid: ${missingAssets.join(', ')}`,
      manifestPath,
      manifestSource,
      supportDir,
      decryptLoaderPath,
      esmBootstrapPath,
      wrapperPath,
      openclawEntryPath: manifestOpenClawEntry,
      env: enterpriseEnv,
    })
  }

  if (manifestOpenClawEntry) {
    const expectedBase = path.basename(manifestOpenClawEntry).toLowerCase()
    const bundledBase = path.basename(options.bundledOpenClawPath).toLowerCase()
    if (expectedBase !== bundledBase) {
      return createInactiveStatus({
        reasonCode: 'openclaw-entry-incompatible',
        reason: `enterprise manifest expects ${manifestOpenClawEntry}, bundled entry is ${options.bundledOpenClawPath}`,
        manifestPath,
        manifestSource,
        supportDir,
        decryptLoaderPath,
        esmBootstrapPath,
        wrapperPath,
        openclawEntryPath: manifestOpenClawEntry,
        env: enterpriseEnv,
      })
    }
  }

  return {
    status: 'active',
    reasonCode: 'active',
    reason: `enterprise runtime manifest valid at ${manifestPath}`,
    manifestPath,
    manifestSource,
    supportDir,
    decryptLoaderPath,
    esmBootstrapPath,
    wrapperPath,
    openclawEntryPath: options.bundledOpenClawPath,
    env: {
      ...enterpriseEnv,
      OPENCLAW_ENTERPRISE_SUPPORT_DIR: supportDir,
      OPENCLAW_ENTERPRISE_WRAPPER_PATH: wrapperPath as string,
      OPENCLAW_ENTERPRISE_OPENCLAW_ENTRY: options.bundledOpenClawPath,
      OPENCLAW_ENTERPRISE_INSTALL_MANIFEST: manifestPath,
    },
  }
}

export function formatEnterpriseRuntimeStatus(status: EnterpriseRuntimeLaunchStatus): string {
  const base = `[gateway][enterprise] status=${status.status} reason=${status.reasonCode} manifest=${status.manifestPath}`
  if (status.status !== 'active') {
    return `${base} detail=${status.reason}`
  }
  const envKeys = Object.keys(status.env)
    .filter((key) => key.startsWith(ENTERPRISE_ENV_PREFIX))
    .sort()
  return `${base} loader=${status.decryptLoaderPath} bootstrap=${status.esmBootstrapPath} wrapper=${status.wrapperPath} support=${status.supportDir} envKeys=${envKeys.join(',') || '<none>'}`
}

export function getDefaultEnterpriseRuntimeManifestPathForSupport(): string {
  return getDefaultEnterpriseManifestPath()
}

export function getEnterpriseRuntimeManifestSubpath(): string {
  return toPathSegments(DEFAULT_MANIFEST_SUBPATH)
}
