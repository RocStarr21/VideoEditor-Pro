/**
 * Vite plugin that serves the audio library under `/library/*` from the Vite
 * process in both `vite dev` and `vite preview`. It is registered ahead of the
 * Cloudflare plugin so these requests never reach the Workers emulator, where
 * yt-dlp and the file system do not exist.
 */
import { createReadStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import { Library } from './service'
import { postVideo, socialStatus, uploadForPost, type PostRequest } from './social'

const ID = /^[A-Za-z0-9_-]{11}$/
const MAX_BODY = 64 * 1024

type Next = (err?: unknown) => void

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

async function streamFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  const stat = await fs.stat(file)
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Cache-Control', 'no-cache')
  const range = req.headers.range
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  let start = 0
  let end = stat.size - 1
  if (m && (m[1] || m[2])) {
    start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]))
    end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : end
    if (start > end || start >= stat.size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${stat.size}`)
      return res.end()
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`)
  }
  res.setHeader('Content-Length', end - start + 1)
  if (req.method === 'HEAD') return res.end()
  createReadStream(file, { start, end }).pipe(res)
}

export function libraryServer(): Plugin {
  let lib: Library | null = null

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!lib) return sendJson(res, 503, { error: 'library not configured' })
    await lib.init()
    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.replace(/^\/library/, '') || '/'
    const method = req.method ?? 'GET'
    const mutating = method === 'POST' || method === 'DELETE'
    if (mutating) {
      // Same-origin only: a cross-site page cannot set a JSON content type without a preflight, which we never answer.
      if (req.headers['sec-fetch-site'] === 'cross-site') return sendJson(res, 403, { error: 'cross-site request refused' })
      // The video upload is raw bytes (a video/* type also forces a preflight cross-site).
      if (method === 'POST' && route !== '/social/upload' && !/^application\/json/i.test(String(req.headers['content-type'] ?? ''))) return sendJson(res, 415, { error: 'expected application/json' })
    }

    // Posting goes through the Social Planner → RocStarr Connect; see social.ts.
    if (route === '/social/status' && method === 'GET') return sendJson(res, 200, await socialStatus())
    if (route === '/social/upload' && method === 'POST') return sendJson(res, 200, await uploadForPost(req, url.searchParams.get('ext') ?? 'mp4'))
    if (route === '/social/post' && method === 'POST') {
      const body = (await readJson(req)) as unknown as PostRequest
      const result = await postVideo({ ...body, dryRun: body.dryRun === true })
      return sendJson(res, result.ok ? 200 : 400, result)
    }

    if (method === 'GET' && route === '/status') return sendJson(res, 200, lib.status())
    if (method === 'GET' && route === '/items') return sendJson(res, 200, lib.list())

    let m = /^\/items\/([^/]+)$/.exec(route)
    if (m && ID.test(m[1])) {
      const item = lib.get(m[1])
      if (!item) return sendJson(res, 404, { error: 'not in the library' })
      if (method === 'GET') return sendJson(res, 200, item)
      if (method === 'DELETE') return sendJson(res, 200, { ok: await lib.remove(item.id) })
    }

    m = /^\/audio\/([^/]+)$/.exec(route)
    if (m && ID.test(m[1]) && (method === 'GET' || method === 'HEAD')) {
      const item = lib.get(m[1])
      if (!item) return sendJson(res, 404, { error: 'not in the library' })
      return streamFile(req, res, lib.audioPath(item), item.mime)
    }

    if (route === '/youtube' && method === 'POST') {
      const body = await readJson(req)
      try {
        return sendJson(res, 202, lib.enqueue(String(body.url ?? '')))
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message })
      }
    }
    if (route === '/jobs' && method === 'GET') return sendJson(res, 200, lib.listJobs())
    m = /^\/jobs\/([0-9a-f-]{36})$/.exec(route)
    if (m && method === 'DELETE') return sendJson(res, 200, { ok: lib.dismiss(m[1]) })

    if (route === '/trash' && method === 'GET') return sendJson(res, 200, await lib.trash())
    if (route === '/trash' && method === 'DELETE') return sendJson(res, 200, { deleted: await lib.emptyTrash() })

    if (route === '/reveal' && method === 'POST') {
      const body = await readJson(req)
      lib.reveal(body.target === 'trash' ? 'trash' : 'audio')
      return sendJson(res, 200, { ok: true })
    }
    if (route === '/update' && method === 'POST') return sendJson(res, 200, await lib.update())

    return sendJson(res, 404, { error: 'not found' })
  }

  const middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => {
    if (!req.url?.startsWith('/library/')) return next()
    handle(req, res).catch((err: Error) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message })
      else res.end()
    })
  }

  return {
    name: 've-library-server',
    enforce: 'pre',
    configResolved(config) {
      const root = process.env.VIDEOEDITOR_PRO_LIBRARY || path.resolve(config.root, '../../library')
      lib = new Library(root)
    },
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
