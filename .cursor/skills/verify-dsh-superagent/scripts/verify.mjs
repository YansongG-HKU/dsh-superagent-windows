#!/usr/bin/env node
/**
 * Verification harness for the dsh-superagent Superagent panel.
 * Run from anywhere; paths in --path are relative to the current working directory.
 *
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs launch
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs doctor
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs browser <command>
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs api GET <path>
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs records
 *   .cursor/skills/verify-dsh-superagent/scripts/verify.mjs cleanup
 */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = resolve(SCRIPT_DIR, '..')
const REPO = resolve(SCRIPT_DIR, '../../../..')
const POINTER = join(SKILL_DIR, '.run', 'home')
const DEFAULT_HOME = '/tmp/dsh-superagent-verify'
const DEFAULT_PORT = 4173
const HEADER = { 'x-orchestrator-request': '1' }

function homePath() {
  if (process.env.DSH_SUPERAGENT_VERIFY_HOME) return process.env.DSH_SUPERAGENT_VERIFY_HOME
  if (existsSync(POINTER)) return readFileSync(POINTER, 'utf8').trim()
  return DEFAULT_HOME
}
function controlPath(home = homePath()) { return join(home, 'control.json') }
function readControl() {
  const file = controlPath()
  if (!existsSync(file)) throw new Error(`No verification instance at ${file}. Run launch first.`)
  return JSON.parse(readFileSync(file, 'utf8'))
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function which(name) {
  const result = spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}
function outPath(value) {
  if (!value) return ''
  return isAbsolute(value) ? value : resolve(process.cwd(), value)
}
function writeOut(file, text) {
  if (!file) { process.stdout.write(text.endsWith('\n') ? text : text + '\n'); return }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.endsWith('\n') ? text : text + '\n')
}
function arg(name, argv = process.argv.slice(3)) {
  const index = argv.indexOf(name)
  if (index < 0 || index + 1 >= argv.length) return ''
  return argv[index + 1]
}
function listeningInodes(port) {
  const inodes = []
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 10) continue
      const portHex = parts[1].split(':')[1]
      if (portHex && Number.parseInt(portHex, 16) === port && parts[3] === '0A') inodes.push(parts[9])
    }
  }
  return inodes
}
function ownsInodes(pid, inodes) {
  let fds = []
  try { fds = readdirSync(`/proc/${pid}/fd`) } catch { return false }
  return fds.some(fd => {
    try {
      const match = /socket:\[(\d+)\]/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))
      return match ? inodes.includes(match[1]) : false
    } catch { return false }
  })
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000), headers: { ...HEADER, ...options.headers } })
  const text = await response.text()
  let body
  try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
  return { status: response.status, headers: response.headers, body }
}
function chromeBin() {
  if (existsSync('/opt/google/chrome/chrome')) return '/opt/google/chrome/chrome'
  const found = which('google-chrome') || which('google-chrome-stable')
  if (!found) throw new Error('google-chrome is not installed')
  return found
}

