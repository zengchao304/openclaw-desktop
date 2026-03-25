import fs from 'node:fs'
import path from 'node:path'

export interface OpenClawValidationResult {
  ok: boolean
  missing: string[]
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function readEntryPath(openclawDir: string): string | null {
  const entryJs = path.join(openclawDir, 'dist', 'entry.js')
  const entryMjs = path.join(openclawDir, 'dist', 'entry.mjs')
  if (fileExists(entryJs)) return entryJs
  if (fileExists(entryMjs)) return entryMjs
  return null
}

function validateControlUiBundle(openclawDir: string): string[] {
  const missing: string[] = []
  const indexPath = path.join(openclawDir, 'dist', 'control-ui', 'index.html')
  if (!fileExists(indexPath)) {
    missing.push('dist/control-ui/index.html')
    return missing
  }

  try {
    const html = fs.readFileSync(indexPath, 'utf-8')
    const scriptMatch = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)
    if (!scriptMatch || !scriptMatch[1]) {
      missing.push('dist/control-ui/assets/index-*.js (not referenced)')
      return missing
    }
    const rel = scriptMatch[1].replace(/^\.\//, '')
    const scriptPath = path.join(openclawDir, 'dist', 'control-ui', rel)
    if (!fileExists(scriptPath)) {
      missing.push(`dist/control-ui/${rel}`)
    }
  } catch {
    missing.push('dist/control-ui/index.html (read failed)')
  }

  return missing
}

export function validateOpenclawResources(openclawDir: string): OpenClawValidationResult {
  const missing: string[] = []

  if (!fileExists(path.join(openclawDir, 'openclaw.mjs'))) {
    missing.push('openclaw.mjs')
  }
  if (!fileExists(path.join(openclawDir, 'node_modules'))) {
    missing.push('node_modules/')
  }

  const entryPath = readEntryPath(openclawDir)
  if (!entryPath) {
    missing.push('dist/entry.(m)js')
    return { ok: false, missing }
  }

  try {
    const entryContent = fs.readFileSync(entryPath, 'utf-8')
    const importRegex = /\bimport\s+(?:[^'"]+from\s+)?['"](\.\/[^'"]+)['"]/g
    let match: RegExpExecArray | null
    while ((match = importRegex.exec(entryContent))) {
      const rel = match[1]
      if (!rel.startsWith('./')) continue
      const target = path.join(openclawDir, 'dist', rel.replace(/^\.\//, ''))
      if (!fileExists(target)) {
        missing.push(`dist/${rel.replace(/^\.\//, '')}`)
      }
    }
  } catch {
    missing.push('dist/entry.(m)js (read failed)')
  }

  missing.push(...validateControlUiBundle(openclawDir))

  return { ok: missing.length === 0, missing }
}
