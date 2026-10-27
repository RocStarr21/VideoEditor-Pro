/**
 * Audio library behind the YouTube import. The SSR bundle runs inside the
 * Workers emulator and has no file system, so this lives in the Vite process
 * itself (see plugin.ts): yt-dlp downloads the video, ffmpeg lifts the audio
 * out into `library/audio` (available to every project), and the video it came
 * from is parked in `library/To Be Deleted` for the user to clear out.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseDownloadProgress, parseYouTubeUrl, safeFileName } from './util'

export interface LibraryItem {
  /** YouTube video id; importing the same video again replaces the entry. */
  id: string
  title: string
  uploader?: string
  url: string
  duration: number
  fileName: string
  mime: string
  size: number
  /** Name of the source video inside "To Be Deleted", while it is still there. */
  videoFile?: string
  thumbnail?: string
  addedAt: number
}

export type JobStatus = 'queued' | 'downloading' | 'extracting' | 'done' | 'error' | 'cancelled'

export interface LibraryJob {
  id: string
  url: string
  videoId: string
  status: JobStatus
  /** Download progress 0..1. */
  progress: number
  title?: string
  thumbnail?: string
  message?: string
  itemId?: string
  startedAt: number
  finishedAt?: number
}

export interface LibraryStatus {
  ok: true
  dir: string
  audioDir: string
  trashDir: string
  ytdlp: { command: string; version: string } | null
  ffmpeg: string | null
}

export interface TrashInfo {
  files: Array<{ name: string; size: number; modifiedAt: number }>
  total: number
}

interface Tools {
  ytdlp: { command: string[]; version: string } | null
  ffmpeg: string | null
  ffprobe: string | null
}

const INDEX_VERSION = 1
const MAX_JOBS = 20
/** Best mp4 up to 1080p with AAC audio, so the extraction is a lossless stream copy; falls back to whatever exists. */
const FORMAT = 'bv*[ext=mp4][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*+ba/b'

const winGetLinks = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : null

