import { spawnSync } from 'node:child_process'
import { access, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const OPENCLAW_EXTENSIONS_STRIP_FOR_DESKTOP = ['amazon-bedrock', 'slack'] as const
const OPENCLAW_STAGED_RUNTIME_DEPS_FOR_DESKTOP = ['feishu', 'telegram'] as const

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T
}

function dependencySentinelPath(openclawRoot: string, depName: string): string {
  return join(openclawRoot, 'node_modules', ...depName.split('/'), 'package.json')
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export interface OpenClawBundledPluginRuntimeDependency {
  name: string
  version: string
  pluginIds: string[]
}

export async function stripOpenClawExtensionsWithoutDesktopDeps(openclawRoot: string): Promise<void> {
  const extRoot = join(openclawRoot, 'dist', 'extensions')
  if (!(await fileExists(extRoot))) return

  for (const name of OPENCLAW_EXTENSIONS_STRIP_FOR_DESKTOP) {
    const dir = join(extRoot, name)
    if (!(await fileExists(dir))) continue
    await rm(dir, { recursive: true, force: true })
    console.log(
      `  [strip] dist/extensions/${name}: removed (optional npm deps not in desktop bundle; avoids gateway load warnings)`,
    )
  }
}

export async function discoverOpenClawBundledPluginRuntimeDeps(
  openclawRoot: string,
): Promise<OpenClawBundledPluginRuntimeDependency[]> {
  const extRoot = join(openclawRoot, 'dist', 'extensions')
  if (!(await fileExists(extRoot))) {
    return []
  }

  const deps = new Map<string, OpenClawBundledPluginRuntimeDependency>()
  const entries = await readdir(extRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const pluginId = entry.name
    const packageJsonPath = join(extRoot, pluginId, 'package.json')
    if (!(await fileExists(packageJsonPath))) continue

    try {
      const pkg = await readJson<{
        dependencies?: Record<string, string>
        optionalDependencies?: Record<string, string>
        openclaw?: {
          bundle?: {
            stageRuntimeDependencies?: boolean
          }
        }
      }>(packageJsonPath)
      if (OPENCLAW_EXTENSIONS_STRIP_FOR_DESKTOP.includes(pluginId as (typeof OPENCLAW_EXTENSIONS_STRIP_FOR_DESKTOP)[number])) {
        continue
      }
      if (pkg.openclaw?.bundle?.stageRuntimeDependencies !== true) {
        continue
      }
      if (
        !OPENCLAW_STAGED_RUNTIME_DEPS_FOR_DESKTOP.includes(
          pluginId as (typeof OPENCLAW_STAGED_RUNTIME_DEPS_FOR_DESKTOP)[number],
        )
      ) {
        continue
      }
      const runtimeDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
      }
      for (const [name, version] of Object.entries(runtimeDeps)) {
        if (!version?.trim()) continue
        const existing = deps.get(name)
        if (existing) {
          if (!existing.pluginIds.includes(pluginId)) {
            existing.pluginIds.push(pluginId)
            existing.pluginIds.sort()
          }
          continue
        }
        deps.set(name, { name, version, pluginIds: [pluginId] })
      }
    } catch {
      // Ignore malformed plugin manifests; the gateway will surface them separately.
    }
  }

  return [...deps.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function findMissingOpenClawBundledPluginRuntimeDeps(
  openclawRoot: string,
): Promise<OpenClawBundledPluginRuntimeDependency[]> {
  const runtimeDeps = await discoverOpenClawBundledPluginRuntimeDeps(openclawRoot)
  const missing: OpenClawBundledPluginRuntimeDependency[] = []
  for (const dep of runtimeDeps) {
    if (!(await fileExists(dependencySentinelPath(openclawRoot, dep.name)))) {
      missing.push(dep)
    }
  }
  return missing
}

export async function ensureOpenClawBundledPluginRuntimeDeps(openclawRoot: string): Promise<void> {
  const missing = await findMissingOpenClawBundledPluginRuntimeDeps(openclawRoot)
  if (missing.length === 0) {
    console.log('  [plugin-deps] bundled extension runtime deps already present in bundled OpenClaw')
    return
  }

  const specs = missing.map((dep) => `${dep.name}@${dep.version}`)
  console.log(`  [plugin-deps] npm install ${specs.join(', ')} (cwd=${openclawRoot})...`)

  const result = spawnSync(
    npmCommand(),
    ['install', '--omit=dev', '--no-save', '--package-lock=false', '--no-audit', '--no-fund', ...specs],
    {
      cwd: openclawRoot,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, NODE_ENV: '' },
    },
  )
  if (result.status !== 0) {
    throw new Error(`[plugin-deps] npm install failed for ${specs.join(', ')}`)
  }

  const unresolved = await findMissingOpenClawBundledPluginRuntimeDeps(openclawRoot)
  if (unresolved.length > 0) {
    throw new Error(
      `[plugin-deps] install incomplete: ${unresolved.map((dep) => `${dep.name}@${dep.version}`).join(', ')}`,
    )
  }
  console.log('  [plugin-deps] OK')
}
