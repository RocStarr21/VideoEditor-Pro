import { ClientOnly, createFileRoute } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'

// The editor needs WebCodecs, Web Audio, WebGL and IndexedDB, so it only ever
// renders in the browser; lazy-loading also keeps media libraries out of SSR.
const Editor = lazy(() => import('../editor/ui/Editor'))

export const Route = createFileRoute('/')({ component: Home })

function Loading() {
  return (
    <div className="flex h-screen items-center justify-center bg-[#0f1115] text-sm text-zinc-400">
      <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
      Loading VideoEditor Pro…
    </div>
  )
}

function Home() {
  return (
    <ClientOnly fallback={<Loading />}>
      <Suspense fallback={<Loading />}>
        <Editor />
      </Suspense>
    </ClientOnly>
  )
}

export function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}
