import { describe, expect, it } from 'vitest'
import { formatBytes, parseDownloadProgress, parseYouTubeUrl, safeFileName } from './util'

describe('parseYouTubeUrl', () => {
  const canonical = 'https://www.youtube.com/watch?v=eRsGyueVLvQ'

  it('accepts the link shapes people paste', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=eRsGyueVLvQ',
      'https://youtube.com/watch?v=eRsGyueVLvQ&t=42s&list=PL123',
      'https://youtu.be/eRsGyueVLvQ?si=abc',
      'https://www.youtube.com/shorts/eRsGyueVLvQ',
      'https://www.youtube.com/live/eRsGyueVLvQ',
      'https://www.youtube.com/embed/eRsGyueVLvQ',
      'https://music.youtube.com/watch?v=eRsGyueVLvQ',
      'm.youtube.com/watch?v=eRsGyueVLvQ',
      '  https://youtu.be/eRsGyueVLvQ  ',
    ]) {
      expect(parseYouTubeUrl(input), input).toEqual({ id: 'eRsGyueVLvQ', url: canonical })
    }
  })

  it('refuses anything that is not a YouTube video', () => {
    for (const input of ['', 'hello', 'https://vimeo.com/12345', 'https://www.youtube.com/', 'https://www.youtube.com/@blender', 'https://www.youtube.com/watch?v=short', 'ftp://youtube.com/watch?v=eRsGyueVLvQ', 'https://notyoutube.com/watch?v=eRsGyueVLvQ']) {
      expect(parseYouTubeUrl(input), input).toBeNull()
    }
  })
})

describe('safeFileName', () => {
  it('strips characters Windows rejects and trailing dots', () => {
    expect(safeFileName('Sintel: "Open Movie" <2010> | Blender?...')).toBe('Sintel Open Movie 2010 Blender')
  })
  it('collapses whitespace and caps the length', () => {
    expect(safeFileName('a   b\t\tc')).toBe('a b c')
    expect(safeFileName('x'.repeat(200), 20)).toHaveLength(20)
  })
  it('never returns an empty name', () => {
    expect(safeFileName('???')).toBe('audio')
  })
})

describe('parseDownloadProgress', () => {
  it('reads the percentage from yt-dlp progress lines', () => {
    expect(parseDownloadProgress('[download]  45.2% of  120.30MiB at    5.00MiB/s ETA 00:12')).toBeCloseTo(0.452)
    expect(parseDownloadProgress('[download] 100% of 120.30MiB in 00:00:24 at 4.9MiB/s')).toBe(1)
    expect(parseDownloadProgress('[download]   0.0% of ~  1.20GiB at  Unknown B/s ETA Unknown')).toBe(0)
  })
  it('ignores other lines', () => {
    expect(parseDownloadProgress('[download] Destination: C:\\x\\y.f137.mp4')).toBeNull()
    expect(parseDownloadProgress('[Merger] Merging formats into "y.mp4"')).toBeNull()
    expect(parseDownloadProgress('')).toBeNull()
  })
})

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB')
    expect(formatBytes(-1)).toBe('0 B')
  })
})
