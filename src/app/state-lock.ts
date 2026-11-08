import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { lock } from 'proper-lockfile'

/** Bound startup recovery without stealing a live lock or blocking the event loop. */
export async function acquireStateLock(dir: string, options: {
  signal: AbortSignal; timeoutMs?: number; retryMs?: number;
  onWait?: () => void; onCompromised: (error: Error) => void;
}): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + (options.timeoutMs ?? 35_000)
  let notified = false
  for (;;) {
    options.signal.throwIfAborted()
    try {
      const release = await lock(dir, { stale: 30_000, onCompromised: options.onCompromised })
      if (options.signal.aborted) { await release(); options.signal.throwIfAborted() }
      return release
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error
      if (Date.now() >= deadline) throw new Error('Superagent state directory remains locked after startup recovery deadline', { cause: error })
      if (!notified) { notified = true; options.onWait?.() }
      await delay(Math.min(options.retryMs ?? 250, Math.max(1, deadline - Date.now())), undefined, { signal: options.signal })
    }
  }
}
