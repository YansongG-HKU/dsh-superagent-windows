/**
 * Linux verification stand-in for the Superagent panel.
 *
 * Serves the real React panel and the management routes the panel calls by invoking the
 * same view functions as src/app/http.ts (stateView, overview, search, ticketList, ticketDetail,
 * sourcesStatus, ClusterAdmin). It does not start DeepSeek Harness, poll GitHub, or run setup.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClusterAdmin } from '../../../../src/app/cluster.ts'
import { sameOrigin, stateView, type HttpHost } from '../../../../src/app/http.ts'
import { Store } from '../../../../src/app/store.ts'
import { sourcesStatus } from '../../../../src/app/views/sources.ts'
import { overview } from '../../../../src/app/views/overview.ts'
import { search } from '../../../../src/app/views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from '../../../../src/app/views/tickets.ts'
import { TICKET_FILTERS, type TicketFilter } from '../../../../src/app/api.ts'
import { threadKey, type Ticket } from '../../../../src/core/model.ts'
import { policyVersion, type Settings } from '../../../../src/policy.ts'
import { githubLink } from '../../../../src/sources/github-channel.ts'
import { githubKind } from '../../../../src/sources/github.ts'
import { SourceRegistry } from '../../../../src/sources/registry.ts'
import type { ChannelRef } from '../../../../src/core/model.ts'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_SUPERAGENT_VERIFY_HOME
const repo = process.env.DSH_SUPERAGENT_VERIFY_REPO
const port = Number(process.env.DSH_SUPERAGENT_VERIFY_PORT)
const clusterConfig = process.env.DSH_SUPERAGENT_CLUSTER_CONFIG
if (!home || !repo || !clusterConfig || !Number.isInteger(port) || port < 1) {
  throw new Error('stand-in server needs DSH_SUPERAGENT_VERIFY_HOME, DSH_SUPERAGENT_VERIFY_REPO, DSH_SUPERAGENT_VERIFY_PORT, and DSH_SUPERAGENT_CLUSTER_CONFIG')
}
const stateDir = join(home, 'state')
const ghCli = process.env.DSH_SUPERAGENT_VERIFY_GH ?? 'gh'
const store = new Store(join(stateDir, 'orchestrator.sqlite'))
const sources = new SourceRegistry(() => store.settings())
sources.register(githubKind)
const links = (channel: ChannelRef) => githubLink(channel.address, {})
const host = { store, sources, links }
const noLinks = { entries: () => [] as Iterable<[string, string]> }
const cluster = new ClusterAdmin({ toolPath: join(repo, 'tools', 'cluster.mjs'), configPath: clusterConfig })

function seed(): void {
  if (store.tickets.get('ticket-release')) return
  const releaseAt = new Date().toISOString()
  const groceryAt = new Date(Date.now() - 60_000).toISOString()
  const budgetAt = new Date(Date.now() - 30_000).toISOString()
  store.saveSettings({
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: ghCli } } },
    policy: { sources: { github: { allowed: [{ id: 'operator' }] } } },
  })
  const mandate = {
    strength: 'explicit' as const, policyVersion: 'verify-seed',
    basis: { via: 'listed' as const, source: 'github', sender: 'operator' },
    actor: { source: 'github', id: 'operator' }, scope: '',
  }
  store.threads.save({
    key: threadKey({ source: 'github', id: '42' }), ref: { source: 'github', id: '42' }, createdAt: budgetAt,
    subscriptions: ['ticket-release'], correlated: [], pending: [], meta: { label: '#42' },
  })
  store.triggers.save({
    id: 'tr-budget', source: 'github', threads: [{ source: 'github', id: '42' }],
    actor: { source: 'github', id: 'operator' }, human: true, at: budgetAt, text: 'Draft budget', meta: { kind: 'comment' },
  })
  const ticket = (id: string, title: string, at: string, extra: Partial<Ticket>): Ticket => ({
    id, title, decisionId: 'decision-seed', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'tr-budget', triggerIds: ['tr-budget'] }, assignments: [], inputs: [], ...extra,
  })
  store.tickets.save(ticket('ticket-release', 'Release checklist', releaseAt, {
    attention: { id: 'att-release', question: 'Confirm the release checklist', triggerId: 'tr-budget' },
    assignments: [{ id: 'asg-release', state: 'running', createdAt: releaseAt, startedAt: releaseAt }],
  }))
  store.tickets.save(ticket('ticket-grocery', 'Grocery list', groceryAt, {
    origin: { triggerId: 'tr-grocery', triggerIds: ['tr-grocery'] },
    assignments: [{ id: 'asg-grocery', state: 'running', createdAt: groceryAt, startedAt: groceryAt }],
  }))
}
seed()

const packageVersion = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version as string
const volatile = (value: number) => ({ get: () => value })
const runtime = {
  store, masterId: '', executor: { activeCount: () => 0 },
  health: { runtime: { state: 'ready' as const, detail: 'Linux verification stand-in is serving the panel. GitHub is not being polled and setup was not run.' } },
  machine: { stateDir, promptMaxChars: volatile(100000), admissionContextMaxPages: volatile(10), admissionContextTimeoutMs: volatile(15000) },
  configured: () => false, setupProblem: undefined, feishuProblem: undefined,
} as unknown as HttpHost

function send(res: ServerResponse, status: number, value: unknown, type = 'application/json; charset=utf-8'): void {
  const body = type.startsWith('application/json') ? JSON.stringify(value) : String(value)
  res.writeHead(status, {
    'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'x-dsh-superagent-verify': 'linux-stand-in',
  })
  res.end(body)
}
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', chunk => {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 128 * 1024) reject(new Error('Request exceeds 128KB'))
      else chunks.push(bytes)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown) }
      catch { reject(new Error('The request body is not JSON')) }
    })
    req.on('error', reject)
  })
}
function ticketFilter(value: string | undefined): TicketFilter {
  return TICKET_FILTERS.find(item => item === value) ?? 'open'
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Superagent ${packageVersion} verification stand-in</title>
  <link rel="stylesheet" href="/tokens.css" />
</head>
<body>
  <p id="verify-banner" data-surface="dsh-superagent-linux-stand-in">dsh-superagent ${packageVersion} · Linux verification stand-in · not the Windows DSH Desktop host</p>
  <div id="root"></div>
  <script src="/panel.js"></script>
</body>
</html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') { send(res, 200, html, 'text/html; charset=utf-8'); return }
    if (req.method === 'GET' && url.pathname === '/tokens.css') {
      send(res, 200, readFileSync(join(SCRIPT_DIR, 'tokens.css'), 'utf8'), 'text/css; charset=utf-8'); return
    }
    if (req.method === 'GET' && url.pathname === '/panel.js') {
      send(res, 200, readFileSync(join(home, 'panel.js'), 'utf8'), 'text/javascript; charset=utf-8'); return
    }
    if (!url.pathname.startsWith('/orchestrator/api/')) { send(res, 404, { error: 'Not found' }); return }
    if (!sameOrigin(req, port)) { send(res, 403, { error: 'Same-origin management request required' }); return }
    const path = url.pathname.slice('/orchestrator/api/'.length)
    const query = Object.fromEntries(url.searchParams)
    if (req.method === 'GET' && path === 'state') { send(res, 200, stateView(runtime)); return }
    if (req.method === 'GET' && path === 'overview') {
      const settings = store.settings()
      send(res, 200, overview(host, runtime.health, policyVersion(settings), { ...executorLoad(store, 0), maxWorkers: settings.executor.maxWorkers }))
      return
    }
    if (req.method === 'GET' && path === 'search') { send(res, 200, search(host, query.q ?? '', noLinks)); return }
    if (req.method === 'GET' && path === 'sources') { send(res, 200, sourcesStatus(host, runtime.health, {})); return }
    if (req.method === 'GET' && path === 'tickets') {
      const offset = Number(query.offset ?? 0)
      const limit = Math.min(1000, Number(query.limit ?? 20) || 20)
      send(res, 200, ticketList(host, ticketFilter(query.state), Number.isFinite(offset) ? offset : 0, limit))
      return
    }
    const ticket = /^tickets\/([^/]+)$/.exec(path)
    if (req.method === 'GET' && ticket) {
      const page = ticketDetail(host, decodeURIComponent(ticket[1]!))
      if (!page) { send(res, 404, { error: 'Ticket not found' }); return }
      send(res, 200, { ...page, environment: [] })
      return
    }
    if (req.method === 'GET' && path === 'cluster') { send(res, 200, await cluster.view()); return }
    if (req.method === 'POST' && path === 'executor/pause') {
      const body = await readBody(req) as { paused?: boolean }
      if (typeof body.paused !== 'boolean') { send(res, 400, { error: 'paused must be boolean' }); return }
      const old: Settings = store.settings()
      if (old.paused !== body.paused) {
        store.saveSettings({ ...old, paused: body.paused }, {
          source: 'panel', block: 'pause', policyVersion: policyVersion(old), policyChanged: false, notified: [],
        })
      }
      // No DSH Session is attached, so the main Session is not notified and Sources do not change behavior.
      send(res, 200, { paused: body.paused, sessionNotified: false })
      return
    }
    if (req.method === 'POST' && path === 'cluster/instances') {
      const body = await readBody(req) as { repository?: string; name?: string }
      const operation = await cluster.provision({ repository: String(body.repository ?? ''), ...body.name ? { name: body.name } : {} })
      send(res, 200, { operation })
      return
    }
    const clusterName = /^cluster\/instances\/([^/]+)\/(start|stop)$/.exec(path)
    if (req.method === 'POST' && clusterName) {
      const name = decodeURIComponent(clusterName[1]!)
      const operation = clusterName[2] === 'start' ? await cluster.start(name) : await cluster.stop(name)
      send(res, 200, { operation })
      return
    }
    send(res, 404, { error: 'Unknown operation' })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) send(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`verify-dsh-superagent ready http://127.0.0.1:${port}`)
})
const shutdown = () => { server.close(); store.close(); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
