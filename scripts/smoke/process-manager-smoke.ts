import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GatewayProcessManager, createGatewayLaunchSpec } from '../../src/main/gateway/process-manager.ts'

const TEST_ENTERPRISE_ENV_KEY = 'OPENCLAW_ENTERPRISE_TEST_CASE'

type ManagerInternals = GatewayProcessManager & {
  child: ChildProcessWithoutNullStreams | null
  statusValue: 'stopped' | 'starting' | 'running' | 'error'
  stopping: boolean
  restarting: boolean
  currentPort: number
  consecutiveHealthCheckFailures: number
  checkGatewayHealth: (port: number) => Promise<{ ok: boolean; statusCode?: number; details?: string }>
  checkGatewayTcpPortOpen: (port: number) => Promise<{ ok: boolean; statusCode?: number; details?: string }>
  checkGatewayControlUiHttpOk: (
    port: number,
    token?: string,
  ) => Promise<{ ok: boolean; statusCode?: number; details?: string }>
  runHealthCheck: () => Promise<void>
  waitForGatewayReady: () => Promise<void>
  terminateChildProcess: (child: ChildProcessWithoutNullStreams, timeoutMs: number) => Promise<void>
  tryAutoRestart: (reason: 'process-exit' | 'health-check') => Promise<void>
  stopInternal: (timeoutMs?: number) => Promise<ReturnType<GatewayProcessManager['getStatus']>>
  startInternal: (options?: unknown) => Promise<ReturnType<GatewayProcessManager['getStatus']>>
}

function createFakeRunningChild(pid = 42424): ChildProcessWithoutNullStreams {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const child = {
    pid,
    killed: true,
    exitCode: null,
    signalCode: null,
    once(event: string, listener: (...args: unknown[]) => void) {
      const queue = listeners.get(event) ?? []
      queue.push(listener)
      listeners.set(event, queue)
      return this
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      const queue = listeners.get(event) ?? []
      listeners.set(
        event,
        queue.filter((entry) => entry !== listener),
      )
      return this
    },
    kill() {
      return true
    },
  } as unknown as ChildProcessWithoutNullStreams
  return child
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function forceKillProcessTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // no-op
  }
}

async function readFirstStdoutLine(
  child: ChildProcessWithoutNullStreams,
  options: { timeoutMs?: number; stderr?: NodeJS.ReadableStream | null } = {},
): Promise<string> {
  if (!child.stdout) {
    throw new Error('Parent stdout unavailable')
  }

  const timeoutMs = options.timeoutMs ?? 5000
  const stderrChunks: string[] = []
  if (options.stderr) {
    options.stderr.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(String(chunk))
    })
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    let stdoutBuffer = ''
    const finish = (result: { ok: true; line: string } | { ok: false; error: Error }) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onStdoutData)
      child.off('exit', onExit)
      if (result.ok) {
        resolve(result.line)
      } else {
        reject(result.error)
      }
    }

    const onStdoutData = (chunk: Buffer | string) => {
      stdoutBuffer += String(chunk)
      const newlineIndex = stdoutBuffer.indexOf('\n')
      if (newlineIndex < 0) {
        return
      }
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      finish({ ok: true, line })
    }

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = stderrChunks.join('').trim()
      finish({
        ok: false,
        error: new Error(
          `Parent exited before emitting pid (code=${String(code)}, signal=${String(signal)}, stderr=${stderr || 'none'})`,
        ),
      })
    }

    child.stdout?.on('data', onStdoutData)
    child.once('exit', onExit)

    const timer = setTimeout(() => {
      const stderr = stderrChunks.join('').trim()
      finish({
        ok: false,
        error: new Error(`Timed out waiting for child pid line (stderr=${stderr || 'none'})`),
      })
    }, timeoutMs)
  })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async function testStartTreatsKilledFlagAsNonAuthoritative(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  manager.child = createFakeRunningChild(31001)
  manager.statusValue = 'stopped'

  const status = await manager.start()

  assert.equal(status.running, true, 'expected running=true when exitCode/signalCode are null')
  assert.equal(status.status, 'running', 'expected status to recover from stopped -> running')
}

async function testStartRecoversFromErrorWhenProcessStillRunning(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  manager.child = createFakeRunningChild(31004)
  manager.statusValue = 'error'
  manager.stopping = false

  const status = await manager.start()

  assert.equal(status.running, true, 'expected running=true when process is still alive')
  assert.equal(status.status, 'running', 'expected start() to recover from stale error state')
}

