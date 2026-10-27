/**
 * Posting an export to social accounts. The Vite process forwards to the
 * Social Planner on this PC, which publishes through RocStarr Connect; the
 * accounts (several per platform) are connected and kept there, so the editor
 * never sees a password or token.
 */
import type { PostRequest, PostResult, SocialAccount, SocialStatus } from '../../../server/library/social'

export type { PostRequest, PostResult, SocialAccount, SocialStatus }

const BASE = '/library/social'

export const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  twitter: 'X',
  google: 'Google Business',
}

/** Platforms listed first; anything unknown goes after, alphabetically. */
export const PLATFORM_ORDER = ['instagram', 'tiktok', 'facebook', 'youtube', 'linkedin', 'threads', 'twitter', 'google']

export async function getSocialStatus(): Promise<SocialStatus> {
  let r: Response
  try {
    r = await fetch(`${BASE}/status`, { headers: { Accept: 'application/json' } })
  } catch {
    throw new Error('The library server is not reachable.')
  }
  const data = (await r.json().catch(() => null)) as (SocialStatus & { error?: string }) | null
  if (!r.ok || !data) throw new Error(data?.error ?? `${r.status} ${r.statusText}`)
  return data
}

/** Sends the exported file to the Social Planner's upload folder, with progress. */
export function uploadForPost(blob: Blob, ext: string, onProgress?: (fraction: number) => void): Promise<{ id: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/upload?ext=${encodeURIComponent(ext)}`)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total)
    }
    xhr.onerror = () => reject(new Error('Upload failed — is the editor server running?'))
    xhr.onload = () => {
      const data = xhr.response as { id?: string; bytes?: number; error?: string } | null
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve({ id: data.id, bytes: data.bytes ?? blob.size })
      else reject(new Error(data?.error ?? `Upload failed (${xhr.status}).`))
    }
    xhr.send(blob)
  })
}

export async function postVideo(body: PostRequest): Promise<PostResult> {
  let r: Response
  try {
    r = await fetch(`${BASE}/post`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
  } catch {
    throw new Error('The library server is not reachable.')
  }
  const data = (await r.json().catch(() => null)) as PostResult | null
  if (!data) throw new Error(`${r.status} ${r.statusText}`)
  return data
}
