/**
 * OpenClaw 主配置读写
 * 路径：%USERPROFILE%\.openclaw\openclaw.json（JSON5 格式）
 * 参考：OpenClaw config/io.ts loadConfig 流程
 */

import fs from 'node:fs'
import path from 'node:path'
import JSON5 from 'json5'
import type { OpenClawConfig } from '../../shared/types.js'
import { getUserDataDir } from '../utils/paths.js'
import { OPENCLAW_CONFIG_FILE } from '../../shared/constants.js'

function getOpenClawConfigPath(): string {
  return path.join(getUserDataDir(), OPENCLAW_CONFIG_FILE)
}

function buildDefaultProviderModel(modelId: string): Record<string, unknown> & { id: string; name: string } {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }
}

function getPrimaryModelRef(config: OpenClawConfig): string | undefined {
  const model = config?.agents?.defaults?.model
  if (typeof model === 'string') return model
  if (model && typeof model === 'object') {
    const primary = (model as { primary?: unknown }).primary
    if (typeof primary === 'string') return primary
  }
  return undefined
}

function inferModelIdFromConfig(config: OpenClawConfig, providerId: string): string | undefined {
  const primary = getPrimaryModelRef(config)
  if (primary?.startsWith(`${providerId}/`)) {
    const id = primary.slice(providerId.length + 1).trim()
    if (id) return id
  }

  const aliases = config?.agents?.defaults?.models
  if (aliases && typeof aliases === 'object') {
    for (const modelRef of Object.keys(aliases)) {
      if (!modelRef.startsWith(`${providerId}/`)) continue
      const id = modelRef.slice(providerId.length + 1).trim()
      if (id) return id
    }
  }

  return undefined
}

function migrateLegacyProviderConfig(config: OpenClawConfig): { config: OpenClawConfig; changed: boolean } {
  const providers = config?.models?.providers
  if (!providers || typeof providers !== 'object') {
    return { config, changed: false }
  }

  const next = JSON.parse(JSON.stringify(config)) as OpenClawConfig
  const nextProviders = next.models?.providers
  if (!nextProviders || typeof nextProviders !== 'object') {
    return { config, changed: false }
  }

  let changed = false
  for (const [providerId, rawProviderConfig] of Object.entries(nextProviders)) {
    if (!rawProviderConfig || typeof rawProviderConfig !== 'object' || Array.isArray(rawProviderConfig)) {
      continue
    }

    const providerConfig = rawProviderConfig as Record<string, unknown>
    const compatibility = providerConfig.compatibility
    if (compatibility === 'openai' || compatibility === 'anthropic') {
      if (typeof providerConfig.api !== 'string' || providerConfig.api.trim().length === 0) {
        providerConfig.api = compatibility === 'anthropic' ? 'anthropic-messages' : 'openai-completions'
      }
    }
    if ('compatibility' in providerConfig) {
      delete providerConfig.compatibility
      changed = true
    }

    const models = providerConfig.models
    if (!Array.isArray(models) || models.length === 0) {
      const inferredModelId = inferModelIdFromConfig(next, providerId)
      providerConfig.models = [buildDefaultProviderModel(inferredModelId ?? 'default')]
      changed = true
    }
  }

  if (!changed) {
    return { config, changed: false }
  }
  return { config: next, changed: true }
}

/**
 * 读取 OpenClaw 主配置
 * - 文件不存在 → 返回 {}
 * - 解析失败（损坏）→ 返回 {} 并记录警告
 */
export function readOpenClawConfig(): OpenClawConfig {
  const configPath = getOpenClawConfigPath()
  try {
    if (!fs.existsSync(configPath)) {
      return {}
    }
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON5.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const migrated = migrateLegacyProviderConfig(parsed as OpenClawConfig)
      if (migrated.changed) {
        try {
          writeOpenClawConfig(migrated.config)
          console.info('[config] Migrated legacy provider fields in openclaw.json')
        } catch (err) {
          console.warn(
            '[config] Failed to persist migrated openclaw config:',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
      return migrated.config
    }
    return {}
  } catch (err) {
    console.warn(
      `[config] OpenClaw config parse failed, using defaults: ${configPath}`,
      err instanceof Error ? err.message : String(err)
    )
    return {}
  }
}

/**
 * 写入 OpenClaw 主配置
 * 使用标准 JSON 格式输出（便于工具兼容）
 */
export function writeOpenClawConfig(config: OpenClawConfig): void {
  const configPath = getOpenClawConfigPath()
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  const data = JSON.stringify(config, null, 2) + '\n'
  const tmpPath = `${configPath}.tmp`
  fs.writeFileSync(tmpPath, data, 'utf-8')
  try {
    fs.renameSync(tmpPath, configPath)
  } catch {
    // Windows: rename fails if target exists; remove it and retry
    fs.unlinkSync(configPath)
    fs.renameSync(tmpPath, configPath)
  }
}

/**
 * 检查 OpenClaw 配置文件是否存在
 */
export function openclawConfigExists(): boolean {
  return fs.existsSync(getOpenClawConfigPath())
}