function runs(command: string[], args: string[]): string | null {
  const [bin, ...rest] = command
  try {
    const r = spawnSync(bin, [...rest, ...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    return r.status === 0 ? r.stdout : null
  } catch {
    return null
  }
}

/** yt-dlp's --ffmpeg-location wants a real path, not a name on PATH. */
function absolutePath(cmd: string): string | null {
  if (path.isAbsolute(cmd)) return cmd
  const out = runs([process.platform === 'win32' ? 'where' : 'which'], [cmd])
  const first = out
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  return first && path.isAbsolute(first) ? first : null
}

function resolveTools(): Tools {
  const ytCandidates: string[][] = []
  if (process.env.VIDEOEDITOR_PRO_YTDLP) ytCandidates.push(process.env.VIDEOEDITOR_PRO_YTDLP.split(/\s+/))
  ytCandidates.push(['yt-dlp'])
  if (winGetLinks) ytCandidates.push([path.join(winGetLinks, 'yt-dlp.exe')])
  ytCandidates.push(['python', '-m', 'yt_dlp'], ['python3', '-m', 'yt_dlp'], ['py', '-3', '-m', 'yt_dlp'])
  let ytdlp: Tools['ytdlp'] = null
  for (const command of ytCandidates) {
    const out = runs(command, ['--version'])
    if (out) {
      ytdlp = { command, version: out.trim().split(/\r?\n/)[0] }
      break
    }
  }
  const ff = (name: 'ffmpeg' | 'ffprobe') => {
    const candidates: string[] = []
    if (process.env.VIDEOEDITOR_PRO_FFMPEG_DIR) candidates.push(path.join(process.env.VIDEOEDITOR_PRO_FFMPEG_DIR, name))
    candidates.push(name)
    if (winGetLinks) candidates.push(path.join(winGetLinks, `${name}.exe`))
    const found = candidates.find((c) => runs([c], ['-version']) !== null)
    return found ? (absolutePath(found) ?? found) : null
  }
  return { ytdlp, ffmpeg: ff('ffmpeg'), ffprobe: ff('ffprobe') }
}

function lastErrorLine(stderr: string, code: number | null): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const err = [...lines].reverse().find((l) => /^ERROR[: ]/i.test(l) || /error/i.test(l))
  const line = err ?? lines[lines.length - 1]
  return (line ?? `exited with code ${code}`).replace(/^ERROR:\s*(\[\w+\]\s*)?/i, '').slice(0, 400)
}

async function moveReplace(from: string, to: string) {
  await fs.rm(to, { force: true })
  try {
    await fs.rename(from, to)
  } catch {
    await fs.copyFile(from, to)
    await fs.rm(from, { force: true })
  }
}

export class Library {
  readonly dir: string
  readonly audioDir: string
  readonly trashDir: string
  private readonly workDir: string
  private readonly indexFile: string
  private items = new Map<string, LibraryItem>()
  private jobs: LibraryJob[] = []
  private processes = new Map<string, ChildProcess>()
  private running: LibraryJob | null = null
  private tools: Tools | null = null
  private ready: Promise<void> | null = null

  constructor(root: string) {
    this.dir = root
    this.audioDir = path.join(root, 'audio')
    this.trashDir = path.join(root, 'To Be Deleted')
    this.workDir = path.join(root, '.work')
    this.indexFile = path.join(root, 'library.json')
  }

  init(): Promise<void> {
    this.ready ??= (async () => {
      await Promise.all([this.audioDir, this.trashDir, this.workDir].map((d) => fs.mkdir(d, { recursive: true })))
      // Half-finished downloads from a previous run are worthless; start clean.
      for (const entry of await fs.readdir(this.workDir)) await fs.rm(path.join(this.workDir, entry), { recursive: true, force: true })
      await this.load()
    })()
    return this.ready
  }

  private async load() {
    let raw: { version?: number; items?: LibraryItem[] } = {}
    try {
      raw = JSON.parse(await fs.readFile(this.indexFile, 'utf8'))
    } catch {
      /* first run */
    }
    this.items.clear()
    let dirty = false
    for (const item of raw.items ?? []) {
      // Drop entries whose audio was deleted by hand; forget videos already cleared out.
      try {
        const stat = await fs.stat(path.join(this.audioDir, item.fileName))
        const next = { ...item, size: stat.size }
        if (next.videoFile) {
          try {
            await fs.access(path.join(this.trashDir, next.videoFile))
          } catch {
            delete next.videoFile
            dirty = true
          }
        }
        this.items.set(next.id, next)
      } catch {
        dirty = true
      }
    }
    if (dirty) await this.save()
  }

  private async save() {
    const data = { version: INDEX_VERSION, items: this.list() }
    await fs.writeFile(this.indexFile, JSON.stringify(data, null, 2))
  }

  getTools(refresh = false): Tools {
    if (!this.tools || refresh) this.tools = resolveTools()
    return this.tools
  }

  status(): LibraryStatus {
    const tools = this.getTools()
    return {
      ok: true,
      dir: this.dir,
      audioDir: this.audioDir,
      trashDir: this.trashDir,
      ytdlp: tools.ytdlp ? { command: tools.ytdlp.command.join(' '), version: tools.ytdlp.version } : null,
      ffmpeg: tools.ffmpeg,
    }
  }

  list(): LibraryItem[] {
    return [...this.items.values()].sort((a, b) => b.addedAt - a.addedAt)
  }

  get(id: string): LibraryItem | undefined {
    return this.items.get(id)
  }

  audioPath(item: LibraryItem): string {
    return path.join(this.audioDir, item.fileName)
  }

  async remove(id: string): Promise<boolean> {
    const item = this.items.get(id)
    if (!item) return false
    await fs.rm(this.audioPath(item), { force: true })
    this.items.delete(id)
    await this.save()
    return true
  }

  async trash(): Promise<TrashInfo> {
    const files: TrashInfo['files'] = []
    for (const name of await fs.readdir(this.trashDir)) {
      const stat = await fs.stat(path.join(this.trashDir, name))
      if (stat.isFile()) files.push({ name, size: stat.size, modifiedAt: stat.mtimeMs })
    }
    files.sort((a, b) => b.modifiedAt - a.modifiedAt)
    return { files, total: files.reduce((n, f) => n + f.size, 0) }
  }

  async emptyTrash(): Promise<number> {
    const { files } = await this.trash()
    for (const f of files) await fs.rm(path.join(this.trashDir, f.name), { force: true })
    let dirty = false
    for (const item of this.items.values()) {
      if (item.videoFile) {
        delete item.videoFile
        dirty = true
      }
    }
    if (dirty) await this.save()
    return files.length
  }

  reveal(target: 'audio' | 'trash') {
    const dir = target === 'trash' ? this.trashDir : this.audioDir
    const [bin, args] = process.platform === 'win32' ? ['explorer.exe', [dir]] : process.platform === 'darwin' ? ['open', [dir]] : ['xdg-open', [dir]]
    spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  listJobs(): LibraryJob[] {
    return [...this.jobs].reverse()
  }

  enqueue(input: string): LibraryJob {
    const parsed = parseYouTubeUrl(input)
    if (!parsed) throw new Error('That is not a YouTube video link.')
    const active = this.jobs.find((j) => j.videoId === parsed.id && (j.status === 'queued' || j.status === 'downloading' || j.status === 'extracting'))
    if (active) return active
    const job: LibraryJob = { id: randomUUID(), url: parsed.url, videoId: parsed.id, status: 'queued', progress: 0, startedAt: Date.now() }
    this.jobs.push(job)
    while (this.jobs.length > MAX_JOBS) {
      const i = this.jobs.findIndex((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled')
      if (i < 0) break
      this.jobs.splice(i, 1)
    }
    void this.pump()
    return job
  }

  /** Cancels a running/queued job, or forgets a finished one. */
  dismiss(id: string): boolean {
    const job = this.jobs.find((j) => j.id === id)
    if (!job) return false
    if (job.status === 'queued' || job.status === 'downloading' || job.status === 'extracting') {
      job.status = 'cancelled'
      job.finishedAt = Date.now()
      const child = this.processes.get(job.id)
      if (child?.pid) {
        // yt-dlp spawns ffmpeg for the merge, so take the tree down, by this exact pid.
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
        else child.kill('SIGTERM')
      }
      return true
    }
    this.jobs = this.jobs.filter((j) => j !== job)
    return true
  }

  private async pump() {
    if (this.running) return
    const next = this.jobs.find((j) => j.status === 'queued')
    if (!next) return
    this.running = next
    try {
      await this.run(next)
    } catch (err) {
      if (next.status !== 'cancelled') {
        next.status = 'error'
        next.message = (err as Error).message
      }
    } finally {
      next.finishedAt = Date.now()
      this.running = null
      await fs.rm(path.join(this.workDir, next.id), { recursive: true, force: true }).catch(() => {})
      void this.pump()
    }
  }

  private async run(job: LibraryJob) {
    await this.init()
    const tools = this.getTools()
    if (!tools.ytdlp) throw new Error('yt-dlp is not installed. In PowerShell: python -m pip install -U yt-dlp')
    if (!tools.ffmpeg || !tools.ffprobe) throw new Error('ffmpeg is not installed (winget install Gyan.FFmpeg)')
    const dir = path.join(this.workDir, job.id)
    await fs.mkdir(dir, { recursive: true })
    const ffmpegLocation = path.isAbsolute(tools.ffmpeg) ? ['--ffmpeg-location', tools.ffmpeg] : []
    const ytdlp = [...tools.ytdlp.command, '--no-playlist', '--no-colors', ...ffmpegLocation, '--js-runtimes', `node:${process.execPath}`]

    job.status = 'downloading'
    job.message = 'Looking up video…'
    const meta = await this.exec(job, [...ytdlp, '--skip-download', '--dump-single-json', job.url], { timeout: 120_000 })
    const jsonLine = meta.stdout
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.startsWith('{'))
    if (!jsonLine) throw new Error('yt-dlp returned no video details')
    const info = JSON.parse(jsonLine) as { id: string; title?: string; duration?: number; uploader?: string; channel?: string; thumbnail?: string; webpage_url?: string }
    job.title = info.title ?? job.videoId
    job.thumbnail = info.thumbnail
    job.message = 'Downloading…'

    await this.exec(
      job,
      [...ytdlp, '--newline', '--progress', '--print', 'after_move:filepath', '-f', FORMAT, '--merge-output-format', 'mp4', '--no-mtime', '-o', path.join(dir, '%(id)s.%(ext)s'), job.url],
      {
        onLine: (line) => {
          const p = parseDownloadProgress(line)
          if (p !== null) job.progress = p
          else if (line.startsWith('[Merger]')) job.message = 'Merging…'
        },
      },
    )
    const downloaded = (await fs.readdir(dir)).filter((f) => !/\.(part|ytdl|temp)$/i.test(f))
    // yt-dlp names unmerged streams `<id>.f<format>.<ext>`; the merged file has no format tag.
    const isStream = (f: string) => /\.f\d+\./i.test(f)
    const merged = downloaded.find((f) => !isStream(f) && /\.(mp4|mkv|webm|mov)$/i.test(f))
    let source: string
    let videoName: string | undefined
    if (merged) {
      source = videoName = merged
    } else {
      // No merge happened (ffmpeg unreachable for yt-dlp): the audio-only stream is all we need anyway.
      const audioOnly = downloaded.find((f) => isStream(f) && /\.(m4a|webm|opus|mp3|aac|ogg)$/i.test(f))
      if (!audioOnly) throw new Error('download finished but no file was written')
      source = audioOnly
      videoName = downloaded.find((f) => isStream(f) && f !== audioOnly && /\.(mp4|mkv|webm|mov)$/i.test(f))
    }
    const sourcePath = path.join(dir, source)

    job.status = 'extracting'
    job.progress = 1
    job.message = 'Extracting audio…'
    const probe = await this.exec(job, [tools.ffprobe, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', sourcePath])
    const codec = probe.stdout.trim().split(/\r?\n/)[0] ?? ''
    if (!codec) throw new Error('this video has no audio track')
    const audioTmp = path.join(dir, `${info.id}.audio.m4a`)
    // AAC already: a stream copy is instant and lossless. Anything else gets encoded once.
    const codecArgs = codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']
    await this.exec(job, [tools.ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath, '-vn', ...codecArgs, '-movflags', '+faststart', audioTmp])
    const durationOut = await this.exec(job, [tools.ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioTmp])
    const duration = Number(durationOut.stdout.trim()) || info.duration || 0

    const stem = `${safeFileName(job.title)} [${info.id}]`
    const audioFile = `${stem}.m4a`
    const videoFile = videoName ? `${stem}${path.extname(videoName).toLowerCase()}` : undefined
    await moveReplace(audioTmp, path.join(this.audioDir, audioFile))
    if (videoName && videoFile) await moveReplace(path.join(dir, videoName), path.join(this.trashDir, videoFile))
    const size = (await fs.stat(path.join(this.audioDir, audioFile))).size

    const previous = this.items.get(info.id)
    if (previous && previous.fileName !== audioFile) await fs.rm(path.join(this.audioDir, previous.fileName), { force: true })
    const item: LibraryItem = {
      id: info.id,
      title: job.title,
      uploader: info.uploader ?? info.channel,
      url: info.webpage_url ?? job.url,
      duration,
      fileName: audioFile,
      mime: 'audio/mp4',
      size,
      videoFile,
      thumbnail: info.thumbnail,
      addedAt: Date.now(),
    }
    this.items.set(item.id, item)
    await this.save()
    job.itemId = item.id
    job.status = 'done'
    job.message = undefined
  }

  private exec(job: LibraryJob, command: string[], opts: { timeout?: number; onLine?: (line: string) => void } = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (job.status === 'cancelled') return reject(new Error('cancelled'))
      const [bin, ...args] = command
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      this.processes.set(job.id, child)
      let stdout = ''
      let stderr = ''
      let pending = ''
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdout += text
        if (!opts.onLine) return
        pending += text
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) opts.onLine(line)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8000)
      })
      const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null
      const done = () => {
        if (timer) clearTimeout(timer)
        this.processes.delete(job.id)
      }
      child.on('error', (err) => {
        done()
        reject(err)
      })
      child.on('close', (code) => {
        done()
        if (job.status === 'cancelled') reject(new Error('cancelled'))
        else if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(lastErrorLine(stderr, code)))
      })
    })
  }

  /** `pip install -U yt-dlp` or `yt-dlp -U`, whichever matches how it was found. YouTube changes often enough that this matters. */
  async update(): Promise<{ version: string | null; output: string }> {
    const tools = this.getTools()
    let command: string[]
    if (!tools.ytdlp) command = ['python', '-m', 'pip', 'install', '-U', 'yt-dlp']
    else if (tools.ytdlp.command.includes('yt_dlp')) command = [tools.ytdlp.command[0], '-m', 'pip', 'install', '-U', 'yt-dlp']
    else command = [...tools.ytdlp.command, '-U']
    const r = spawnSync(command[0], command.slice(1), { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-4).join('\n')
    const fresh = this.getTools(true)
    return { version: fresh.ytdlp?.version ?? null, output }
  }
}
