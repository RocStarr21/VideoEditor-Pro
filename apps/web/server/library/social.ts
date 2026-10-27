/**
 * Bridge to the Social Planner on this PC, which publishes through RocStarr
 * Connect to the accounts connected there (as many per platform as the user
 * signs in). The editor never holds social credentials: it hands over the
 * finished video and names the accounts.
 */
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'

const PLANNER = (process.env.SOCIAL_PLANNER_URL || 'http://127.0.0.1:3005').replace(/\/$/, '')
const NOT_RUNNING = 'The Social Planner is not running on this computer (port 3005).'

export interface SocialAccount {
  id: string
  platform: string
  name: string
}

export interface SocialStatus {
  planner: string
  /** RocStarr Connect readiness as the Social Planner reports it. */
  status: { ok: boolean; configured?: boolean; error?: string }
  accounts: SocialAccount[]
}

export interface PostRequest {
  file: string
  summary: string
  accountIds: string[]
  runAt?: string
  type?: 'post' | 'reel' | 'story'
  dryRun?: boolean
}

export interface PostResult {
  ok: boolean
  error?: string | null
  planned?: boolean
  results: Array<{ platforms: string[]; accounts?: string[]; type?: string; ok: boolean; error: string | null; planned?: boolean; mediaUrls?: string[] }>
  skipped: Array<{ platform: string; name: string; reason: string }>
}

async function planner(route: string, init?: RequestInit): Promise<{ status: number; data: Record<string, unknown> | unknown[] | null }> {
  let r: Response
  try {
    r = await fetch(`${PLANNER}${route}`, init)
  } catch {
    throw new Error(NOT_RUNNING)
  }
  const text = await r.text()
  try {
    return { status: r.status, data: text ? JSON.parse(text) : null }
  } catch {
    throw new Error(`The Social Planner replied ${r.status} without JSON.`)
  }
}

export async function socialStatus(): Promise<SocialStatus> {
  // The planner answers { configured, ready, reason, accounts } — ready is the one that matters.
  const r = await planner('/api/social/status')
  const s = (r.data ?? {}) as { configured?: boolean; ready?: boolean; reason?: string | null; accounts?: SocialAccount[] }
  const list = Array.isArray(s.accounts) ? s.accounts : []
  return { planner: PLANNER, status: { ok: !!s.ready, configured: s.configured, error: s.reason ?? undefined }, accounts: list.map((a) => ({ id: a.id, platform: a.platform, name: a.name })) }
}

/** Streams the exported video straight into the Social Planner's upload folder; returns its upload id. */
export async function uploadForPost(req: IncomingMessage, ext: string): Promise<{ id: string; bytes: number }> {
  const safeExt = /^(mp4|mov|webm)$/i.test(ext) ? ext.toLowerCase() : 'mp4'
  const init = { method: 'POST', body: Readable.toWeb(req) as unknown as BodyInit, duplex: 'half' } as RequestInit
  const r = await planner(`/api/video/upload?ext=${safeExt}`, init)
  const data = (r.data ?? {}) as { ok?: boolean; id?: string; bytes?: number; error?: string }
  if (!data.ok || !data.id) throw new Error(data.error ?? `Upload refused (${r.status}).`)
  return { id: data.id, bytes: data.bytes ?? 0 }
}

export async function postVideo(body: PostRequest): Promise<PostResult> {
  const r = await planner('/api/social/video-post', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = (r.data ?? {}) as Partial<PostResult>
  return { ok: !!data.ok, error: data.error ?? (data.ok ? null : `Social Planner replied ${r.status}`), planned: data.planned, results: data.results ?? [], skipped: data.skipped ?? [] }
}
