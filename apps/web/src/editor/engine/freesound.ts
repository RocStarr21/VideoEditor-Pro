/**
 * Freesound sound-effects search (OpenCut "Sounds" panel). Calls the public
 * API straight from the browser with the user's own API key, which is kept in
 * localStorage on this device only.
 */
const KEY_STORAGE = 've-freesound-key'
const API = 'https://freesound.org/apiv2'

export interface SoundResult {
  id: number
  name: string
  duration: number
  username: string
  license: string
  previewUrl: string
  tags: string[]
}

export interface SoundPage {
  results: SoundResult[]
  count: number
  nextPage: number | null
}

export const getFreesoundKey = () => {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

export const setFreesoundKey = (key: string) => {
  try {
    if (key.trim()) localStorage.setItem(KEY_STORAGE, key.trim())
    else localStorage.removeItem(KEY_STORAGE)
  } catch {
    // Private mode: the key just is not remembered.
  }
}

const LICENSE_LABEL: Record<string, string> = {
  'http://creativecommons.org/publicdomain/zero/1.0/': 'CC0 — free to use',
  'http://creativecommons.org/licenses/by/4.0/': 'CC BY — credit the author',
  'http://creativecommons.org/licenses/by/3.0/': 'CC BY — credit the author',
  'http://creativecommons.org/licenses/by-nc/4.0/': 'CC BY-NC — non-commercial',
  'http://creativecommons.org/licenses/by-nc/3.0/': 'CC BY-NC — non-commercial',
  'http://creativecommons.org/licenses/sampling+/1.0/': 'Sampling+',
}

export const licenseLabel = (url: string) => LICENSE_LABEL[url] ?? url.replace(/^https?:\/\/creativecommons\.org\/licenses\//, 'CC ').replace(/\/$/, '')

export async function searchSounds(query: string, opts: { key: string; page?: number; commercialOnly?: boolean; signal?: AbortSignal }): Promise<SoundPage> {
  const params = new URLSearchParams({
    query: query.trim(),
    fields: 'id,name,duration,username,license,previews,tags',
    page_size: '24',
    page: String(opts.page ?? 1),
    sort: query.trim() ? 'score' : 'downloads_desc',
    token: opts.key,
  })
  if (opts.commercialOnly) params.set('license', 'Creative Commons 0')
  const res = await fetch(`${API}/search/text/?${params}`, { signal: opts.signal })
  if (res.status === 401) throw new Error('Freesound rejected the API key. Check it and try again.')
  if (!res.ok) throw new Error(`Freesound search failed (${res.status})`)
  const data = (await res.json()) as {
    count: number
    next: string | null
    results: Array<{ id: number; name: string; duration: number; username: string; license: string; previews: Record<string, string>; tags: string[] }>
  }
  return {
    count: data.count,
    nextPage: data.next ? (opts.page ?? 1) + 1 : null,
    results: data.results.map((r) => ({
      id: r.id,
      name: r.name,
      duration: r.duration,
      username: r.username,
      license: r.license,
      previewUrl: r.previews['preview-hq-mp3'] ?? r.previews['preview-lq-mp3'] ?? '',
      tags: r.tags ?? [],
    })),
  }
}

/** Downloads the MP3 preview as a File ready for import. */
export async function fetchSoundFile(sound: SoundResult): Promise<File> {
  const res = await fetch(sound.previewUrl)
  if (!res.ok) throw new Error('Could not download that sound')
  const blob = await res.blob()
  const safe = sound.name.replace(/[^\w.-]+/g, '_').replace(/\.(wav|aiff?|flac|ogg|mp3)$/i, '')
  return new File([blob], `${safe}.mp3`, { type: 'audio/mpeg' })
}
