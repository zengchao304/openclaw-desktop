/**
 * npm `openclaw` packages no longer ship `dist/control-ui/` (see upstream package.json "files").
 * Gateway still serves static assets from that path. This step fetches matching GitHub tag sources
 * (`ui/` + `scripts/ui.js` + repo-root `src/` for shared imports), runs `vite build` into
 * `../dist/control-ui`, then deletes those sources
 * and devDependencies so the desktop bundle stays small.
 *
 * Note: Vite 8 + Rolldown native bindings often fail on GitHub `windows-latest`; CI builds UI on Linux
 * and merges `dist/control-ui` before `prepare-bundle` (see release workflow + ci-build-openclaw-control-ui).
 */

import { mkdir, rm, cp, writeFile, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync, execSync } from 'node:child_process'

const GITHUB_REPO = 'openclaw/openclaw'

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function gitTagForNpmVersion(version: string): string {
  const v = version.trim()
  if (!v) throw new Error('OpenClaw version is empty')
  return v.startsWith('v') ? v : `v${v}`
}

function tarballUrlForTag(tag: string): string {
  return `https://codeload.github.com/${GITHUB_REPO}/tar.gz/${tag}`
}

async function findExtractedRepoRoot(extractParent: string): Promise<string> {
  const names = await readdir(extractParent, { withFileTypes: true })
  for (const ent of names) {
    if (!ent.isDirectory()) continue
    const root = join(extractParent, ent.name)
    const uiPkg = join(root, 'ui', 'package.json')
    const uiScript = join(root, 'scripts', 'ui.js')
    if ((await fileExists(uiPkg)) && (await fileExists(uiScript))) {
      return root
    }
  }
  throw new Error(
    `Extracted OpenClaw archive under ${extractParent} has no ui/package.json + scripts/ui.js`,
  )
}

async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'openclaw-desktop-bundle/ensure-control-ui' },
  })
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(dest, buf)
}

/**
 * Fetch OpenClaw `ui/` from GitHub tag matching `npmPackageVersion` and run `vite build`
 * into `openclawRoot/dist/control-ui`. Does not delete sources (caller may clean up).
 */
export async function downloadAndBuildOpenClawControlUiAt(
  openclawRoot: string,
  npmPackageVersion: string,
): Promise<void> {
  const tag = gitTagForNpmVersion(npmPackageVersion)
  const url = tarballUrlForTag(tag)
  console.log(`  [control-ui] fetching ${tag} sources from GitHub...`)

  const parentTmp = join(openclawRoot, '..', '_openclaw_control_ui_tmp')
  await rm(parentTmp, { recursive: true, force: true })
  await mkdir(parentTmp, { recursive: true })

  const tgzPath = join(parentTmp, 'openclaw-src.tgz')
  const extractDir = join(parentTmp, 'extracted')

  try {
    await downloadToFile(url, tgzPath)
    await mkdir(extractDir, { recursive: true })
    execFileSync('tar', ['-xzf', tgzPath, '-C', extractDir], { stdio: 'inherit' })

    const srcRoot = await findExtractedRepoRoot(extractDir)
    const uiSrc = join(srcRoot, 'ui')
    const uiDest = join(openclawRoot, 'ui')
    const sharedSrc = join(srcRoot, 'src')
    const sharedDest = join(openclawRoot, 'src')
    const scriptSrc = join(srcRoot, 'scripts', 'ui.js')
    const scriptDestDir = join(openclawRoot, 'scripts')
    const scriptDest = join(scriptDestDir, 'ui.js')

    await rm(uiDest, { recursive: true, force: true })
    await cp(uiSrc, uiDest, { recursive: true })
    await rm(sharedDest, { recursive: true, force: true })
    await cp(sharedSrc, sharedDest, { recursive: true })
    await mkdir(scriptDestDir, { recursive: true })
    await cp(scriptSrc, scriptDest)

    console.log('  [control-ui] npm install in ui/ (Vite + deps)...')
    execSync('npm install --no-audit --no-fund', {
      cwd: uiDest,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: '' },
    })

    console.log('  [control-ui] vite build → dist/control-ui')
    execSync('npm run build', {
      cwd: uiDest,
      stdio: 'inherit',
    })

    const indexHtml = join(openclawRoot, 'dist', 'control-ui', 'index.html')
    if (!(await fileExists(indexHtml))) {
      throw new Error(`Control UI build finished but missing: ${indexHtml}`)
    }
  } finally {
    await rm(parentTmp, { recursive: true, force: true })
  }
}

async function removeBundledUiSources(openclawDir: string): Promise<void> {
  const uiDest = join(openclawDir, 'ui')
  const sharedDest = join(openclawDir, 'src')
  const scriptDest = join(openclawDir, 'scripts', 'ui.js')
  const scriptDestDir = join(openclawDir, 'scripts')
  await rm(uiDest, { recursive: true, force: true })
  await rm(sharedDest, { recursive: true, force: true })
  await rm(scriptDest, { force: true })
  try {
    const rest = await readdir(scriptDestDir)
    if (rest.length === 0) {
      await rm(scriptDestDir, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }
}

/**
 * If `dist/control-ui/index.html` is missing under `openclawDir`, fetch matching GitHub tag sources and build.
 * Strips `ui/` + `src/` + `scripts/ui.js` after a successful build to keep the bundle lean.
 */
export async function ensureOpenClawControlUiBuilt(
  openclawDir: string,
  npmPackageVersion: string,
): Promise<void> {
  const indexHtml = join(openclawDir, 'dist', 'control-ui', 'index.html')
  if (await fileExists(indexHtml)) {
    console.log('  [control-ui] dist/control-ui already present — skip')
    return
  }

  console.log(`  [control-ui] npm package has no static UI; building for ${npmPackageVersion}...`)
  await downloadAndBuildOpenClawControlUiAt(openclawDir, npmPackageVersion)

  console.log('  [control-ui] removing ui/ sources and dev install from bundle...')
  await removeBundledUiSources(openclawDir)

  console.log('  [control-ui] OK')
}
