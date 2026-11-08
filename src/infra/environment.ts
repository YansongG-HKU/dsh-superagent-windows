/**
 * Process environment and CLI shims that bind git, gh, and lark-cli to the deployment's accounts and block disallowed commands.
 * Variables read by workers avoid `KEY|PASSWORD|SECRET|TOKEN` in their names because DSH strips credential-shaped variables from child environments.
 * Provides default-path guardrails rather than an OS-level security boundary, as workers run under the operator's OS user.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Deployment } from '../deployment.ts'
import { SetupError } from '../setup.ts'
import { CliError } from './commands.ts'

/** True on the Windows host this plugin runs on, where gh is bound to its account through `GH_CONFIG_DIR` and shims are `.cmd` files. */
const WINDOWS = process.platform === 'win32'
const MARKER = '# Written by dsh-superagent on every start; edits are lost.'
/** Markers of files written under the project's earlier names (`dsh-tag`, `dsh-go`, `dsh-freelancer`), which `dsh-superagent` owns and replaces too. */
const LEGACY_MARKERS = ['dsh-tag', 'dsh-go', 'dsh-freelancer'].map(name => `# Written by ${name} on every start; edits are lost.`)
const MARKERS = [MARKER, ...LEGACY_MARKERS]
/** Commands workers need, which `blockedCommands` cannot block: the shims and git. */
export const WORKER_COMMANDS: readonly string[] = ['gh', 'git', 'lark-cli']
export const workerBin = (stateDir: string): string => join(stateDir, 'worker-bin')
export const workerGitConfig = (stateDir: string): string => join(stateDir, 'worker-gitconfig')
/** The isolated GitHub CLI configuration directory the agent account reads on Windows, which setup probes and every worker command run with. */
export const agentGhConfig = (stateDir: string): string => join(stateDir, 'gh-agent')
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const gitQuote = (value: string): string => `"${value.replace(/[\\"]/g, char => `\\${char}`)}"`
/** Quotes a path for Git for Windows' bundled `sh`, which runs `!` credential helpers, keeping spaces and `$` whole. */
const shellDoubleQuote = (value: string): string => `"${value.replace(/[\\"$`]/g, char => `\\${char}`)}"`
/** The credential helper Git runs: a POSIX shell command string on POSIX, and one Git for Windows' shell runs on Windows. */
export const credentialHelper = (cli: string): string => WINDOWS
  ? `!${shellDoubleQuote(cli.replaceAll('\\', '/'))} auth git-credential`
  : `!${shellQuote(cli)} auth git-credential`

export function sameDirectory(a: string, b: string): boolean {
  const real = (path: string): string => { try { return realpathSync(path) } catch { return resolve(path) } }
  return real(a) === real(b)
}
export function withoutDirectory(path: string, dir: string): string {
  return path.split(delimiter).filter(entry => !sameDirectory(entry, dir)).join(delimiter)
}

/**
 * The variables that tell git which repository, work tree and index to act on. A host started inside git, such as by
 * `git rebase --exec`, passes them on, and a git started below it would act on that repository. GIT_CEILING_DIRECTORIES is
 * kept: it names no repository, and it stops git's search for one where the operator chose.
 */
export const GIT_LOCATION: readonly string[] = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']

/**
 * Returns environment variable overrides that strip ambient GitHub tokens, interactive prompts, the repository the host's own
 * environment may name, and operator git identity/config overrides.
 */
export function agentVariables(stateDir: string): Record<string, string | undefined> {
  return {
    // On Windows workers call the real gh.exe, which reads the agent account from its isolated configuration directory instead of a wrapper shim.
    ...WINDOWS ? { GH_CONFIG_DIR: agentGhConfig(stateDir) } : {},
    GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
    // A worker's git finds the repository from its directory, never from the host's environment.
    ...Object.fromEntries(GIT_LOCATION.map(name => [name, undefined])),
    GIT_CONFIG_GLOBAL: workerGitConfig(stateDir), GIT_CONFIG_NOSYSTEM: '1',
    // Clear environment git config overrides; configuration passed through the environment would otherwise reach every git command the agent runs.
    GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined,
    // When the credential helper has no answer, git must fail rather than prompt; `GIT_ASKPASS: ''` also overrides `core.askPass` and `SSH_ASKPASS`.
    GIT_ASKPASS: '', SSH_ASKPASS: undefined, GIT_TERMINAL_PROMPT: '0',
    // Clear operator commit identity variables; prompts specify commit identity and operator env vars would override what a worker sets.
    GIT_AUTHOR_NAME: undefined, GIT_COMMITTER_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_EMAIL: undefined,
  }
}

