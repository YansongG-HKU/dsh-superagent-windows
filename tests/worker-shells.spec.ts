/**
 * The worker environment reaches the children of worker Sessions without changing the host process's own environment.
 * These tests pin the attribution rules: a spawn belongs to a worker when its initiating Agent is a worker Session or its
 * directory is a ticket workspace, and every other spawn keeps the caller's environment.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec, SubprocessRuntime, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { agentGhConfig, workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { insideDirectory, scopeWorkerShells } from '../src/infra/worker-shells.ts'

const WINDOWS = process.platform === 'win32'
let stateDir: string
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'worker-shells-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

/** One spawn request as a shell tool makes it. */
const request = (cwd: string, env?: Record<string, string>): SubprocessSpawnSpec =>
  ({ argv: ['git', 'status'], cwd, graceMs: 1000, env, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: { maxBytes: 1 } } })
/** One terminal request as the terminal tool makes it. */
const terminal = (cwd: string): SubprocessTerminalSpawnSpec =>
  ({ argv: ['pwsh'], cwd, rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 1000 })

/** A subprocess service that records requests, plus the initiator the worker attribution sees. */
function harness() {
  const spawned: SubprocessSpawnSpec[] = []
  const terminals: SubprocessTerminalSpawnSpec[] = []
  const service = {
    spawn: (spec: SubprocessSpawnSpec) => { spawned.push(spec); return {} as never },
    spawnTerminal: (spec: SubprocessTerminalSpawnSpec) => { terminals.push(spec); return Promise.resolve({} as never) },
  }
  const original = { spawn: service.spawn, spawnTerminal: service.spawnTerminal }
  const initiator: { agent?: { id: string } } = {}
  const context = { subprocess: service, agents: { currentInitiator: () => initiator.agent } } as unknown as Context
  const dispose = scopeWorkerShells({ context, stateDir, executionRoot: () => join(stateDir, 'work') })
  return { service, original, spawned, terminals, initiator, dispose, as: () => context.subprocess as unknown as SubprocessRuntime }
}

describe('insideDirectory', () => {
  it('accepts the directory itself and its descendants, and nothing else', () => {
    const root = join(stateDir, 'work')
    expect(insideDirectory(root, root)).toBe(true)
    expect(insideDirectory(join(root, 'ticket'), root)).toBe(true)
    expect(insideDirectory(join(root, 'ticket', 'repo'), root)).toBe(true)
    expect(insideDirectory(join(stateDir, 'work-other'), root)).toBe(false)
    expect(insideDirectory(stateDir, root)).toBe(false)
    expect(insideDirectory(tmpdir(), root)).toBe(false)
  })
})

describe('scopeWorkerShells', () => {
  it('adds the worker environment to a spawn of a worker Session', () => {
    const box = harness()
    box.initiator.agent = { id: 'worker-t-7' }
    box.as().spawn(request(stateDir))
    expect(box.spawned).toHaveLength(1)
    expect(box.spawned[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
      ...WINDOWS ? { GH_CONFIG_DIR: agentGhConfig(stateDir) } : {} })
    expect(box.spawned[0]!.env!.PATH!.split(';').concat(box.spawned[0]!.env!.PATH!.split(':'))[0]).toBe(workerBin(stateDir))
  })

  it('leaves a spawn of the host Session, or of no attributable Session, untouched', () => {
    const box = harness()
    // The orchestrator Session drives the panel and its own tools: it keeps the host's git and GitHub identity.
    box.initiator.agent = { id: 'orchestrator-abc' }
    box.as().spawn(request(stateDir))
    // A caller outside any initiator boundary that is not in a ticket workspace also keeps its own environment.
    box.initiator.agent = undefined
    box.as().spawn(request(tmpdir()))
    for (const spec of box.spawned) expect(spec.env).toBeUndefined()
  })

  it('attributes a spawn by the ticket workspace when no initiator is active, as a worker shell started later is', () => {
    const box = harness()
    box.initiator.agent = undefined
    box.as().spawn(request(join(stateDir, 'work', 'fix-regression')))
    expect(box.spawned[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1' })
  })

  it('keeps an explicit environment of the caller, which already carries the worker values it wants', () => {
    const box = harness()
    box.initiator.agent = { id: 'worker-t-8' }
    box.as().spawn(request(stateDir, { GIT_CONFIG_GLOBAL: 'custom', GIT_CONFIG_NOSYSTEM: '0' }))
    expect(box.spawned[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: 'custom', GIT_CONFIG_NOSYSTEM: '0' })
  })

  it('restores the service spawn it wrapped, and never changes the host process environment', () => {
    const names = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GH_CONFIG_DIR'] as const
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]))
    const box = harness()
    expect(box.service.spawn).not.toBe(box.original.spawn)
    expect(box.service.spawnTerminal).not.toBe(box.original.spawnTerminal)
    box.initiator.agent = { id: 'worker-t-9' }
    box.as().spawn(request(stateDir))
    expect(box.service.spawn).not.toBe(box.original.spawn)
    box.dispose()
    expect(box.service.spawn).toBe(box.original.spawn)
    expect(box.service.spawnTerminal).toBe(box.original.spawnTerminal)
    expect(Object.fromEntries(names.map(name => [name, process.env[name]]))).toEqual(before)
  })

  it('adds the same environment to a terminal a worker Session opens, without the tombstones a request cannot carry', async () => {
    const box = harness()
    box.initiator.agent = { id: 'worker-t-10' }
    await box.as().spawnTerminal(terminal(stateDir))
    expect(box.terminals).toHaveLength(1)
    expect(box.terminals[0]!.env).toMatchObject({ GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1' })
    // A terminal request takes plain strings, so no tombstone (`undefined`) is passed for the variables the overlay clears.
    for (const value of Object.values(box.terminals[0]!.env ?? {})) expect(typeof value).toBe('string')
  })
})
