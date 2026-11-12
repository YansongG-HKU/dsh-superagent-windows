#!/usr/bin/env node
/**
 * dsh-superagent cluster: one independent instance per GitHub repository.
 *
 * The prototype serves one repository per plugin instance, so the supported way to watch several
 * repositories is one instance each: separate DSH profile, process, port, state directory, gh
 * configuration and panel. This tool keeps that fleet in one declarative JSON file and gives it
 * init / add / setup / start / stop / status / configure / upgrade commands.
 *
 *   node tools/cluster.mjs init --bundle <checkout> --dsh-bin <bin.js> --node <node.exe> \
 *     --pnpm <pnpm.mjs> --agent-login <agent> --operator-login <you> --agent-cli <gh.exe> \
 *     --state-root <dir> --clone-root <dir> [--external desktop=http://127.0.0.1:54746:owner/repo]
 *   node tools/cluster.mjs add --repo owner/name
 *   node tools/cluster.mjs setup [--name <instance>]
 *   node tools/cluster.mjs start [--name <instance>]
 *   node tools/cluster.mjs configure [--name <instance>]
 *   node tools/cluster.mjs status
 *   node tools/cluster.mjs stop [--name <instance>]
 *
 * Run `node tools/cluster.mjs help` for every option.
 */
import { execFileSync, spawn } from 'node:child_process'
import { openSync, existsSync, readFileSync, statSync } from 'node:fs'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE_ROOT = dirname(HERE)
const DEFAULT_CONFIG = join(homedir(), '.dsh', 'superagent-cluster.json')

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported so the repository's tests can exercise them without running commands).
// ---------------------------------------------------------------------------------------------

/** Render `{{key}}` placeholders, refusing to leave one unresolved. */
export function renderTemplate(template, values) {
  const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`profile template placeholder {{${key}}} has no value`)
    return String(values[key])
  })
  const left = /\{\{(\w+)\}\}/.exec(rendered)
  if (left) throw new Error(`profile template placeholder {{${left[1]}}} has no value`)
  return rendered
}

// ---------------------------------------------------------------------------------------------
// Model route: what the rendered profile uses as the DSH default model, and the custom
// `llm-pi-ai` provider a self-deployed endpoint needs. Values live in the cluster config's
// `defaults.model` and per-instance `model` objects; a cluster written before this option has
// neither and renders the DeepSeek Desktop account route, as it always did.
// ---------------------------------------------------------------------------------------------

/** pi-ai reasoning levels a route or model entry may name, in escalation order. */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** Wire protocols an explicitly declared pi-ai route may name (the adapter's supported set). */
export const PI_AI_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
/** The route rendered when neither an instance nor `defaults` configures one: the DSH Desktop account sign-in. */
export const DEFAULT_MODEL_ROUTE = Object.freeze({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
const MODEL_FIELDS = new Set(['provider', 'model', 'reasoningEffort', 'baseURL', 'api', 'apiKeyEnv', 'headers', 'contextWindow',
  'reasoningEfforts', 'compat'])
/** `model` fields that only make sense on the custom provider route declared by a `baseURL`. */
const PROVIDER_FIELDS = ['api', 'apiKeyEnv', 'headers', 'contextWindow', 'reasoningEfforts', 'compat']
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,199}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const COMPAT_NAME = /^[A-Za-z][A-Za-z0-9]*$/
/** Scalars that a YAML reader could take for another type stay quoted. */
const YAML_RESERVED = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i

/** Render a YAML scalar: plain when unambiguously safe, double-quoted (JSON escaping) otherwise. */
export function yamlScalar(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_][A-Za-z0-9_./+-]*$/.test(text) && !YAML_RESERVED.test(text)) return text
  return JSON.stringify(text)
}

function modelText(value, field, pattern, max) {
  if (typeof value !== 'string') throw new Error(`model.${field} must be a string`)
  const text = value.trim()
  if (!text) throw new Error(`model.${field} must not be empty`)
  if (text.length > max) throw new Error(`model.${field} must be at most ${max} characters`)
  if (!pattern.test(text)) throw new Error(`model.${field} is not valid: ${JSON.stringify(text)}`)
  return text
}

function modelObject(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`model.${field} must be an object`)
  return value
}

/**
 * Validate and normalize a cluster `model` object. Absent (or null) input keeps the backward-compatible
 * DeepSeek Desktop route; a present one requires provider and model, takes an optional reasoning effort
 * from the pi-ai levels, and — with a `baseURL` — the custom provider's optional settings.
 */
