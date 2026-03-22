import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { RefreshCw, ShieldCheck, X, Copy, Inbox, ExternalLink, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ShellLayout } from './ShellLayout'
import type { FeishuChannelConfig, OpenClawConfig, PairingApproveResult } from '../../shared/types'

export interface FeishuAccessViewProps {
  onBack?: () => void
}

function defaultNavigateBack() {
  window.location.hash = '#settings'
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- strip ANSI color codes from CLI output
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** Prefer a short success line; strip noisy CLI/plugin lines */
function buildApproveSuccessNotice(raw: string | undefined, code: string, t: TFunction): string {
  const fallback = t('shell.feishu.approveSuccessFallback', { code })
  if (!raw?.trim()) return fallback
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const filtered = lines.filter((l) => {
    const lower = l.toLowerCase()
    if (lower.includes('plugin') && lower.includes('register')) return false
    return true
  })
  const candidate =
    filtered.find((l) => /approve|approved/i.test(l) && /feishu|sender|pairing/i.test(l.toLowerCase())) ?? filtered[0]
  if (!candidate || candidate.length > 220) return fallback
  return candidate
}

function resolveApproveSuccessNotice(result: PairingApproveResult, code: string, t: TFunction): string {
  if (result.messageId === 'local_approve_success' && result.messageParams?.openId) {
    return t('shell.feishu.approveSuccessLocal', { openId: result.messageParams.openId })
  }
  return buildApproveSuccessNotice(result.message, code, t)
}

function resolveApproveError(result: PairingApproveResult, t: TFunction): string {
  if (result.messageId === 'pairing_code_required') {
    return t('shell.feishu.pairingCodeRequired')
  }
  const raw = result.message?.trim()
  return raw || t('shell.feishu.approveFailed')
}

function formatTimestamp(value: string | undefined, unknownLabel: string): string {
  if (!value) return unknownLabel
  const ts = Date.parse(value)
  if (Number.isNaN(ts)) return value
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ts))
}

function mergeFeishuCredentials(
  cfg: OpenClawConfig,
  appId: string,
  appSecret: string,
): OpenClawConfig {
  const prev = cfg.channels?.feishu
  const base =
    prev && typeof prev === 'object' && !Array.isArray(prev)
      ? ({ ...prev } as FeishuChannelConfig)
      : ({} as FeishuChannelConfig)
  const next: FeishuChannelConfig = {
    ...base,
    appId,
    appSecret,
  }
  if (!next.dmPolicy || String(next.dmPolicy).trim() === '') {
    next.dmPolicy = 'pairing'
  }
  return {
    ...cfg,
    channels: {
      ...(cfg.channels ?? {}),
      feishu: next,
    },
  }
}

