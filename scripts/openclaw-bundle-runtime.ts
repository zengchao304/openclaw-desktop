import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, readFile, readdir, rm } from 'node:fs/promises'
import path, { join } from 'node:path'

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

function createNestedNpmInstallEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env }
  delete nextEnv.npm_config_global
  delete nextEnv.npm_config_location
  delete nextEnv.npm_config_prefix
  return nextEnv
}

function escapeForCmdExe(arg: string): string {
  if (/[&|<>%\r\n]/.test(arg)) {
    throw new Error(`unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`)
  }
  const escaped = arg.replace(/\^/g, '^^')
  if (!escaped.includes(' ') && !escaped.includes('"')) {
    return escaped
  }
  return `"${escaped.replace(/"/g, '""')}"`
}

function buildCmdExeCommandLine(command: string, args: string[]): string {
  return [escapeForCmdExe(command), ...args.map(escapeForCmdExe)].join(' ')
}

function resolveNpmRunner(npmArgs: string[], env: NodeJS.ProcessEnv) {
  if (process.platform !== 'win32') {
    return {
      command: 'npm',
      args: npmArgs,
      shell: false,
      windowsVerbatimArguments: false,
    } as const
  }

  const pathImpl = path.win32
  const nodeDir = pathImpl.dirname(process.execPath)
  const comSpec = env.ComSpec ?? 'cmd.exe'
  const npmCliCandidates = [
    pathImpl.resolve(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'),
    pathImpl.resolve(nodeDir, 'node_modules/npm/bin/npm-cli.js'),
  ]
  const npmCliPath = npmCliCandidates.find((candidate) => existsSync(candidate))
  if (npmCliPath) {
    return {
      command: process.execPath,
      args: [npmCliPath, ...npmArgs],
      shell: false,
      windowsVerbatimArguments: false,
    } as const
  }

  const npmExePath = pathImpl.resolve(nodeDir, 'npm.exe')
  if (existsSync(npmExePath)) {
    return {
      command: npmExePath,
      args: npmArgs,
      shell: false,
      windowsVerbatimArguments: false,
    } as const
  }

  const npmCmdPath = existsSync(pathImpl.resolve(nodeDir, 'npm.cmd'))
    ? pathImpl.resolve(nodeDir, 'npm.cmd')
    : 'npm.cmd'

  return {
    command: comSpec,
    args: ['/d', '/s', '/c', buildCmdExeCommandLine(npmCmdPath, npmArgs)],
    shell: false,
    windowsVerbatimArguments: true,
  } as const
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
  const npmArgs = [
    'install',
    '--omit=dev',
    '--no-save',
    '--package-lock=false',
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    ...specs,
  ]
  const nestedEnv = createNestedNpmInstallEnv({ ...process.env, NODE_ENV: '' })
  const npmRunner = resolveNpmRunner(npmArgs, nestedEnv)
  console.log(`  [plugin-deps] npm install ${specs.join(', ')} (cwd=${openclawRoot})...`)

  const result = spawnSync(npmRunner.command, npmRunner.args, {
    cwd: openclawRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    shell: npmRunner.shell,
    windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    env: nestedEnv,
  })
  if (result.status !== 0 || result.error) {
    const details = [
      result.error?.message,
      result.stderr?.trim(),
      result.stdout?.trim(),
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `[plugin-deps] npm install failed for ${specs.join(', ')}${details ? `\n${details}` : ''}`,
    )
  }

  const unresolved = await findMissingOpenClawBundledPluginRuntimeDeps(openclawRoot)
  if (unresolved.length > 0) {
    throw new Error(
      `[plugin-deps] install incomplete: ${unresolved.map((dep) => `${dep.name}@${dep.version}`).join(', ')}`,
    )
  }
  console.log('  [plugin-deps] OK')
}