export function normalizeModelConfig(input) {
  if (input === undefined || input === null) return { ...DEFAULT_MODEL_ROUTE }
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('model must be an object')
  const unknown = Object.keys(input).filter(key => !MODEL_FIELDS.has(key))
  if (unknown.length) throw new Error(`model has unknown field(s): ${unknown.join(', ')}`)
  const route = { provider: modelText(input.provider, 'provider', PROVIDER_NAME, 80), model: modelText(input.model, 'model', MODEL_ID, 200) }
  if (input.reasoningEffort !== undefined && input.reasoningEffort !== null) {
    if (!REASONING_EFFORTS.includes(input.reasoningEffort)) throw new Error(`model.reasoningEffort must be one of ${REASONING_EFFORTS.join(', ')}`)
    route.reasoningEffort = input.reasoningEffort
  }
  if (input.baseURL !== undefined && input.baseURL !== null) {
    if (typeof input.baseURL !== 'string') throw new Error('model.baseURL must be a string')
    const baseURL = input.baseURL.trim()
    if (baseURL.length > 2048) throw new Error('model.baseURL must be at most 2048 characters')
    let url
    try { url = new URL(baseURL) } catch { throw new Error(`model.baseURL must be an absolute http(s) URL, got ${JSON.stringify(baseURL)}`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`model.baseURL must be an http(s) URL, got ${JSON.stringify(baseURL)}`)
    route.baseURL = baseURL
  }
  for (const field of PROVIDER_FIELDS) {
    if (input[field] !== undefined && input[field] !== null && !route.baseURL) {
      throw new Error(`model.${field} needs model.baseURL: the custom llm-pi-ai provider is only declared for an explicit endpoint`)
    }
  }
  if (input.api !== undefined && input.api !== null) {
    if (!PI_AI_PROTOCOLS.includes(input.api)) throw new Error(`model.api must be one of ${PI_AI_PROTOCOLS.join(', ')}`)
    route.api = input.api
  }
  if (input.apiKeyEnv !== undefined && input.apiKeyEnv !== null) {
    if (typeof input.apiKeyEnv !== 'string' || !ENV_NAME.test(input.apiKeyEnv)) throw new Error('model.apiKeyEnv must be an environment variable name')
    route.apiKeyEnv = input.apiKeyEnv
  }
  const headers = modelObject(input.headers, 'headers')
  if (headers && Object.keys(headers).length) {
    route.headers = {}
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name)) throw new Error(`model.headers has an invalid header name: ${JSON.stringify(name)}`)
      if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error(`model.headers.${name} must be a single-line string`)
      route.headers[name] = value
    }
  }
  const compat = modelObject(input.compat, 'compat')
  if (compat && Object.keys(compat).length) {
    route.compat = {}
    for (const [name, value] of Object.entries(compat)) {
      if (!COMPAT_NAME.test(name)) throw new Error(`model.compat has an invalid field: ${JSON.stringify(name)}`)
      if (!(typeof value === 'boolean' || typeof value === 'string' || value === null)) throw new Error(`model.compat.${name} must be a boolean, a string or null`)
      route.compat[name] = value
    }
  }
  if (input.contextWindow !== undefined && input.contextWindow !== null) {
    if (!Number.isInteger(input.contextWindow) || input.contextWindow <= 0) throw new Error('model.contextWindow must be a positive integer')
    route.contextWindow = input.contextWindow
  }
  const efforts = modelObject(input.reasoningEfforts, 'reasoningEfforts')
  if (efforts) {
    const entries = Object.entries(efforts)
    if (!entries.length) throw new Error('model.reasoningEfforts must declare at least one level, or be omitted')
    route.reasoningEfforts = {}
    for (const [level, wire] of entries) {
      if (!REASONING_EFFORTS.includes(level)) throw new Error(`model.reasoningEfforts has an unknown level ${JSON.stringify(level)}; use ${REASONING_EFFORTS.join(', ')}`)
      if (!(typeof wire === 'string' || wire === null)) throw new Error(`model.reasoningEfforts.${level} must be a string or null`)
      if (wire === '') throw new Error(`model.reasoningEfforts.${level} must not be empty; use null to send no effort value`)
      route.reasoningEfforts[level] = wire
    }
    if (!entries.some(([level]) => level !== 'off')) throw new Error('model.reasoningEfforts must offer a level beyond "off"')
  }
  return route
}

/**
 * The normalized model route of one instance: its own `model` over the cluster `defaults.model`, field by
 * field (a nested `headers`, `reasoningEfforts` or `compat` map is replaced as a whole, not merged).
 */