async function testWaitForReadyUsesRealProcessState(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  manager.child = createFakeRunningChild(31002)
  manager.statusValue = 'starting'
  manager.currentPort = 17777

  let tcpCalls = 0
  let httpCalls = 0
  manager.checkGatewayTcpPortOpen = async () => {
    tcpCalls += 1
    return { ok: true }
  }
  manager.checkGatewayControlUiHttpOk = async () => {
    httpCalls += 1
    return { ok: true, statusCode: 200 }
  }

  await manager.waitForGatewayReady()

  assert.equal(tcpCalls, 1, 'expected waitForGatewayReady to probe TCP once')
  assert.equal(httpCalls, 1, 'expected waitForGatewayReady to probe Control UI HTTP once')
  assert.equal(manager.statusValue, 'running', 'expected status to switch to running when health is ok')
}

async function testHealthCheckUsesRealProcessState(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  manager.child = createFakeRunningChild(31003)
  manager.statusValue = 'running'
  manager.stopping = false
  manager.restarting = false

  let healthCalls = 0
  manager.checkGatewayHealth = async () => {
    healthCalls += 1
    return { ok: true, statusCode: 200 }
  }

  await manager.runHealthCheck()

  assert.equal(healthCalls, 1, 'expected runHealthCheck to execute for running child even when child.killed=true')
}