/** True when a line carries a marker: bare in POSIX shims and the git configuration, after `REM` in a `.cmd` shim. */
const marked = (line: string): boolean => MARKERS.some(marker => line === marker || line === `REM ${marker}`)
/** True when a regular file starts with the dsh-superagent marker in its first two lines; a symbolic link, directory, or other non-regular file never counts as written by dsh-superagent. */
async function written(file: string): Promise<boolean> {
  if (!(await lstat(file)).isFile()) return false
  const head = (await readFile(file, 'utf8')).split('\n', 2)
  return head.some(marked)
}
async function own(file: string, text: string, mode = 0o644): Promise<void> {
  let foreign = false
  try { foreign = !await written(file) } catch { /* The file does not exist yet. */ }
  if (foreign) throw new SetupError('foreignFile', { file })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, text, { mode })
  await rename(temporary, file)
}

/**
 * Atomically writes worker CLI shims and the isolated git configuration file into the state directory, refusing to overwrite foreign files.
 * On POSIX each shim strips the shim directory from PATH before exec so wrapper scripts resolving `gh` or `lark-cli` by name reach the real binary.
 * On Windows only blocked commands get a shim, a `.cmd` file PATHEXT finds first; gh reaches its real binary by name and reads its account from
 * `GH_CONFIG_DIR`, and Feishu is off, so neither needs a shim.
 */
export async function writeEnvironment(deployment: Pick<Deployment, 'stateDir' | 'repository' | 'github' | 'feishu'>, blockedCommands: readonly string[]): Promise<void> {
  const { stateDir, repository, github, feishu } = deployment
  const dir = workerBin(stateDir)
  await mkdir(dir, { recursive: true })
  const before = await readdir(dir)
  for (const name of before) { const file = join(dir, name); if (!await written(file)) throw new SetupError('foreignFile', { file }) }
  // Workers may be running concurrently: write each shim to a temp file and atomically rename it so no command ever resolves past the shim directory.
  const kept = new Set<string>()
  const shim = async (name: string, text: string, mode: number): Promise<void> => {
    const temporary = join(dir, `.${name}.${process.pid}.tmp`)
    await writeFile(temporary, text, { mode })
    await rename(temporary, join(dir, name))
    kept.add(name)
  }
  // Commands whose shims dsh-superagent owns; a command such as `git` is never shimmed.
  const blocked = new Set(blockedCommands.filter(name => !WORKER_COMMANDS.includes(name)))
  if (WINDOWS) {
    for (const name of blocked) {
      await shim(`${name}.cmd`, [
        '@echo off',
        `REM ${MARKER}`,
        `echo ${name} is blocked in this installation; use gh, which acts as ${github.login}. 1>&2`,
        'exit /b 1',
      ].join('\n') + '\n', 0o644)
    }
  } else {
    const withoutShims = [
      `self=${shellQuote(dir)}`, 'rest=', 'IFS=:', 'set -f',
      'for entry in $PATH; do [ "$entry" = "$self" ] || rest="${rest:+$rest:}$entry"; done',
      'set +f', 'unset IFS', 'PATH=$rest', 'export PATH',
    ].join('\n')
    const run = (program: string): string => `${withoutShims}\nexec ${shellQuote(program)} "$@"`
    const fail = (message: string): string => `echo ${shellQuote(message)} >&2\nexit 1`
    const comment = (body: string): string => `#!/bin/sh\n${MARKER}\n${body}\n`
    await shim('gh', comment(run(github.cli)), 0o755)
    await shim('lark-cli', comment(feishu ? run(feishu.cli) : fail('lark-cli is unavailable: this installation has no Feishu bot.')), 0o755)
    for (const name of blocked) await shim(name, comment(fail(`${name} is blocked in this installation; use gh, which acts as ${github.login}.`)), 0o755)
  }
  // Owned files of earlier runs that this one does not write are removed, including the POSIX gh and lark-cli shims a run on another host wrote.
  for (const name of before) if (!kept.has(name)) await unlink(join(dir, name))
  await own(workerGitConfig(stateDir), [
    MARKER,
    // Make git refuse to commit without an explicit identity set by the worker instead of guessing from the operator's OS user.
    '[user]', '\tuseConfigOnly = true',
    '[credential]', '\thelper =',
    '[credential "https://github.com"]', `\thelper = ${gitQuote(credentialHelper(github.cli))}`,
    '[url "https://github.com/"]', '\tinsteadOf = git@github.com:', '\tinsteadOf = ssh://git@github.com/',
    // Include Git LFS filters because the operator's global gitconfig (which usually holds them) is ignored.
    '[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true',
  ].join('\n') + '\n')
}