export function modelRouteOf(config, instance) {
  const defaults = config?.defaults?.model, own = instance?.model
  if ((defaults === undefined || defaults === null) && (own === undefined || own === null)) return { ...DEFAULT_MODEL_ROUTE }
  const merged = { ...(defaults ?? {}), ...(own ?? {}) }
  try { return normalizeModelConfig(merged) } catch (error) {
    const target = instance?.name ? `instance ${instance.name}` : 'cluster defaults'
    throw new Error(`${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Render the `llm-pi-ai` patch row: the OpenCode Go fallback, plus the custom `baseURL` route when one is configured. */
export function renderModelProviders(route) {
  const lines = ['- id: llm-pi-ai', '  config:', '    providers:']
  // A custom route that is itself `opencode-go` replaces the fallback declaration instead of repeating it.
  if (!(route.baseURL && route.provider === 'opencode-go')) lines.push('      opencode-go:', '        apiKeyEnv: OPENCODE_GO_API_KEY')
  if (!route.baseURL) return lines.join('\n')
  lines.push(`      ${yamlScalar(route.provider)}:`)
  lines.push(`        api: ${yamlScalar(route.api ?? 'openai-completions')}`)
  if (route.apiKeyEnv) lines.push(`        apiKeyEnv: ${yamlScalar(route.apiKeyEnv)}`)
  if (route.headers) {
    lines.push('        headers:')
    for (const [name, value] of Object.entries(route.headers)) lines.push(`          ${yamlScalar(name)}: ${yamlScalar(value)}`)
  }
  lines.push(`        baseURL: ${yamlScalar(route.baseURL)}`)
  if (route.compat) {
    lines.push('        compat:')
    for (const [name, value] of Object.entries(route.compat)) {
      lines.push(`          ${yamlScalar(name)}: ${typeof value === 'boolean' || value === null ? String(value) : yamlScalar(value)}`)
    }
  }
  lines.push('        models:', `          - id: ${yamlScalar(route.model)}`)
  if (route.contextWindow) lines.push(`            contextWindow: ${route.contextWindow}`)
  if (route.reasoningEfforts) {
    lines.push('            reasoningEfforts:')
    for (const [level, wire] of Object.entries(route.reasoningEfforts)) {
      lines.push(`              ${yamlScalar(level)}: ${wire === null ? 'null' : yamlScalar(wire)}`)
    }
  }
  return lines.join('\n')
}

/** Validate and normalize an `owner/name` repository. */
export function normalizeRepository(value) {
  const repository = String(value ?? '').trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error(`repository must be owner/name, got ${JSON.stringify(value)}`)
  return repository
}

/** Derive a unique instance name and profile from a repository. */
export function deriveInstance(repository, existing = []) {
  const slug = repository.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo'
  const taken = new Set(existing.map(instance => instance.name))
  let name = slug
  for (let index = 2; taken.has(name); index++) name = `${slug}-${index}`
  return { name, profile: `superagent-${name}` }
}

/** Pick the next free port at or above `base`, skipping ports other instances declare. */
export function nextPort(base, instances = []) {
  const used = new Set(instances.map(instance => Number(instance.port)).filter(Number.isFinite))
  let port = Math.max(1, Number(base) || 3082)
  while (used.has(port)) port++
  return port
}

/** The PowerShell prepare command that creates a worktree for a ticket from the instance's clone. */
export function prepareCommand(clone) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$repo = '${String(clone).replaceAll("'", "''")}'`,
    "$ref = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }",
    '$remote = "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git"',
    'git -C $repo fetch --no-tags $remote "${ref}:refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"',
    'exit $LASTEXITCODE',
  ].join('\n')
}

/** The first `dsh web: <url>` line a DSH Web app prints on startup. */
export function findWebUrl(log) {
  const matches = [...String(log).matchAll(/dsh web:\s+(https?:\/\/\S+)/g)]
  return matches.length ? matches[matches.length - 1][1] : undefined
}

/** The origin of a Web UI URL (the management API needs no token and ignores the query). */
export function originOf(url) {
  try { return new URL(url).origin } catch { return undefined }
}

/** Render the profile patch for an instance and platform; `model` is an instance/`defaults` model object. */
export function renderProfilePatch(template, { port, stateDir, platform = process.platform, model }) {
  const route = normalizeModelConfig(model)
  return renderTemplate(template, {
    port,
    stateDir: String(stateDir).replaceAll('\\', '/').replace(/\/$/, ''),
    desktopPlatform: platform === 'win32' || platform === 'darwin' ? platform : 'win32',
    modelProviders: renderModelProviders(route),
    modelProvider: yamlScalar(route.provider),
    modelModel: yamlScalar(route.model),
    modelReasoningEffort: route.reasoningEffort ? `    reasoningEffort: ${yamlScalar(route.reasoningEffort)}` : '',
  })
}

/** Expand a leading `~` and resolve relative paths against the working directory. */
export function expandPath(value, cwd = process.cwd()) {
  if (!value) return value
  const text = String(value)
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return resolve(cwd, text)
}

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    if (name === 'help' || name === 'json' || name === 'force' || name === 'provision') { options[name] = true; continue }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    options[name] = value
    index++
  }
  return { command, options }
}

const KEBAB = value => String(value).replace(/[A-Z]/g, match => `-${match.toLowerCase()}`)
function optionOf(options, name, fallback) { return options[KEBAB(name)] ?? fallback }

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`cannot read ${file}: ${error.message}`)
  }
}

async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function configPath(options) { return expandPath(optionOf(options, 'config', DEFAULT_CONFIG)) }
function workDir(configFile) { return join(dirname(configFile), 'superagent-cluster') }

function requireConfig(configFile) {
  if (!existsSync(configFile)) throw new Error(`cluster config not found: ${configFile}; run "init" first`)
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  if (!config.version || !Array.isArray(config.instances)) throw new Error(`invalid cluster config: ${configFile}`)
  config.instances ??= []
  config.external ??= []
  return config
}

async function saveConfig(configFile, config) { await writeJson(configFile, config) }

function instanceByName(config, name) {
  const instance = config.instances.find(item => item.name === name)
  if (!instance) throw new Error(`no instance named ${name}; known: ${config.instances.map(item => item.name).join(', ') || '(none)'}`)
  return instance
}