async function testStopKillsStubbornWindowsProcessTree(): Promise<void> {
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (!child.pid) {
      console.error('failed to spawn child');
      process.exit(2);
    }
    process.stdout.write(String(child.pid) + '\\n');
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
  `
    .trim()
    .replace(/\r?\n\s+/g, '\n')

  const parent = spawn('node', ['-e', parentScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let childPid: number | null = null
  try {
    const childPidRaw = await readFirstStdoutLine(parent, {
      stderr: parent.stderr,
    })
    childPid = Number.parseInt(childPidRaw, 10)
    assert.equal(Number.isFinite(childPid), true, `invalid child pid output: "${childPidRaw}"`)

    const manager = new GatewayProcessManager() as ManagerInternals
    manager.child = parent as unknown as ChildProcessWithoutNullStreams
    manager.statusValue = 'running'

    await manager.stop(2500)
    await new Promise((resolve) => setTimeout(resolve, 300))

    const parentAlive = typeof parent.pid === 'number' ? isProcessAlive(parent.pid) : false
    const childAlive = isProcessAlive(childPid as number)
    assert.equal(parentAlive, false, `parent process should be gone after stop, pid=${String(parent.pid)}`)
    assert.equal(childAlive, false, `child process should be gone after stop, pid=${String(childPid)}`)
  } finally {
    if (typeof parent.pid === 'number') {
      forceKillProcessTree(parent.pid)
    }
    if (typeof childPid === 'number') {
      forceKillProcessTree(childPid)
    }
  }
}

async function testStopFailureMarksErrorAndClearsStoppingFlag(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  const fakeChild = createFakeRunningChild(32001)
  manager.child = fakeChild
  manager.statusValue = 'running'
  manager.stopping = false
  manager.terminateChildProcess = async () => {}

  const status = await manager.stop(800)

  assert.equal(status.running, true, 'expected running=true when child still alive after stop timeout')
  assert.equal(status.status, 'error', 'expected status=error when stop timeout leaves process alive')
  assert.equal(manager.stopping, false, 'expected stopping flag to be cleared after stop() returns')
}

async function testRestartDoesNotDeadlockLifecycleQueue(): Promise<void> {
  const manager = new GatewayProcessManager() as ManagerInternals
  manager.child = createFakeRunningChild(33001)
  manager.statusValue = 'running'
  manager.stopping = false
  manager.restarting = false

  manager.stopInternal = async () => {
    manager.child = null
    manager.statusValue = 'stopped'
    return manager.getStatus()
  }
  manager.startInternal = async () => {
    manager.child = createFakeRunningChild(33002)
    manager.statusValue = 'running'
    return manager.getStatus()
  }

  const status = await withTimeout(manager.restart({ port: 18789 }), 1200, 'restart()')
  assert.equal(status.status, 'running', 'expected restart() to finish and return running status')
  assert.equal(status.running, true, 'expected running=true after restart()')
}

async function testHealthCheckRequiresConsecutiveFailuresBeforeRestart(): Promise<void> {
  const manager = new GatewayProcessManager({ healthCheckFailureThreshold: 2 }) as ManagerInternals
  manager.child = createFakeRunningChild(33003)
  manager.statusValue = 'running'
  manager.stopping = false
  manager.restarting = false

  let restartCalls = 0
  manager.tryAutoRestart = async () => {
    restartCalls += 1
  }
  manager.checkGatewayHealth = async () => ({ ok: false, details: 'timeout' })

  await manager.runHealthCheck()
  assert.equal(restartCalls, 0, 'expected first health check failure to not trigger restart')
  assert.equal(manager.consecutiveHealthCheckFailures, 1, 'expected failure counter to increment after first failure')

  await manager.runHealthCheck()
  assert.equal(restartCalls, 1, 'expected second consecutive failure to trigger restart')
  assert.equal(manager.consecutiveHealthCheckFailures, 0, 'expected failure counter to reset after restart trigger')
}

function withEnterpriseManifest<T>(
  manifest: Record<string, unknown>,
  run: (manifestPath: string, rootDir: string) => T,
): T {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-enterprise-smoke-'))
  const supportDir = path.join(rootDir, 'support')
  fs.mkdirSync(supportDir, { recursive: true })
  const manifestPath = path.join(supportDir, 'install-manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  const previousManifest = process.env.OPENCLAW_ENTERPRISE_INSTALL_MANIFEST
  process.env.OPENCLAW_ENTERPRISE_INSTALL_MANIFEST = manifestPath
  try {
    return run(manifestPath, rootDir)
  } finally {
    if (typeof previousManifest === 'string') {
      process.env.OPENCLAW_ENTERPRISE_INSTALL_MANIFEST = previousManifest
    } else {
      delete process.env.OPENCLAW_ENTERPRISE_INSTALL_MANIFEST
    }
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
}

function writeRuntimeAsset(filePath: string, content = '// smoke asset\n'): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

async function testCreateGatewayLaunchSpecInjectsEnterpriseRuntime(): Promise<void> {
  withEnterpriseManifest({}, (_manifestPath, rootDir) => {
    const supportDir = path.join(rootDir, 'support')
    const loaderPath = writeRuntimeAsset(path.join(supportDir, 'decrypt-loader.js'))
    const bootstrapPath = writeRuntimeAsset(path.join(supportDir, 'openclaw-esm-run-hook.bootstrap.mjs'))
    const wrapperPath = writeRuntimeAsset(path.join(supportDir, 'bridge-wrapper.mjs'))
    const manifest = {
      supportDir,
      decryptLoaderPath: loaderPath,
      esmBootstrapPath: bootstrapPath,
      wrapperPath,
      [TEST_ENTERPRISE_ENV_KEY]: 'active-smoke',
    }
    fs.writeFileSync(path.join(supportDir, 'install-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    const spec = createGatewayLaunchSpec({ port: 19122 })
    assert.equal(spec.enterpriseRuntime?.status, 'active', 'expected enterprise runtime to be active')
    assert.equal(spec.args[0], '-r', 'expected launch args to inject decrypt loader first')
    assert.equal(spec.args[1], loaderPath, 'expected launch args to reference manifest decrypt loader')
    assert.equal(spec.args[2], '--import', 'expected launch args to include ESM bootstrap injection')
    assert.equal(spec.args[3], bootstrapPath, 'expected launch args to reference manifest bootstrap')
    assert.equal(spec.args[4].endsWith('openclaw.mjs'), true, 'expected OpenClaw entry to follow runtime injections')
    assert.equal(spec.env[TEST_ENTERPRISE_ENV_KEY], 'active-smoke', 'expected enterprise env contract to be merged')
    assert.equal(spec.env.OPENCLAW_ENTERPRISE_WRAPPER_PATH, wrapperPath, 'expected wrapper path in child env')
  })
}

async function testCreateGatewayLaunchSpecInjectsEnterpriseRuntimeFromInstallerManifestKeys(): Promise<void> {
  withEnterpriseManifest({}, (_manifestPath, rootDir) => {
    const supportDir = path.join(rootDir, 'support')
    const runtimeLoaderDir = path.join(rootDir, 'runtime-loader')
    const workspaceDir = path.join(rootDir, 'workspace')
    const loaderPath = writeRuntimeAsset(path.join(runtimeLoaderDir, 'decrypt-loader.js'))
    const bootstrapPath = writeRuntimeAsset(path.join(runtimeLoaderDir, 'openclaw-esm-run-hook.bootstrap.mjs'))
    const wrapperPath = writeRuntimeAsset(path.join(workspaceDir, 'skills', 'hanxu-technology', 'SKILL.md'))
    const manifest = {
      supportDir,
      runtimeLoaderDir,
      loaderPath,
      esmHookBootstrapPath: bootstrapPath,
      wrapperPath,
      [TEST_ENTERPRISE_ENV_KEY]: 'active-installer-smoke',
    }
    fs.writeFileSync(path.join(supportDir, 'install-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

    const spec = createGatewayLaunchSpec({ port: 19124 })
    assert.equal(spec.enterpriseRuntime?.status, 'active', 'expected enterprise runtime to be active for installer keys')
    assert.equal(spec.args[0], '-r', 'expected launch args to inject decrypt loader first for installer keys')
    assert.equal(spec.args[1], loaderPath, 'expected launch args to reference loaderPath from installer manifest')
    assert.equal(spec.args[2], '--import', 'expected launch args to include ESM bootstrap injection for installer keys')
    if (process.platform === 'win32') {
      assert.equal(
        spec.args[3].startsWith('file:///'),
        true,
        'expected launch args to use file:// URL for --import on Windows',
      )
    } else {
      assert.equal(spec.args[3], bootstrapPath, 'expected launch args to reference esmHookBootstrapPath from installer manifest')
    }
    assert.equal(spec.env[TEST_ENTERPRISE_ENV_KEY], 'active-installer-smoke', 'expected enterprise env contract to be merged')
    assert.equal(spec.env.OPENCLAW_ENTERPRISE_WRAPPER_PATH, wrapperPath, 'expected wrapper path in child env for installer keys')
  })
}

async function testCreateGatewayLaunchSpecFallsBackWhenEnterpriseAssetsMissing(): Promise<void> {
  const previousEnv = process.env[TEST_ENTERPRISE_ENV_KEY]
  delete process.env[TEST_ENTERPRISE_ENV_KEY]
  try {
    withEnterpriseManifest({}, (_manifestPath, rootDir) => {
      const supportDir = path.join(rootDir, 'support')
      const manifest = {
        supportDir,
        decryptLoaderPath: path.join(supportDir, 'missing-loader.js'),
        esmBootstrapPath: path.join(supportDir, 'missing-bootstrap.mjs'),
        wrapperPath: path.join(supportDir, 'missing-wrapper.mjs'),
        [TEST_ENTERPRISE_ENV_KEY]: 'inactive-smoke',
      }
      fs.writeFileSync(path.join(supportDir, 'install-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

      const spec = createGatewayLaunchSpec({ port: 19123 })
      assert.equal(spec.enterpriseRuntime?.status, 'inactive', 'expected enterprise runtime to stay inactive')
      assert.equal(spec.args[0].endsWith('openclaw.mjs'), true, 'expected fallback launch to start with openclaw.mjs')
      assert.equal(spec.args.includes('-r'), false, 'expected fallback launch to omit -r')
      assert.equal(spec.args.includes('--import'), false, 'expected fallback launch to omit --import')
      assert.equal(spec.env[TEST_ENTERPRISE_ENV_KEY], undefined, 'expected enterprise env to not leak on fallback')
    })
  } finally {
    if (typeof previousEnv === 'string') {
      process.env[TEST_ENTERPRISE_ENV_KEY] = previousEnv
    } else {
      delete process.env[TEST_ENTERPRISE_ENV_KEY]
    }
  }
}

async function main(): Promise<void> {
  const tests: Array<[name: string, fn: () => Promise<void>]> = [
    ['start() uses real process state, not child.killed', testStartTreatsKilledFlagAsNonAuthoritative],
    ['start() recovers from stale error state when child is alive', testStartRecoversFromErrorWhenProcessStillRunning],
    ['waitForGatewayReady() polls when child.killed=true', testWaitForReadyUsesRealProcessState],
    ['runHealthCheck() runs when child.killed=true', testHealthCheckUsesRealProcessState],
    ['stop() kills stubborn process tree', testStopKillsStubbornWindowsProcessTree],
    ['stop() timeout reports error and clears stopping state', testStopFailureMarksErrorAndClearsStoppingFlag],
    ['restart() does not deadlock lifecycle queue', testRestartDoesNotDeadlockLifecycleQueue],
    ['health checks require consecutive failures before restart', testHealthCheckRequiresConsecutiveFailuresBeforeRestart],
    ['createGatewayLaunchSpec() injects enterprise runtime when manifest is valid', testCreateGatewayLaunchSpecInjectsEnterpriseRuntime],
    [
      'createGatewayLaunchSpec() injects enterprise runtime with installer manifest keys',
      testCreateGatewayLaunchSpecInjectsEnterpriseRuntimeFromInstallerManifestKeys,
    ],
    ['createGatewayLaunchSpec() falls back when enterprise assets are missing', testCreateGatewayLaunchSpecFallsBackWhenEnterpriseAssetsMissing],
  ]

  for (const [name, fn] of tests) {
    await fn()
    // Keep logs concise but explicit for CI and local smoke execution.
    process.stdout.write(`[smoke:gateway] PASS ${name}\n`)
  }
}

main()
  .then(() => {
    process.exit(0)
  })
  .catch((error) => {
    process.stderr.write(
      `[smoke:gateway] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