export function FeishuAccessView({ onBack }: FeishuAccessViewProps = {}) {
  const { t } = useTranslation()
  const handleBack = onBack ?? defaultNavigateBack
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pending, setPending] = useState<
    Array<{
      code: string
      openId?: string
      displayName?: string
      createdAt?: string
      expiresAt?: string
    }>
  >([])
  const [approved, setApproved] = useState<Array<{ openId: string }>>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [manualPairingCode, setManualPairingCode] = useState('')
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [credentialsLoading, setCredentialsLoading] = useState(true)
  const [savingCredentials, setSavingCredentials] = useState(false)
  const [showAppSecret, setShowAppSecret] = useState(false)

  const loadCredentials = useCallback(async () => {
    setCredentialsLoading(true)
    try {
      const cfg = await window.electronAPI.configRead()
      const f = cfg?.channels?.feishu
      setAppId(typeof f?.appId === 'string' ? f.appId : '')
      setAppSecret(typeof f?.appSecret === 'string' ? f.appSecret : '')
    } catch {
      // non-fatal: user can still type and save
    } finally {
      setCredentialsLoading(false)
    }
  }, [])

  const refresh = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const [pendingResult, approvedResult] = await Promise.all([
        window.electronAPI.pairingListPending({ channel: 'feishu' }),
        window.electronAPI.pairingListApproved({ channel: 'feishu' }),
      ])
      setPending(pendingResult.requests)
      setApproved(approvedResult.senders)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shell.feishu.loadFailed'))
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void loadCredentials()
    void refresh()
    const timer = window.setInterval(() => {
      void refresh(true)
    }, 10_000)
    return () => window.clearInterval(timer)
  }, [loadCredentials, refresh])

  const handleSaveCredentials = async () => {
    const id = appId.trim()
    const secret = appSecret.trim()
    if (!id || !secret) {
      setError(t('shell.feishu.credentialsRequired'))
      setNotice(null)
      return
    }
    setSavingCredentials(true)
    setError(null)
    setNotice(null)
    try {
      const cfg = (await window.electronAPI.configRead()) as OpenClawConfig
      const merged = mergeFeishuCredentials(cfg, id, secret)
      await window.electronAPI.configWrite(merged)
      setNotice(t('shell.feishu.credentialsSaved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shell.feishu.credentialsSaveFailed'))
    } finally {
      setSavingCredentials(false)
    }
  }

  const pendingCount = pending.length
  const approvedCount = approved.length
  const hasPending = pendingCount > 0

  const summaryText = useMemo(() => {
    if (hasPending) {
      return t('shell.feishu.summaryPending', { count: pendingCount })
    }
    return t('shell.feishu.summaryEmpty')
  }, [hasPending, pendingCount, t])

  const handleApprove = async (code: string, openId?: string) => {
    const trimmed = code.trim()
    if (!trimmed) return
    setBusyKey(`approve:${trimmed}`)
    setNotice(null)
    setError(null)
    try {
      const result = await window.electronAPI.pairingApprove({
        channel: 'feishu',
        code: trimmed,
        ...(openId?.trim() ? { openId: openId.trim() } : {}),
      })
      if (!result.ok) {
        setError(resolveApproveError(result, t))
        return
      }
      setNotice(resolveApproveSuccessNotice(result, trimmed, t))
      setManualPairingCode('')
      await refresh(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shell.feishu.approveFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleRemoveApproved = async (openId: string) => {
    setBusyKey(`remove:${openId}`)
    setNotice(null)
    setError(null)
    try {
      await window.electronAPI.pairingRemoveApproved({ channel: 'feishu', openId })
      setNotice(t('shell.feishu.removedFromAllowlist', { openId }))
      await refresh(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('shell.feishu.removeFailed'))
    } finally {
      setBusyKey(null)
    }
  }

  const handleCopy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(t('shell.feishu.copied', { value }))
    } catch {
      setError(t('shell.feishu.clipboardError'))
    }
  }

  const unknownTime = t('shell.feishu.unknownTime')

  return (
    <ShellLayout title={t('shell.feishu.title')} onBack={handleBack}>
      <div className="w-full max-w-4xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('shell.feishu.title')}</h1>
              <p className="text-sm text-muted-foreground mt-1">{t('shell.feishu.subtitle')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh(true)} disabled={refreshing || loading}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              {t('shell.feishu.refresh')}
            </Button>
          </div>
          <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
            <Inbox className={`w-4 h-4 mt-0.5 ${hasPending ? 'text-amber-600' : 'text-muted-foreground'}`} />
            <div className="space-y-1">
              <p className="text-sm font-medium">{summaryText}</p>
              <p className="text-xs text-muted-foreground">{t('shell.feishu.policyHint')}</p>
            </div>
          </div>
        </header>

        <section className="rounded-lg border border-border bg-card p-4 space-y-4" aria-label={t('shell.feishu.credentialsSection')}>
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1 min-w-0">
              <h2 className="text-sm font-semibold">{t('shell.feishu.credentialsSection')}</h2>
              <p className="text-xs text-muted-foreground">{t('shell.feishu.credentialsSectionDesc')}</p>
            </div>
            <a
              href="https://open.feishu.cn/app"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
            >
              {t('wizard.channel.feishu.openPlatform')}
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {credentialsLoading ? (
            <p className="text-sm text-muted-foreground">{t('shell.settings.loading')}</p>
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <fieldset className="space-y-1.5">
                  <label htmlFor="feishu-settings-app-id" className="text-sm font-medium">
                    {t('wizard.channel.feishu.appId')} <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="feishu-settings-app-id"
                    type="text"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="cli_a1b2c3d4e5f6"
                    className="font-mono"
                    autoComplete="off"
                  />
                </fieldset>
                <fieldset className="space-y-1.5">
                  <label htmlFor="feishu-settings-app-secret" className="text-sm font-medium">
                    {t('wizard.channel.feishu.appSecret')} <span className="text-destructive">*</span>
                  </label>
                  <div className="flex gap-2">
                    <Input
                      id="feishu-settings-app-secret"
                      type={showAppSecret ? 'text' : 'password'}
                      value={appSecret}
                      onChange={(e) => setAppSecret(e.target.value)}
                      placeholder={t('wizard.channel.feishu.appSecret')}
                      className="font-mono flex-1"
                      autoComplete="off"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0"
                      onClick={() => setShowAppSecret((v) => !v)}
                      aria-label={showAppSecret ? t('wizard.model.hideApiKey') : t('wizard.model.showApiKey')}
                    >
                      {showAppSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </Button>
                  </div>
                </fieldset>
              </div>
              <p className="text-xs text-muted-foreground">{t('shell.feishu.credentialsRestartHint')}</p>
              <Button type="button" onClick={() => void handleSaveCredentials()} disabled={savingCredentials}>
                {savingCredentials ? t('shell.feishu.savingCredentials') : t('shell.feishu.saveCredentials')}
              </Button>
            </>
          )}
        </section>

        {notice && (
          <section className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
            {notice}
          </section>
        )}

        {error && (
          <section className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </section>
        )}

        <section className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t('shell.feishu.pendingTitle')}</h2>
              <p className="text-xs text-muted-foreground mt-1">{t('shell.feishu.pendingDesc')}</p>
            </div>
            <span className="text-xs font-mono text-muted-foreground">{pendingCount}</span>
          </div>

          <div className="rounded-lg border border-dashed border-border/80 bg-muted/10 p-3 space-y-2">
            <p className="text-xs font-medium text-foreground">{t('shell.feishu.manualCodeTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('shell.feishu.manualCodeDesc')}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="text"
                value={manualPairingCode}
                onChange={(e) => setManualPairingCode(e.target.value.toUpperCase())}
                placeholder={t('shell.feishu.codePlaceholder')}
                className="font-mono uppercase"
                autoComplete="off"
              />
              <Button
                type="button"
                onClick={() => void handleApprove(manualPairingCode)}
                disabled={!manualPairingCode.trim() || busyKey === `approve:${manualPairingCode.trim()}`}
              >
                {busyKey === `approve:${manualPairingCode.trim()}` ? t('shell.feishu.approving') : t('shell.feishu.approveCode')}
              </Button>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('shell.feishu.loadingPending')}</p>
          ) : pendingCount === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              {t('shell.feishu.noPending')}
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map((request) => (
                <article key={request.code} className="rounded-lg border border-border px-4 py-3 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 min-w-0">
                      <p className="text-sm font-medium">
                        {request.displayName || request.openId || t('shell.feishu.unknownSender')}
                      </p>
                      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span className="font-mono">
                          {t('shell.feishu.codeLabel')}: {request.code}
                        </span>
                        {request.openId && (
                          <span className="font-mono">
                            {t('shell.feishu.openIdLabel')}: {request.openId}
                          </span>
                        )}
                        <span>
                          {t('shell.feishu.requested')}: {formatTimestamp(request.createdAt, unknownTime)}
                        </span>
                        {request.expiresAt && (
                          <span>
                            {t('shell.feishu.expires')}: {formatTimestamp(request.expiresAt, unknownTime)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {request.openId && (
                        <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy(request.openId!)}>
                          <Copy className="w-4 h-4" />
                          {t('shell.feishu.copyId')}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void handleApprove(request.code, request.openId)}
                        disabled={busyKey === `approve:${request.code.trim()}`}
                      >
                        <ShieldCheck className="w-4 h-4" />
                        {busyKey === `approve:${request.code.trim()}` ? t('shell.feishu.approving') : t('shell.feishu.approve')}
                      </Button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">{t('shell.feishu.approvedTitle')}</h2>
              <p className="text-xs text-muted-foreground mt-1">{t('shell.feishu.approvedDesc')}</p>
            </div>
            <span className="text-xs font-mono text-muted-foreground">{approvedCount}</span>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">{t('shell.feishu.loadingApproved')}</p>
          ) : approvedCount === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              {t('shell.feishu.noApproved')}
            </div>
          ) : (
            <div className="space-y-3">
              {approved.map((sender) => (
                <article key={sender.openId} className="rounded-lg border border-border px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{sender.openId}</p>
                    <p className="text-xs text-muted-foreground">{t('shell.feishu.allowlistNote')}</p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy(sender.openId)}>
                      <Copy className="w-4 h-4" />
                      {t('shell.feishu.copy')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void handleRemoveApproved(sender.openId)}
                      disabled={busyKey === `remove:${sender.openId}`}
                    >
                      <X className="w-4 h-4" />
                      {busyKey === `remove:${sender.openId}` ? t('shell.feishu.removing') : t('shell.feishu.remove')}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </ShellLayout>
  )
}