function selectedInstances(config, options) {
  const name = optionOf(options, 'name')
  return name ? [instanceByName(config, name)] : config.instances
}

function stateFile(configFile, name) { return join(workDir(configFile), 'instances', `${name}.json`) }
function logFile(configFile, name) { return join(workDir(configFile), 'logs', `${name}.log`) }

// ---------------------------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------------------------

/**
 * A child environment without the variables a running dsh-superagent host injects into its own
 * process (GH_CONFIG_DIR, the worker git configuration, credential tombstones). The cluster tool
 * may be started from a DSH Session that hosts an instance, and those values must not leak into
 * the profiles or instances it manages.
 */
export function cleanEnv(env = process.env) {
  const copy = { ...env }
  for (const name of ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete copy[name]
  if (copy.PATH) copy.PATH = copy.PATH.split(process.platform === 'win32' ? ';' : ':')
    .filter(entry => !/[\\/]worker-bin$/.test(entry)).join(process.platform === 'win32' ? ';' : ':')
  return copy
}

function runtime(config) {
  const runtime = config.runtime ?? {}
  if (!runtime.node) throw new Error('config.runtime.node is missing')
  if (!runtime.dshBin) throw new Error('config.runtime.dshBin is missing')
  return runtime
}

function run(command, args, { cwd, env, quiet = false, stdio } = {}) {
  if (!quiet) console.log(`$ ${[command, ...args].map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ')}`)
  // Console programs (`git`, `gh`, `node`) must not flash a console window when the tool runs from the panel,
  // whose host is the GUI DeepSeek Harness process.
  return execFileSync(command, args, { cwd, env: { ...cleanEnv(), ...env }, encoding: 'utf8', windowsHide: true,
    stdio: stdio ?? ['ignore', 'pipe', 'pipe'] })
}

async function runDsh(config, args, options = {}) {
  const { node, dshBin } = runtime(config)
  return run(node, [dshBin, ...args], options)
}

function isAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

async function fetchState(origin, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${origin}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' }, signal: controller.signal })
    const text = await response.text()
    if (response.status !== 200) return { error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
    return JSON.parse(text)
  } catch (error) {
    return { error: String(error?.cause?.code ?? error?.message ?? error) }
  } finally { clearTimeout(timer) }
}

function portFree(port) {
  return new Promise(resolvePort => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen({ host: '127.0.0.1', port }, () => server.close(() => resolvePort(true)))
  })
}

function sleep(ms) { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)) }

