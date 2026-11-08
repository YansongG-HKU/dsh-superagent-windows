/**
 * Routes the worker environment to the subprocesses a worker Session spawns, without writing anything into `process.env`.
 *
 * Workers are in-process DSH Sessions, so their shell tools call the shared `ctx.subprocess` service, which starts every
 * child from the host's own environment. The prototype used to mutate `process.env` for that reason, which leaked the
 * agent's git and GitHub identity into every Session of the host process. This decorator instead adds the environment to
 * the spawn requests that belong to a worker: one whose initiating Agent is a worker Session (`worker-<ticketId>`), or one
 * whose working directory is a ticket workspace. Every other spawn, including the host's own tools, keeps its environment.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { isAbsolute, relative } from 'node:path'
import { workerEnvironment } from './environment.ts'

/** True when `cwd` is `root` itself or a directory below it. */
export function insideDirectory(cwd: string, root: string): boolean {
  const path = relative(root, cwd)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** The prefix of a worker Session id, which `DshExecutor` mints per ticket. */
const WORKER_SESSION = 'worker-'

export interface WorkerShellScope {
  /** The plugin's Cordis context, whose `subprocess` service every shell tool spawns through. */
  readonly context: Context
  /** The state directory the worker environment is derived from. */
  readonly stateDir: string
  /** The current execution root: ticket workspaces live below it. */
  readonly executionRoot: () => string
}

/**
 * Adds the worker environment to spawn requests that belong to a worker Session, and returns the disposer restoring the
 * service's own `spawn`. Attribution is deliberately conservative: a spawn that cannot be attributed to a worker keeps the
 * host's environment, so the host never acts as the agent account by accident.
 */
export function scopeWorkerShells({ context, stateDir, executionRoot }: WorkerShellScope): () => void {
  const service = context.subprocess
  const originalSpawn = service.spawn
  const originalTerminal = service.spawnTerminal
  const environment = workerEnvironment(stateDir)
  const belongsToWorker = (spec: SubprocessSpawnSpec | SubprocessTerminalSpawnSpec): boolean => {
    try {
      const agent = context.agents.currentInitiator()
      if (agent && String(agent.id).startsWith(WORKER_SESSION)) return true
    } catch { /* No initiator boundary is active for this caller. */ }
    return insideDirectory(spec.cwd, executionRoot())
  }
  // A terminal request takes plain string values (no tombstones), so the overlay is filtered to the values it defines.
  const defined = (): Record<string, string> => Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
  try {
    service.spawn = function spawn(this: { spawn: typeof originalSpawn }, spec: SubprocessSpawnSpec) {
      return originalSpawn.call(this, belongsToWorker(spec) ? { ...spec, env: { ...environment, ...spec.env } } : spec)
    }
    service.spawnTerminal = function spawnTerminal(this: { spawnTerminal: typeof originalTerminal }, spec: SubprocessTerminalSpawnSpec) {
      return originalTerminal.call(this, belongsToWorker(spec) ? { ...spec, env: { ...defined(), ...spec.env } } : spec)
    }
  } catch (error) {
    // A frozen or proxied service keeps its own spawn: workers then run without the account binding instead of the plugin
    // failing to load. The warning names the reason so a host whose service cannot be wrapped is visible in the log.
    context.logger?.warn('dsh-superagent cannot scope the worker environment to worker spawns: %s', String(error))
    return () => {}
  }
  return () => { service.spawn = originalSpawn; service.spawnTerminal = originalTerminal }
}
