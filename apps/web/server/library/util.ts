/**
 * Pure helpers for the audio library server (no Node APIs), so they can be
 * unit-tested without touching the file system or spawning yt-dlp.
 */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com'])
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/

/**
 * Accepts the link shapes people actually paste (watch, youtu.be, Shorts,
 * live, embed, music.youtube.com) and reduces them to the canonical watch URL,
 * which is what yt-dlp gets. Anything that is not a YouTube video is refused —
 * the server never hands arbitrary URLs to yt-dlp.
 */
export function parseYouTubeUrl(input: string): { id: string; url: string } | null {
  const text = input.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null
  let id: string | null = null
  const host = url.hostname.toLowerCase()
  const parts = url.pathname.split('/').filter(Boolean)
  if (host.endsWith('youtu.be')) {
    id = parts[0] ?? null
  } else if (parts[0] === 'watch') {
    id = url.searchParams.get('v')
  } else if (['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '')) {
    id = parts[1] ?? null
  } else if (url.searchParams.get('v')) {
    id = url.searchParams.get('v')
  }
  if (!id || !VIDEO_ID.test(id)) return null
  return { id, url: `https://www.youtube.com/watch?v=${id}` }
}

/** Windows-safe file stem: strips reserved characters, collapses whitespace, caps the length. */
export function safeFileName(title: string, max = 80): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/[.\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const trimmed = cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned
  return trimmed || 'audio'
}

/** yt-dlp `--newline --progress` prints lines like `[download]  45.2% of  120.30MiB at 5.00MiB/s ETA 00:12`. */
export function parseDownloadProgress(line: string): number | null {
  const m = /^\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line)
  if (!m) return null
  return Math.min(1, Math.max(0, Number(m[1]) / 100))
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