/**
 * The environment worker processes run with: agent variables, their tombstones, and the worker shim directory first on PATH.
 * Returned as a value instead of applied to `process.env` so the host process keeps its own environment and only the
 * children that need the worker identity receive it.
 */
export function workerEnvironment(stateDir: string, path = process.env.PATH ?? ''): Record<string, string | undefined> {
  return { ...agentVariables(stateDir), PATH: [workerBin(stateDir), withoutDirectory(path, workerBin(stateDir))].join(delimiter) }
}

/** Spawns a command through the DSH subprocess runtime, which strips credential-shaped environment variables, with the caller's explicit worker environment. */
export async function runAsWorker(subprocess: SubprocessRuntime, argv: string[], cwd: string, signal: AbortSignal,
  environment: Record<string, string | undefined> = {}, extra: Record<string, string> = {}): Promise<string> {
  const env = { ...environment, ...extra }
  const handle = subprocess.spawn({ argv, cwd, graceMs: 2000, signal, ...Object.keys(env).length ? { env } : {}, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 16 } } })
  const { exitCode } = await handle.done
  const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
  if (exitCode === 0) return read(handle.collected.stdout)
  const ended = exitCode === null ? 'was stopped before it finished' : `exited with ${exitCode}`
  throw new CliError(read(handle.collected.stderr).trim() || `${argv.join(' ')} ${ended}`, undefined, exitCode ?? undefined)
}

/** The path Git printed as a config origin, without its `file:` prefix. */
const originPath = (origin: string): string => origin.startsWith('file:') ? origin.slice('file:'.length) : origin
/** Normalizes a config path for comparison: Git prints the separators `GIT_CONFIG_GLOBAL` had, and a Windows drive letter varies in case. */
const configPath = (path: string): string => WINDOWS ? path.replaceAll('\\', '/').toLowerCase() : path

/** Verifies that worker git invocations resolve the deployment's GitHub credential helper. */
export async function verifyEnvironment(deployment: Pick<Deployment, 'github' | 'stateDir'>, subprocess: SubprocessRuntime, signal: AbortSignal): Promise<void> {
  const { github, stateDir } = deployment
  // `-z` separates fields with NUL and never quotes paths.
  const fields = (await runAsWorker(subprocess, ['git', 'config', '-z', '--show-origin', '--get-all', 'credential.https://github.com.helper'], stateDir,
    AbortSignal.any([signal, AbortSignal.timeout(60_000)]), workerEnvironment(stateDir)).catch(() => '')).split('\0')
  // One setting is a pair of origin file and value, followed by the final empty field.
  fields.pop()
  const ours = fields.length === 2 && configPath(originPath(fields[0]!)) === configPath(workerGitConfig(stateDir)) && fields[1] === credentialHelper(github.cli)
  if (!ours) throw new SetupError('gitTooOld')
}

/**
 * Verifies that a ticket directory's local or worktree git config defines no custom `credential.*` or `http.*extraheader`
 * keys, which the agent's git would read from the repository's own config and act on.
 */
export async function verifyDirectory(directory: string, subprocess: SubprocessRuntime, signal: AbortSignal,
  environment: Record<string, string | undefined> = {}): Promise<void> {
  const keys = ['git', 'config', '-z', '--show-scope', '--get-regexp', '^(credential\\..*|http\\..*extraheader)$']
  // `git config --get-regexp` exits with code 1 when no keys match.
  const output = await runAsWorker(subprocess, keys, directory, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), environment)
    .catch((error: unknown) => { if (error instanceof CliError && error.exitCode === 1) return ''; throw error })
  const scoped = output.split('\0')
  const local = scoped.flatMap((scope, index) => index % 2 === 0 && (scope === 'local' || scope === 'worktree') ? [scoped[index + 1]!.split('\n')[0]!] : [])
  if (local.length) throw new Error(`The git configuration of the repository in ${directory} sets ${local.join(', ')}, which the agent's git would also read; remove them.`)
}