function ghToken(ghCli, login) {
  const base = { encoding: 'utf8', env: cleanEnv(), windowsHide: true }
  try {
    const output = execFileSync(ghCli, ['auth', 'token', '--user', login], { ...base, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (output) return output
  } catch { /* fall through to switching the active account */ }
  const previous = (() => { try { return execFileSync(ghCli, ['api', 'user', '--jq', '.login'], { ...base, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' } })()
  execFileSync(ghCli, ['auth', 'switch', '--user', login], { ...base, stdio: 'ignore' })
  try { return execFileSync(ghCli, ['auth', 'token'], base).trim() } finally {
    if (previous && previous !== login) { try { execFileSync(ghCli, ['auth', 'switch', '--user', previous], { ...base, stdio: 'ignore' }) } catch { /* keep going */ } }
  }
}

// ---------------------------------------------------------------------------------------------
// init / add / list / doctor
// ---------------------------------------------------------------------------------------------

async function commandInit(options) {
  const configFile = configPath(options)
  const bundle = expandPath(optionOf(options, 'bundle', BUNDLE_ROOT))
  const required = ['dsh-bin', 'node', 'pnpm', 'agent-login', 'operator-login', 'agent-cli']
  for (const name of required) if (!optionOf(options, name)) throw new Error(`init needs --${name}`)
  const config = {
    version: 1,
    bundle,
    runtime: {
      node: expandPath(optionOf(options, 'node')),
      dshBin: expandPath(optionOf(options, 'dsh-bin')),
      pnpm: expandPath(optionOf(options, 'pnpm')),
      profileTemplate: expandPath(optionOf(options, 'profile-template', join(bundle, 'tools', 'profile-template.yml'))),
    },
    defaults: {
      agentLogin: optionOf(options, 'agent-login'),
      operatorLogin: optionOf(options, 'operator-login'),
      agentCli: expandPath(optionOf(options, 'agent-cli')),
      stateRoot: expandPath(optionOf(options, 'state-root', join(homedir(), '.dsh', 'state'))),
      cloneRoot: expandPath(optionOf(options, 'clone-root', join(homedir(), 'src'))),
      portBase: Number(optionOf(options, 'port-base', '3082')),
      observeIssues: true,
      observeComments: true,
    },
    instances: [],
    external: [],
  }
  const external = optionOf(options, 'external')
  if (external) {
    for (const entry of external.split(',')) {
      const [name, url] = entry.split('=')
      if (!name || !url) throw new Error(`--external wants name=url, got ${entry}`)
      config.external.push({ name, url: url.replace(/\/$/, '') })
    }
  }
  await saveConfig(configFile, config)
  console.log(`created cluster config: ${configFile}`)
  console.log('next: node tools/cluster.mjs add --repo owner/name')
}

async function commandAdd(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const repository = normalizeRepository(optionOf(options, 'repo'))
  if (config.instances.some(instance => instance.repository === repository)) throw new Error(`${repository} is already an instance`)
  const derived = deriveInstance(repository, config.instances)
  const name = optionOf(options, 'name', derived.name)
  const profile = optionOf(options, 'profile', `superagent-${name}`)
  if (config.instances.some(instance => instance.name === name || instance.profile === profile)) throw new Error(`instance/profile already exists: ${name}`)
  const port = Number(optionOf(options, 'port', String(nextPort(config.defaults.portBase, config.instances))))
  const stateDir = expandPath(optionOf(options, 'state-dir', join(config.defaults.stateRoot, `superagent-${name}`)))
  const clone = expandPath(optionOf(options, 'clone', join(config.defaults.cloneRoot, repository.split('/')[1])))
  const instance = {
    name,
    profile,
    port,
    repository,
    stateDir,
    clone,
    agentLogin: optionOf(options, 'agent-login', config.defaults.agentLogin),
    agentCli: expandPath(optionOf(options, 'agent-cli', config.defaults.agentCli)),
    enabled: true,
  }
  const prepareFile = optionOf(options, 'prepare-file')
  if (prepareFile) instance.prepare = readFileSync(expandPath(prepareFile), 'utf8').trim()
  config.instances.push(instance)
  await saveConfig(configFile, config)
  console.log(`added instance ${name}: ${repository} -> http://127.0.0.1:${port} (state ${stateDir})`)
  if (options.provision) {
    // Bring the new repository all the way up: profile, bundle, gh configuration, clone, process and settings.
    await commandSetup({ ...options, name })
    await commandStart({ ...options, name })
    await commandConfigure({ ...options, name })
    const state = await readJson(stateFile(configFile, name))
    console.log(`\n${name} is provisioned; open ${state?.url ?? `http://127.0.0.1:${port}`}`)
    return
  }
  console.log('next: node tools/cluster.mjs setup --name ' + name)
}

/** `provider/model` (and endpoint) of an instance's route, or `invalid` when the model config cannot be normalized. */
function modelLabel(config, instance) {
  try {
    const route = modelRouteOf(config, instance)
    return `${route.provider}/${route.model}${route.baseURL ? ` @ ${route.baseURL}` : ''}`
  } catch { return 'invalid' }
}

function printInstances(config) {
  const rows = [
    ['NAME', 'PROFILE', 'PORT', 'REPOSITORY', 'MODEL', 'STATE DIR', 'AGENT'],
    ...config.instances.map(instance => [instance.name, instance.profile, String(instance.port), instance.repository,
      modelLabel(config, instance), instance.stateDir, `@${instance.agentLogin}`]),
  ]
  for (const row of rows) console.log(row.join('  '))
  if (config.external.length) {
    console.log('external (not managed by this tool):')
    for (const entry of config.external) console.log(`  ${entry.name}  ${entry.url}  ${entry.repository ?? ''}`)
  }
}

async function commandDoctor(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const problems = []
  const check = (ok, text) => { console.log(`${ok ? 'ok  ' : 'fail'} ${text}`); if (!ok) problems.push(text) }
  check(existsSync(config.bundle), `bundle: ${config.bundle}`)
  check(existsSync(join(config.bundle, 'lib', 'index.js')), 'bundle is built (lib/index.js)')
  check(existsSync(config.runtime.profileTemplate), `profile template: ${config.runtime.profileTemplate}`)
  check(existsSync(config.runtime.node), `node: ${config.runtime.node}`)
  check(existsSync(config.runtime.dshBin), `dsh bin: ${config.runtime.dshBin}`)
  check(existsSync(config.runtime.pnpm), `pnpm: ${config.runtime.pnpm}`)
  try { run(config.defaults.agentCli, ['version'], { quiet: true }); check(true, `gh CLI: ${config.defaults.agentCli}`) }
  catch { check(false, `gh CLI not runnable: ${config.defaults.agentCli}`) }
  for (const instance of config.instances) {
    try {
      const route = modelRouteOf(config, instance)
      check(true, `${instance.name}: model ${route.provider}/${route.model}${route.baseURL ? ` @ ${route.baseURL}` : ''}`)
    } catch (error) { check(false, `${instance.name}: ${error instanceof Error ? error.message : String(error)}`) }
    const state = await readJson(stateFile(configFile, instance.name))
    if (state && isAlive(state.pid)) check(true, `${instance.name}: running (pid ${state.pid})`)
    else check(await portFree(instance.port), `${instance.name}: port ${instance.port} is free`)
    check(instance.repository.includes('/'), `${instance.name}: repository ${instance.repository}`)
    try {
      const login = execFileSync(config.defaults.agentCli, ['api', 'user', '--jq', '.login'], { encoding: 'utf8', windowsHide: true,
        env: { ...cleanEnv(), GH_CONFIG_DIR: join(instance.stateDir, 'gh-agent') } }).trim()
      check(login === instance.agentLogin, `${instance.name}: gh config acts as ${login}`)
      const push = execFileSync(config.defaults.agentCli, ['api', `repos/${instance.repository}`, '--jq', '.permissions.push'], { encoding: 'utf8', windowsHide: true,
        env: { ...cleanEnv(), GH_CONFIG_DIR: join(instance.stateDir, 'gh-agent') } }).trim()
      check(push === 'true', `${instance.name}: agent has push access to ${instance.repository}`)
    } catch (error) {
      check(false, `${instance.name}: agent configuration check failed (${error.message.split('\n')[0]})`)
    }
  }
  if (problems.length) { console.log(`\n${problems.length} problem(s)`); process.exitCode = 1 }
  else console.log('\nall checks passed')
}

// ---------------------------------------------------------------------------------------------
// setup / start / stop / status / configure / upgrade
// ---------------------------------------------------------------------------------------------

async function ensurePnpmShim(config) {
  const dir = join(workDir(config.__file), 'bin')
  await mkdir(dir, { recursive: true })
  const isWindows = process.platform === 'win32'
  const shim = join(dir, isWindows ? 'pnpm.cmd' : 'pnpm')
  if (!existsSync(shim)) {
    const { node, pnpm } = runtime(config)
    const content = isWindows
      ? `@echo off\r\n"${node}" "${pnpm}" %*\r\n`
      : `#!/bin/sh\nexec "${node}" "${pnpm}" "$@"\n`
    await writeFile(shim, content, { mode: isWindows ? undefined : 0o755 })
  }
  return dir
}

async function ensureHostEntry(stateDir, agentLogin, agentCli) {
  const dir = join(stateDir, 'gh-agent')
  await mkdir(dir, { recursive: true })
  const token = ghToken(agentCli, agentLogin)
  if (!token) throw new Error(`no gh token for ${agentLogin}; sign that account in to gh first`)
  const content = ['github.com:', `    user: ${agentLogin}`, `    oauth_token: ${token}`, '    git_protocol: https', ''].join('\n')
  const file = join(dir, 'hosts.yml')
  await writeFile(file, content)
  if (process.platform === 'win32') {
    try { execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W)`], { stdio: 'ignore', windowsHide: true }) } catch { /* non-NTFS */ }
  }
  return file
}

async function ensureClone(instance, config) {
  if (existsSync(join(instance.clone, '.git'))) return false
  await mkdir(dirname(instance.clone), { recursive: true })
  const ghAgent = join(instance.stateDir, 'gh-agent')
  const helper = `credential.helper=!"${config.defaults.agentCli.replaceAll('\\', '/')}" auth git-credential`
  run('git', ['-c', 'credential.helper=', '-c', helper, 'clone',
    `https://github.com/${instance.repository}.git`, instance.clone], { env: { GH_CONFIG_DIR: ghAgent } })
  // dsh-superagent verifies that a ticket directory's git configuration carries no credential helper,
  // so remove the clone-local helper the clone needed.
  for (const key of ['credential.helper', 'credential.https://github.com.helper']) {
    try { run('git', ['-C', instance.clone, 'config', '--local', '--unset-all', key], { quiet: true }) } catch { /* not set */ }
  }
  return true
}

async function commandSetup(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  config.__file = configFile
  const instances = selectedInstances(config, options)
  if (!existsSync(join(config.bundle, 'lib', 'index.js'))) {
    console.log('bundle is not built yet; building it first ...')
    await buildBundle(config)
  }
  const template = await readFile(config.runtime.profileTemplate, 'utf8')
  const pnpmBin = await ensurePnpmShim(config)
  const dshHome = expandPath(optionOf(options, 'dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh')))
  const bundleName = JSON.parse(readFileSync(join(config.bundle, 'package.json'), 'utf8')).name
  for (const instance of instances) {
    if (instance.enabled === false) continue
    // Validate the route before creating anything: a broken model object must not leave a half-configured profile.
    const model = modelRouteOf(config, instance)
    const profileDir = join(dshHome, 'profiles', instance.profile)
    if (!existsSync(profileDir)) {
      console.log(`creating profile ${instance.profile} from the web template ...`)
      await runDsh(config, [instance.profile, '--from-default-profile', 'web', '--dump-config'], { quiet: true, env: { DSH_HOME: dshHome } })
    }
    const rendered = renderProfilePatch(template, { port: instance.port, stateDir: instance.stateDir, model })
    await writeFile(join(profileDir, 'cordis.patch.yml'), rendered)
    const profilePackage = join(profileDir, 'package.json')
    const profile = JSON.parse(readFileSync(profilePackage, 'utf8'))
    const bundles = profile.dsh?.profile?.bundles ?? []
    if (!bundles.includes(bundleName)) {
      console.log(`installing ${bundleName} into profile ${instance.profile} ...`)
      await runDsh(config, ['plugin', '--profile', instance.profile, 'add', `link:${config.bundle}`],
        { env: { ...cleanEnv(), DSH_HOME: dshHome, PATH: `${pnpmBin}${process.platform === 'win32' ? ';' : ':'}${cleanEnv().PATH}` } })
    }
    await mkdir(instance.stateDir, { recursive: true })
    await ensureHostEntry(instance.stateDir, instance.agentLogin, instance.agentCli)
    const cloned = await ensureClone(instance, config)
    console.log(`${instance.name}: profile=${instance.profile} port=${instance.port} model=${model.provider}/${model.model}${model.baseURL ? ` @ ${model.baseURL}` : ''} state=${instance.stateDir}${cloned ? ' clone=created' : ''}`)
  }
  console.log('\nsetup done; next: node tools/cluster.mjs start')
}

async function commandStart(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const { node, dshBin } = runtime(config)
  const instances = selectedInstances(config, options)
  for (const instance of instances) {
    if (instance.enabled === false) continue
    const statePath = stateFile(configFile, instance.name)
    const state = await readJson(statePath)
    if (state && isAlive(state.pid)) { console.log(`${instance.name}: already running (pid ${state.pid}) ${state.url}`); continue }
    const log = logFile(configFile, instance.name)
    await mkdir(dirname(log), { recursive: true })
    const logFd = openSync(log, 'a')
    const child = spawn(node, [dshBin, '--profile', instance.profile, '--no-open'], {
      detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
      env: { ...cleanEnv(), DSH_HOME: expandPath(optionOf(options, 'dsh-home', process.env.DSH_HOME ?? join(homedir(), '.dsh'))) },
    })
    child.unref()
    let url
    for (let attempt = 0; attempt < 120; attempt++) {
      await sleep(500)
      try { url = findWebUrl(readFileSync(log, 'utf8')) } catch { url = undefined }
      if (url) break
      if (!isAlive(child.pid)) break
    }
    if (!url) {
      console.error(`${instance.name}: did not print a Web UI URL; see ${log}`)
      try { process.kill(child.pid, 'SIGKILL') } catch { /* gone */ }
      continue
    }
    const origin = originOf(url)
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      const stateNow = await fetchState(origin)
      if (!stateNow.error) { ready = true; break }
      await sleep(1000)
    }
    await writeJson(statePath, { pid: child.pid, url, port: instance.port, startedAt: new Date().toISOString(), ready })
    console.log(`${instance.name}: started pid=${child.pid} ${url}${ready ? '' : ' (not answering yet)'}`)
  }
}

async function commandStop(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  for (const instance of selectedInstances(config, options)) {
    const statePath = stateFile(configFile, instance.name)
    const state = await readJson(statePath)
    if (!state || !isAlive(state.pid)) { console.log(`${instance.name}: not running`); await rm(statePath, { force: true }); continue }
    if (process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch { /* gone */ }
    } else {
      try { process.kill(-state.pid, 'SIGTERM') } catch { try { process.kill(state.pid, 'SIGTERM') } catch { /* gone */ } }
      for (let attempt = 0; attempt < 60 && isAlive(state.pid); attempt++) await sleep(500)
      if (isAlive(state.pid)) { try { process.kill(-state.pid, 'SIGKILL') } catch { try { process.kill(state.pid, 'SIGKILL') } catch { /* gone */ } } }
    }
    for (let attempt = 0; attempt < 40 && isAlive(state.pid); attempt++) await sleep(250)
    // A force-killed plugin leaves the state directory lock behind.
    await rm(`${instance.stateDir}.lock`, { recursive: true, force: true })
    await rm(statePath, { force: true })
    console.log(`${instance.name}: stopped (pid ${state.pid})`)
  }
}

async function commandStatus(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const entries = []
  for (const instance of config.instances) {
    const state = await readJson(stateFile(configFile, instance.name))
    const running = !!(state && isAlive(state.pid))
    const origin = state?.url ? originOf(state.url) : `http://127.0.0.1:${instance.port}`
    const snapshot = running ? await fetchState(origin) : { error: 'stopped' }
    entries.push({ name: instance.name, kind: 'instance', repository: instance.repository, running, origin, url: state?.url, snapshot })
  }
  for (const external of config.external) {
    const origin = originOf(external.url) ?? external.url
    entries.push({ name: external.name, kind: 'external', repository: external.repository ?? '', running: true, origin, url: external.url, snapshot: await fetchState(origin) })
  }
  let unhealthy = 0
  for (const entry of entries) {
    const snapshot = entry.snapshot
    if (snapshot.error) {
      console.log(`${entry.name}: ${entry.running ? 'unreachable' : 'stopped'} (${snapshot.error}) ${entry.origin}`)
      unhealthy++
      continue
    }
    const problem = snapshot.setup?.problem?.detail
    const accounts = snapshot.setup?.accounts
    const errors = Object.entries(snapshot.health ?? {}).filter(([, item]) => item?.state === 'error').map(([name]) => name)
    const paused = snapshot.paused ? ' paused' : ''
    const load = snapshot.load ?? {}
    console.log(`${entry.name}: ${problem ? 'setup pending' : errors.length ? 'error' : 'ready'}${paused}`
      + ` | repo ${accounts?.repository ?? entry.repository} | agent @${accounts?.agent ?? '?'}`
      + ` | executor ${load.running ?? 0}/${load.maxWorkers ?? '?'}, queued ${load.queued ?? 0}`
      + ` | ${entry.url ?? entry.origin}`)
    if (problem) console.log(`  setup: ${problem}`)
    if (errors.length) console.log(`  errors: ${errors.join(', ')}`)
    if (problem || errors.length) unhealthy++
  }
  if (options.json) console.log(JSON.stringify(entries, null, 2))
  if (unhealthy) process.exitCode = 2
}

async function commandConfigure(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const scripts = join(HERE, 'configure.mjs')
  for (const instance of selectedInstances(config, options)) {
    if (instance.enabled === false) continue
    const state = await readJson(stateFile(configFile, instance.name))
    if (!state?.url) { console.log(`${instance.name}: not running; start it first`); continue }
    const origin = originOf(state.url)
    console.log(`\n== configuring ${instance.name} (${instance.repository}) via ${origin}`)
    const args = [scripts, '--url', origin, '--repo', instance.repository, '--cli', instance.agentCli,
      '--agent-login', instance.agentLogin, '--operator-login', config.defaults.operatorLogin, '--clone', instance.clone]
    if (instance.prepare) args.push('--prepare', instance.prepare)
    // Pipe configure.mjs so a caller (for example the panel's cluster operations) captures its progress too,
    // and print it for terminal users.
    const output = run(runtime(config).node, args, { stdio: ['ignore', 'pipe', 'pipe'], quiet: true })
    if (output && output.trim()) console.log(output.trim())
  }
}

async function commandProvision(options) {
  // Idempotent: setup re-renders the profile, retries a missing clone and gh configuration, start launches a stopped
  // instance, and configure rewrites its settings. It repairs an add that stopped halfway (for example on a network error).
  await commandSetup(options)
  await commandStart(options)
  await commandConfigure(options)
}

async function buildBundle(config) {
  const { node, pnpm } = runtime(config)
  run(node, [pnpm, 'install'], { cwd: config.bundle })
  run(node, [pnpm, 'build'], { cwd: config.bundle })
}

async function commandUpgrade(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  console.log('building the bundle ...')
  await buildBundle(config)
  const running = []
  for (const instance of config.instances) {
    const state = await readJson(stateFile(configFile, instance.name))
    if (state && isAlive(state.pid)) running.push(instance)
  }
  if (!running.length) { console.log('nothing running; next start uses the new build'); return }
  await commandStop({ config: configFile })
  await commandStart({ config: configFile })
  console.log(`restarted: ${running.map(instance => instance.name).join(', ')}`)
}

async function commandLogs(options) {
  const configFile = configPath(options)
  const config = requireConfig(configFile)
  const instance = instanceByName(config, optionOf(options, 'name'))
  const file = logFile(configFile, instance.name)
  if (!existsSync(file)) { console.log(`no log yet: ${file}`); return }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const count = Number(optionOf(options, 'lines', '80'))
  console.log(lines.slice(-count).join('\n'))
}

const HELP = `dsh-superagent cluster: one independent instance per GitHub repository

usage: node tools/cluster.mjs <command> [options] [--config <file>]

commands:
  init        write the cluster config
              --bundle <checkout> --dsh-bin <dsh/lib/bin.js> --node <node> --pnpm <pnpm.mjs>
              --agent-login <login> --operator-login <login> --agent-cli <gh.exe>
              [--state-root <dir>] [--clone-root <dir>] [--port-base 3082]
              [--profile-template <file>] [--external name=url[,name=url...]]
  add         add a repository instance
              --repo owner/name [--name <name>] [--profile <profile>] [--port <port>]
              [--state-dir <dir>] [--clone <dir>] [--agent-login <login>] [--agent-cli <gh.exe>]
              [--prepare-file <ps1>] [--provision (also setup, start and configure it)]
  list        list instances and external entries
  doctor      preflight: paths, built bundle, gh identity and push access, free ports
  setup       create profiles, render the profile patch, install the bundle, write gh config, clone
              [--name <instance>] [--dsh-home <dir>]
  start       start instances (detached) and wait for their Web UI URLs   [--name <instance>]
  stop        stop instances and clear a stale state lock                [--name <instance>]
  status      print setup, health and executor load per instance         [--json]
  configure   write Source/Policy/Executor/Prompts through each instance's management API
              [--name <instance>]
  provision   bring existing instances all the way up: setup, start and configure  [--name <instance>]
  upgrade     rebuild the bundle and restart the running instances
  logs        tail an instance log  --name <instance> [--lines 80]
  help        this text

model route: the cluster config's defaults.model, or an instance's model object, selects the rendered
             profile's default model; a baseURL there declares a custom llm-pi-ai provider (tools/README.md)
`

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'init': return commandInit(options)
    case 'add': return commandAdd(options)
    case 'list': return printInstances(requireConfig(configPath(options)))
    case 'doctor': return commandDoctor(options)
    case 'setup': return commandSetup(options)
    case 'start': return commandStart(options)
    case 'stop': return commandStop(options)
    case 'status': return commandStatus(options)
    case 'configure': return commandConfigure(options)
    case 'provision': return commandProvision(options)
    case 'upgrade': return commandUpgrade(options)
    case 'logs': return commandLogs(options)
    case 'help': case '--help': case '-h': console.log(HELP); return
    default: throw new Error(`unknown command: ${command}\n\n${HELP}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exit(1) })
}