async function ensureEsbuild(home) {
  const pkg = join(home, 'esbuild', 'node_modules', 'esbuild', 'package.json')
  if (!existsSync(pkg)) {
    mkdirSync(join(home, 'esbuild'), { recursive: true })
    const install = spawnSync('npm', ['install', '--prefix', join(home, 'esbuild'), 'esbuild@0.25.12', '--no-fund', '--no-audit'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (install.status !== 0) throw new Error(`esbuild install failed:\n${install.stderr || install.stdout}`)
  }
  const require = createRequire(join(home, 'esbuild', 'node_modules', 'esbuild', 'package.json'))
  return require('esbuild')
}
async function bundlePanel(home) {
  const esbuild = await ensureEsbuild(home)
  await esbuild.build({
    absWorkingDir: REPO,
    entryPoints: [join(SCRIPT_DIR, 'panel-entry.tsx')],
    outfile: join(home, 'panel.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [{
      name: 'raw-text',
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, args => ({
          path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
          namespace: 'raw-text',
        }))
        build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async args => {
          const { readFile } = await import('node:fs/promises')
          return { contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`, loader: 'js' }
        })
      },
    }],
  })
}
function runTool(args) {
  const result = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8' })
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `exit ${result.status}`).trim())
  return result.stdout
}

async function launch() {
  const dsh = which('dsh')
  if (dsh && process.env.DSH_SUPERAGENT_VERIFY_STAND_IN !== '1') {
    console.error(`dsh is on PATH (${dsh}). Refusing the Linux stand-in.`)
    console.error('Start the real service with: scripts/dsh-superagent start')
    console.error('Set DSH_SUPERAGENT_VERIFY_STAND_IN=1 only to force the stand-in.')
    process.exit(2)
  }
  const home = process.env.DSH_SUPERAGENT_VERIFY_HOME || DEFAULT_HOME
  const port = Number(process.env.DSH_SUPERAGENT_VERIFY_PORT || DEFAULT_PORT)
  if (existsSync(home)) {
    const existing = existsSync(controlPath(home)) ? JSON.parse(readFileSync(controlPath(home), 'utf8')) : null
    if (existing && alive(existing.pid)) throw new Error(`Instance already running (pid ${existing.pid}) at ${home}. Refusing to start another.`)
    throw new Error(`${home} already exists. Run cleanup before launching again.`)
  }
  if (listeningInodes(port).length) throw new Error(`Port ${port} is already in use. Refusing to start.`)
  if (!existsSync(join(REPO, 'node_modules', 'zod', 'package.json'))) {
    const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], { cwd: REPO, encoding: 'utf8' })
    if (install.status !== 0) throw new Error(install.stderr || install.stdout || 'pnpm install failed')
  }
  mkdirSync(home, { recursive: true })
  launchCreated = true
  mkdirSync(dirname(POINTER), { recursive: true })
  writeFileSync(POINTER, home + '\n')
  const gh = which('gh') || 'gh'
  const pnpm = which('pnpm') || 'pnpm'
  const clusterConfig = join(home, 'cluster.json')
  runTool(['tools/cluster.mjs', 'init', '--config', clusterConfig, '--bundle', REPO,
    '--dsh-bin', '/nonexistent/dsh/lib/bin.js', '--node', process.execPath, '--pnpm', pnpm,
    '--agent-login', 'verify-agent', '--operator-login', 'verify-operator', '--agent-cli', gh,
    '--state-root', join(home, 'state-root'), '--clone-root', join(home, 'clones'), '--port-base', '4590'])
  runTool(['tools/cluster.mjs', 'add', '--config', clusterConfig, '--repo', 'acme/widgets'])
  await bundlePanel(home)
  const log = join(home, 'server.log')
  const logFd = openSync(log, 'a')
  const child = spawn(process.execPath, [
    '--experimental-transform-types', '--experimental-sqlite', join(SCRIPT_DIR, 'stand-in-server.ts'),
  ], {
    cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      DSH_SUPERAGENT_VERIFY_HOME: home,
      DSH_SUPERAGENT_VERIFY_REPO: REPO,
      DSH_SUPERAGENT_VERIFY_PORT: String(port),
      DSH_SUPERAGENT_CLUSTER_CONFIG: clusterConfig,
      DSH_SUPERAGENT_VERIFY_GH: gh,
    },
  })
  child.unref()
  const control = {
    surface: 'linux-panel-stand-in', pid: child.pid, port, home, log,
    url: `http://127.0.0.1:${port}/`, stateDir: join(home, 'state'), clusterConfig,
    packageVersion: JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version,
    dshOnPath: Boolean(dsh), startedAt: new Date().toISOString(),
  }
  writeFileSync(controlPath(home), JSON.stringify(control, null, 2) + '\n')
  const deadline = Date.now() + 30_000
  let last = ''
  while (Date.now() < deadline) {
    if (!alive(child.pid)) {
      last = existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : 'server exited'
      break
    }
    try {
      const state = await fetchJson(`http://127.0.0.1:${port}/orchestrator/api/state`)
      const overview = await fetchJson(`http://127.0.0.1:${port}/orchestrator/api/overview`)
      const page = await fetch(`http://127.0.0.1:${port}/`)
      const html = await page.text()
      const titles = (overview.body.person ?? []).map(ticket => ticket.title)
      const identity = state.headers.get('x-dsh-superagent-verify')
      if (state.status === 200 && identity === 'linux-stand-in' && state.body.health?.runtime?.state === 'ready'
        && state.body.setup?.machine?.stateDir === control.stateDir && titles.includes('Release checklist')
        && html.includes('Superagent') && html.includes('dsh-superagent-linux-stand-in')) {
        console.log(`verify-dsh-superagent ready ${control.url}`)
        console.log(`log ${log}`)
        return
      }
      last = `state ${state.status} identity ${identity} titles ${titles.join(',')}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await delay(200)
  }
  try { process.kill(child.pid, 'SIGTERM') } catch { /* already gone */ }
  throw new Error(`Stand-in did not become ready.\n${last}\n${existsSync(log) ? readFileSync(log, 'utf8').slice(-2000) : ''}`)
}

function doctor() {
  const control = readControl()
  const problems = []
  const check = (ok, text) => { if (!ok) problems.push(text) }
  check(alive(control.pid), `server pid ${control.pid} is not running`)
  check(ownsInodes(control.pid, listeningInodes(control.port)), `pid ${control.pid} does not listen on ${control.port}`)
  const report = {
    ok: false, surface: control.surface, packageVersion: control.packageVersion, pid: control.pid, port: control.port,
    url: control.url, stateDir: control.stateDir, clusterConfig: control.clusterConfig, dshOnPath: Boolean(which('dsh')),
    platform: process.platform, node: process.version, setupProbe: 'skipped', sessionCatalog: 'absent', problems,
  }
  return fetchJson(`${control.url.replace(/\/$/, '')}/orchestrator/api/state`).then(state => {
    report.identity = state.headers.get('x-dsh-superagent-verify')
    report.health = state.body.health
    report.reportedStateDir = state.body.setup?.machine?.stateDir
    check(state.status === 200, `GET state returned ${state.status}`)
    check(report.identity === 'linux-stand-in', `identity header is ${report.identity}, expected linux-stand-in`)
    check(state.body.health?.runtime?.state === 'ready', 'runtime health is not ready')
    check(state.body.setup?.machine?.stateDir === control.stateDir, 'state directory does not match this instance')
    report.ok = problems.length === 0
    const text = JSON.stringify(report, null, 2)
    writeOut(outPath(arg('--out', process.argv.slice(3))), text)
    if (!report.ok) process.exitCode = 1
  }).catch(error => {
    problems.push(error instanceof Error ? error.message : String(error))
    report.ok = false
    writeOut(outPath(arg('--out', process.argv.slice(3))), JSON.stringify(report, null, 2))
    process.exitCode = 1
  })
}

function api() {
  const method = process.argv[3]
  const path = process.argv[4]
  if (!method || !path) throw new Error('usage: verify.mjs api <METHOD> <path> [--query key=value] [--out file]')
  const control = readControl()
  const query = arg('--query', process.argv.slice(5))
  const url = new URL(`/orchestrator/api/${path.replace(/^\//, '')}`, control.url)
  if (query) {
    const [key, ...rest] = query.split('=')
    url.searchParams.set(key, rest.join('='))
  }
  return fetchJson(url, { method }).then(result => {
    const text = JSON.stringify({ status: result.status, body: result.body }, null, 2)
    writeOut(outPath(arg('--out', process.argv.slice(5))), text)
    if (result.status >= 400) process.exitCode = 1
  })
}
function records() {
  const control = readControl()
  const db = join(control.stateDir, 'orchestrator.sqlite')
  const script = `
    import { DatabaseSync } from 'node:sqlite'
    const db = new DatabaseSync(process.argv[1], { readOnly: true })
    const tickets = db.prepare("SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.title') AS title FROM ticket ORDER BY id").all()
    const triggers = db.prepare("SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.text') AS text FROM trigger ORDER BY id").all()
    console.log(JSON.stringify({ tickets, triggers }, null, 2))
  `
  const result = spawnSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e', script, db], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'records failed')
  writeOut(outPath(arg('--out', process.argv.slice(3))), result.stdout.trim())
}

let chromeSocket
function cdpSend(ws, method, params = {}) {
  const id = cdpSend.next = (cdpSend.next ?? 0) + 1
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000)
    cdpSend.pending ??= new Map()
    cdpSend.pending.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
function attachSocket(ws) {
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const pending = cdpSend.pending?.get(message.id)
    if (!pending) return
    cdpSend.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
    else pending.resolve(message.result)
  })
}
function openSocket(url) {
  const ws = new WebSocket(url)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error(`WebSocket timeout ${url}`)) }, 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws) })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket failed ${url}`)) })
  })
}
async function chromeWs() {
  const control = readControl()
  if (!alive(control.chromePid)) {
    const debugPort = control.port + 1
    if (listeningInodes(debugPort).length) throw new Error(`Chrome debug port ${debugPort} is in use.`)
    const profile = join(control.home, 'chrome')
    mkdirSync(profile, { recursive: true })
    const child = spawn(chromeBin(), [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions',
      `--user-data-dir=${profile}`, `--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${debugPort}`,
      '--window-size=1400,1000', control.url,
    ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let log = ''
    const browserWs = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome did not print a DevTools URL.\n${log}`)), 15000)
      child.stderr.on('data', chunk => {
        log += chunk
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(log)
        if (match) { clearTimeout(timer); resolve(match[1]) }
      })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code}.\n${log}`)) })
    })
    child.stderr.unref()
    child.unref()
    control.chromePid = child.pid
    control.browserWs = browserWs
    writeFileSync(controlPath(control.home), JSON.stringify(control, null, 2) + '\n')
  }
  const browser = new URL(control.browserWs)
  const deadline = Date.now() + 20_000
  let last = ''
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://${browser.host}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
      const page = list.find(item => item.type === 'page' && String(item.url).startsWith(control.url.replace(/\/$/, '')))
        ?? list.find(item => item.type === 'page')
      if (!page?.webSocketDebuggerUrl) throw new Error('chrome has no page')
      const ws = await openSocket(page.webSocketDebuggerUrl)
      attachSocket(ws)
      chromeSocket = ws
      await cdpSend(ws, 'Runtime.enable')
      await cdpSend(ws, 'Page.enable')
      const ready = await cdpSend(ws, 'Runtime.evaluate', {
        expression: `new Promise(resolve => { const started = Date.now(); const tick = () => { const title = document.querySelector('h1')?.textContent ?? ''; if (title === 'Superagent' || Date.now() - started > 8000) resolve(JSON.stringify({ title, text: (document.body?.innerText ?? '').slice(0, 500) })); else setTimeout(tick, 100) }; tick() })`,
        awaitPromise: true, returnByValue: true,
      })
      const value = JSON.parse(ready.result?.value ?? '{}')
      if (value.title !== 'Superagent') throw new Error(`Panel heading is ${JSON.stringify(value.title)}. ${value.text}`)
      return ws
    } catch (error) { last = error instanceof Error ? error.message : String(error); chromeSocket?.close(); chromeSocket = undefined; await delay(200) }
  }
  throw new Error(`Chrome did not open the panel. ${last}`)
}
async function evaluate(expression) {
  const ws = chromeSocket ?? await chromeWs()
  const result = await cdpSend(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'page evaluation failed')
  return result.result?.value
}
const FIND = `(() => {
  const roleOf = el => el.getAttribute('role') || (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link'
    : el.tagName === 'INPUT' && el.type === 'search' ? 'searchbox' : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? 'textbox' : '')
  const nameOf = el => (el.getAttribute('aria-label') || el.innerText || '').replace(/\\s+/g, ' ').trim()
  window.__verifyFind = ({ role, name }) => [...document.querySelectorAll('*')].find(el => roleOf(el) === role && nameOf(el) === name)
  window.__verifyRole = roleOf
  window.__verifyName = nameOf
})()`

function finishBrowser() {
  try { chromeSocket?.close() } catch { /* already closed */ }
  chromeSocket = undefined
}
async function browser() {
  const command = process.argv[3]
  try {
  await chromeWs()
  await evaluate(FIND)
  if (command === 'click') {
    const role = arg('--role'), name = arg('--name')
    const found = await evaluate(`(() => { const el = window.__verifyFind(${JSON.stringify({ role, name })}); if (!el) return false; el.click(); return true })()`)
    if (!found) throw new Error(`No ${role} named ${JSON.stringify(name)}`)
    console.log(`clicked ${role} ${name}`)
    return
  }
  if (command === 'fill') {
    const role = arg('--role'), name = arg('--name'), value = arg('--value')
    const found = await evaluate(`(() => {
      const el = window.__verifyFind(${JSON.stringify({ role, name })})
      if (!el) return false
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.focus()
      return el.value
    })()`)
    if (found === false) throw new Error(`No ${role} named ${JSON.stringify(name)}`)
    if (found !== value) throw new Error(`Fill left ${JSON.stringify(found)}`)
    console.log(`filled ${role} ${name}`)
    return
  }
  if (command === 'press') {
    const key = arg('--key')
    await evaluate(`(() => {
      const el = document.activeElement
      el?.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))
      if (${JSON.stringify(key)} === 'Enter') el?.closest('form')?.requestSubmit()
      return true
    })()`)
    console.log(`pressed ${key}`)
    return
  }
  if (command === 'region') {
    const name = arg('--name')
    const text = await evaluate(`document.querySelector(${JSON.stringify(`[role="region"][aria-label="${name}"]`)})?.innerText ?? ''`)
    if (!text) throw new Error(`No region named ${JSON.stringify(name)}`)
    writeOut(outPath(arg('--out')), text)
    return
  }
  if (command === 'text') {
    const text = await evaluate(`document.body.innerText`)
    writeOut(outPath(arg('--out')), text)
    return
  }
  if (command === 'wait') {
    const text = arg('--text')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const body = await evaluate(`document.body.innerText`)
      if (body.includes(text)) { console.log(`saw ${text}`); return }
      await delay(100)
    }
    throw new Error(`Timed out waiting for ${JSON.stringify(text)}`)
  }
  if (command === 'snapshot') {
    if (!process.argv.includes('--aria')) throw new Error('snapshot requires --aria')
    const ws = chromeSocket
    const tree = await cdpSend(ws, 'Accessibility.getFullAXTree')
    const lines = []
    for (const node of tree.nodes ?? []) {
      const role = node.role?.value
      const name = node.name?.value?.replace(/\s+/g, ' ').trim()
      if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox' || role === 'StaticText') continue
      if (!name && !['RootWebArea', 'tab', 'searchbox'].includes(role)) continue
      const selected = node.properties?.find(item => item.name === 'selected')?.value?.value
      lines.push(`${role}${name ? ` ${JSON.stringify(name)}` : ''}${selected ? ' selected' : ''}`)
    }
    writeOut(outPath(arg('--path')), lines.join('\n'))
    console.log(`snapshot ${arg('--path')}`)
    return
  }
  if (command === 'screenshot') {
    const file = outPath(arg('--path'))
    if (!file) throw new Error('screenshot requires --path')
    const ws = chromeSocket
    const shot = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png' })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`screenshot ${file}`)
    return
  }
  throw new Error(`Unknown browser command ${command}`)
  } finally { finishBrowser() }
}

function killGroup(pid) {
  if (!alive(pid)) return false
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  return true
}
function cleanup() {
  const home = homePath()
  const file = controlPath(home)
  if (!existsSync(file) && !existsSync(home)) { console.log(`nothing to clean at ${home}`); return }
  const control = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const stopped = []
  if (killGroup(control.chromePid)) stopped.push(`chrome ${control.chromePid}`)
  if (killGroup(control.pid)) stopped.push(`server ${control.pid}`)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline && (alive(control.pid) || alive(control.chromePid))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  if (alive(control.pid)) process.kill(control.pid, 'SIGKILL')
  rmSync(home, { recursive: true, force: true })
  rmSync(POINTER, { force: true })
  console.log(`cleaned ${home}${stopped.length ? ` (stopped ${stopped.join(', ')})` : ''}`)
  console.log('evidence under .cursor/skills/verify-dsh-superagent/evidence/ was kept')
}

let launchCreated = false

const command = process.argv[2]
const commands = { launch, doctor, api, records, browser, cleanup }
if (!commands[command]) {
  console.error('usage: verify.mjs <launch|doctor|browser|api|records|cleanup>')
  process.exit(2)
}
Promise.resolve(commands[command]()).then(() => {
  process.exit(process.exitCode ?? 0)
}, error => {
  console.error(error instanceof Error ? error.message : error)
  if (command === 'launch' && launchCreated) {
    try { cleanup() } catch (cleanupError) { console.error(cleanupError instanceof Error ? cleanupError.message : cleanupError) }
  }
  process.exit(1)
})
