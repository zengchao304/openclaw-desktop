/**
 * OpenClaw Feishu/Lark gateway extension loads `@larksuiteoapi/node-sdk`, which is not pulled in by the
 * published `openclaw` npm tarball. Install it into the bundled tree so desktop builds load the plugin.
 */

import { execSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const PROJECT_ROOT = process.cwd()
/** Pinned via root package.json `openclawFeishuLarkSdkVersion` for reproducible installs. */
const DEFAULT_FEISHU_SDK_RANGE = '^1.60.0'

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function readFeishuSdkVersionSpec(): Promise<string> {
  try {
    const raw = await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { openclawFeishuLarkSdkVersion?: string }
    const v = pkg.openclawFeishuLarkSdkVersion?.trim()
    if (v) return v
  } catch {
    /* ignore */
  }
  return DEFAULT_FEISHU_SDK_RANGE
}

const SDK_MARKER_SEGMENTS = ['node_modules', '@larksuiteoapi', 'node-sdk', 'package.json'] as const

export function getOpenClawFeishuSdkPackageJsonPath(openclawRoot: string): string {
  return join(openclawRoot, ...SDK_MARKER_SEGMENTS)
}

export async function ensureOpenClawFeishuLarkSdk(openclawRoot: string): Promise<void> {
  const marker = getOpenClawFeishuSdkPackageJsonPath(openclawRoot)
  if (await fileExists(marker)) {
    console.log('  [feishu-sdk] @larksuiteoapi/node-sdk already present in bundled OpenClaw')
    return
  }

  const spec = await readFeishuSdkVersionSpec()
  const pkgArg = `@larksuiteoapi/node-sdk@${spec}`
  console.log(`  [feishu-sdk] npm install ${pkgArg} (cwd=${openclawRoot})...`)

  // Use execSync (shell on Windows) so `npm` resolves to npm.cmd; execFileSync('npm') → ENOENT.
  execSync(
    `npm install ${pkgArg} --omit=dev --no-save --package-lock=false --no-audit --no-fund --ignore-scripts`,
    {
      cwd: openclawRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: '' },
    },
  )

  if (!(await fileExists(marker))) {
    throw new Error(`[feishu-sdk] install failed — missing ${marker}`)
  }
  console.log('  [feishu-sdk] OK')
}
