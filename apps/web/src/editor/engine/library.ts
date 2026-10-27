/**
 * Client for the audio library served by the Vite process (server/library).
 * Audio pulled from YouTube is kept on disk next to the app, so it is listed in
 * every project; adding it to a project copies it into that project's assets.
 */
import type { LibraryItem, LibraryJob, LibraryStatus, TrashInfo } from '../../../server/library/service'

export type { LibraryItem, LibraryJob, LibraryStatus, TrashInfo }
export { formatBytes } from '../../../server/library/util'

const BASE = '/library'

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${BASE}${route}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
    })
  } catch {
    throw new Error('The library server is not reachable.')
  }
  const text = await r.text()
  let data: { error?: string } | null = null
  try {
    data = text ? (JSON.parse(text) as { error?: string }) : null
  } catch {
    throw new Error(r.ok ? 'Unexpected reply from the library server.' : `${r.status} ${r.statusText}`)
  }
  if (!r.ok) throw new Error(data?.error ?? `${r.status} ${r.statusText}`)
  return data as T
}

export const getLibraryStatus = () => api<LibraryStatus>('/status')
export const listLibrary = () => api<LibraryItem[]>('/items')
export const getLibraryItem = (id: string) => api<LibraryItem>(`/items/${encodeURIComponent(id)}`)
export const deleteLibraryItem = (id: string) => api<{ ok: boolean }>(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const startYouTubeJob = (url: string) => api<LibraryJob>('/youtube', { method: 'POST', body: JSON.stringify({ url }) })
export const listJobs = () => api<LibraryJob[]>('/jobs')
export const dismissJob = (id: string) => api<{ ok: boolean }>(`/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getTrash = () => api<TrashInfo>('/trash')
export const emptyTrash = () => api<{ deleted: number }>('/trash', { method: 'DELETE' })
export const revealLibraryFolder = (target: 'audio' | 'trash') => api<{ ok: boolean }>('/reveal', { method: 'POST', body: JSON.stringify({ target }) })
export const updateYtDlp = () => api<{ version: string | null; output: string }>('/update', { method: 'POST', body: '{}' })

export const libraryAudioUrl = (id: string) => `${BASE}/audio/${encodeURIComponent(id)}`

export const isJobActive = (job: LibraryJob) => job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting'

/** The audio as a File, ready for importFiles — same path as a drag from Explorer. */
export async function fetchLibraryFile(item: LibraryItem): Promise<File> {
  const r = await fetch(libraryAudioUrl(item.id))
  if (!r.ok) throw new Error(r.status === 404 ? 'That audio is no longer in the library.' : `Could not read the audio (${r.status}).`)
  const blob = await r.blob()
  return new File([blob], item.fileName, { type: item.mime, lastModified: item.addedAt })
}
