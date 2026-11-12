/**
 * Unit tests for the exported helpers of tools/cluster.mjs.
 * The command surface itself starts real DSH profiles and is exercised by hand against a
 * playground repository; these helpers cover the config/template/path logic deterministically.
 */
import { readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanEnv, DEFAULT_MODEL_ROUTE, deriveInstance, expandPath, findWebUrl, modelRouteOf, nextPort, normalizeModelConfig,
  normalizeRepository, originOf, prepareCommand, renderProfilePatch, renderTemplate, yamlScalar } from '../tools/cluster.mjs'

describe('cluster profile template', () => {
  const template = ['- id: webserver', '  config:', '    port: {{port}}', '- id: deepseek-account', '  config:',
    '    desktopPlatform: {{desktopPlatform}}', '{{modelProviders}}', '- id: agent-default-model', '  config:',
    '    provider: {{modelProvider}}', '    model: {{modelModel}}', '{{modelReasoningEffort}}', '- id: dsh-superagent', '  config:',
    "    stateDir: '{{stateDir}}'"].join('\n')

  it('renders every placeholder and refuses an unknown one', () => {
    const rendered = renderProfilePatch(template, { port: 3082, stateDir: 'C:\\dsh\\state\\one', platform: 'win32' })
    expect(rendered).toContain('port: 3082')
    expect(rendered).toContain("stateDir: 'C:/dsh/state/one'")
    expect(rendered).toContain('desktopPlatform: win32')
    expect(rendered).not.toContain('{{')
    expect(() => renderTemplate('- {{missing}}', {})).toThrow(/missing/)
    expect(() => renderTemplate('- {{unknown}}', { port: 1 })).toThrow(/unknown/)
  })

  it('uses darwin for macOS and win32 elsewhere', () => {
    expect(renderProfilePatch(template, { port: 1, stateDir: '/srv/dsh', platform: 'darwin' })).toContain('desktopPlatform: darwin')
    expect(renderProfilePatch(template, { port: 1, stateDir: '/srv/dsh', platform: 'linux' })).toContain('desktopPlatform: win32')
  })

  it('keeps the DeepSeek Desktop model route by default, as clusters written before the model option render', () => {
    const rendered = renderProfilePatch(template, { port: 1, stateDir: '/srv/dsh', platform: 'linux' })
    expect(DEFAULT_MODEL_ROUTE).toEqual({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' })
    expect(rendered).toContain(['- id: agent-default-model', '  config:', '    provider: deepseek-account', '    model: deepseek-flash',
      '    reasoningEffort: max'].join('\n'))
    expect(rendered).toContain(['      opencode-go:', '        apiKeyEnv: OPENCODE_GO_API_KEY'].join('\n'))
  })
})

describe('cluster model route', () => {
  it('normalizes an absent model to the DeepSeek Desktop route and requires provider and model otherwise', () => {
    expect(normalizeModelConfig(undefined)).toEqual(DEFAULT_MODEL_ROUTE)
    expect(normalizeModelConfig({ provider: 'spark-local', model: 'deepseek-v4.1-flash' })).toEqual({ provider: 'spark-local', model: 'deepseek-v4.1-flash' })
    expect(normalizeModelConfig({ provider: 'spark-local', model: 'm', reasoningEffort: 'off' }))
      .toEqual({ provider: 'spark-local', model: 'm', reasoningEffort: 'off' })
    expect(() => normalizeModelConfig({ model: 'm' })).toThrow(/model\.provider/)
    expect(() => normalizeModelConfig({ provider: 'p' })).toThrow(/model\.model/)
    expect(() => normalizeModelConfig({ provider: ' ', model: 'm' })).toThrow(/model\.provider/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', reasoningEffort: 'extreme' })).toThrow(/reasoningEffort must be one of/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', extra: true })).toThrow(/unknown field/)
  })

  it('validates the custom endpoint route and everything only it can carry', () => {
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', api: 'openai-completions' })).toThrow(/needs model\.baseURL/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'ftp://example.com' })).toThrow(/http\(s\)/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'not a url' })).toThrow(/http\(s\)/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', api: 'grpc' })).toThrow(/model\.api/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', apiKeyEnv: 'not a name' })).toThrow(/apiKeyEnv/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', contextWindow: 0 })).toThrow(/contextWindow/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', headers: { 'Bad Header': 'x' } })).toThrow(/header name/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', headers: { Authorization: 'a\nb' } })).toThrow(/single-line/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', reasoningEfforts: {} })).toThrow(/at least one level/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', reasoningEfforts: { ultra: 'ultra' } })).toThrow(/unknown level/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', reasoningEfforts: { low: '' } })).toThrow(/not be empty/)
    expect(() => normalizeModelConfig({ provider: 'p', model: 'm', baseURL: 'http://example/v1', reasoningEfforts: { off: null } })).toThrow(/beyond "off"/)
  })

  it('reads an instance route over the cluster defaults field by field', () => {
    const config = { defaults: { model: { provider: 'spark-local', model: 'one', baseURL: 'http://127.0.0.1:18790/v1', headers: { 'X-A': 'a' } } } }
    expect(modelRouteOf(config, { name: 'repo', model: { model: 'two', reasoningEffort: 'low' } })).toEqual({
      provider: 'spark-local', model: 'two', reasoningEffort: 'low', baseURL: 'http://127.0.0.1:18790/v1', headers: { 'X-A': 'a' } })
    // No model anywhere keeps the default route; an invalid instance model names the instance.
    expect(modelRouteOf({ defaults: {} }, { name: 'repo' })).toEqual(DEFAULT_MODEL_ROUTE)
    expect(() => modelRouteOf(config, { name: 'repo', model: { provider: 'p', model: 'm', reasoningEffort: 'nope' } })).toThrow(/instance repo: model\.reasoningEffort/)
  })

  it('renders a custom llm-pi-ai provider next to the OpenCode Go fallback when the route names an endpoint', () => {
    const template = readTemplate()
    const rendered = renderProfilePatch(template, { port: 3082, stateDir: '/srv/dsh', platform: 'linux', model: {
      provider: 'spark-local', model: 'deepseek-v4.1-flash', reasoningEffort: 'max', baseURL: 'http://127.0.0.1:18790/v1',
      headers: { Authorization: 'Bearer local-placeholder' }, contextWindow: 1048576,
      reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', max: 'max' } } })
    expect(rendered).toContain(['      spark-local:', '        api: openai-completions',
      '        headers:', '          Authorization: "Bearer local-placeholder"', '        baseURL: "http://127.0.0.1:18790/v1"',
      '        models:', '          - id: deepseek-v4.1-flash', '            contextWindow: 1048576',
      '            reasoningEfforts:', '              low: low', '              medium: medium', '              high: high', '              max: max'].join('\n'))
    expect(rendered).toContain(['- id: agent-default-model', '  config:', '    provider: spark-local', '    model: deepseek-v4.1-flash',
      '    reasoningEffort: max'].join('\n'))
    // The OpenCode Go fallback stays declared, so the route set does not depend on the custom one.
    expect(rendered).toContain('      opencode-go:')
    expect(rendered).not.toContain('{{')
  })

  it('omits reasoningEffort when the route does not name one, and defaults the api to openai-completions', () => {
    const rendered = renderProfilePatch(readTemplate(), { port: 1, stateDir: '/s', platform: 'win32',
      model: { provider: 'spark-local', model: 'm', baseURL: 'http://127.0.0.1:18790/v1', apiKeyEnv: 'SPARK_API_KEY' } })
    expect(rendered).toContain('        api: openai-completions')
    expect(rendered).toContain('        apiKeyEnv: SPARK_API_KEY')
    expect(rendered).not.toContain('reasoningEffort:')
  })

  it('quotes YAML scalars that would otherwise change type or break the document', () => {
    expect(yamlScalar('max')).toBe('max')
    expect(yamlScalar('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(yamlScalar('off')).toBe('"off"')
    expect(yamlScalar('Bearer token')).toBe('"Bearer token"')
    expect(yamlScalar('http://127.0.0.1:18790/v1')).toBe('"http://127.0.0.1:18790/v1"')
    expect(yamlScalar('a"b')).toBe('"a\\"b"')
  })
})

/** The shipped profile template, so the tests exercise the file the cluster tool renders. */
function readTemplate(): string {
  return readFileSync(join(import.meta.dirname, '..', 'tools', 'profile-template.yml'), 'utf8')
}

describe('cluster instances', () => {
  it('validates repositories and derives unique names and profiles', () => {
    expect(normalizeRepository('acme/widgets')).toBe('acme/widgets')
    expect(() => normalizeRepository('widgets')).toThrow(/owner\/name/)
    expect(() => normalizeRepository('acme/widgets/extra')).toThrow(/owner\/name/)
    expect(deriveInstance('acme/widgets')).toEqual({ name: 'widgets', profile: 'superagent-widgets' })
    expect(deriveInstance('acme/My_Repo-2')).toEqual({ name: 'my-repo-2', profile: 'superagent-my-repo-2' })
    expect(deriveInstance('acme/widgets', [{ name: 'widgets' }])).toEqual({ name: 'widgets-2', profile: 'superagent-widgets-2' })
  })

  it('picks the next port above the base, skipping declared ports', () => {
    expect(nextPort(3082)).toBe(3082)
    expect(nextPort(3082, [{ port: 3082 }, { port: 3083 }])).toBe(3084)
    expect(nextPort(3082, [{ port: 3090 }])).toBe(3082)
    // A missing or non-positive base falls back to the default port.
    expect(nextPort(0)).toBe(3082)
  })
})

describe('cluster process helpers', () => {
  it('renders a PowerShell prepare command with a quoted clone path', () => {
    const command = prepareCommand("C:\\it's a clone\\repo")
    expect(command).toContain("$repo = 'C:\\it''s a clone\\repo'")
    expect(command).toContain('git -C $repo fetch --no-tags $remote')
    expect(command).toContain('git -C $repo worktree add -b')
    expect(command).toContain('$env:DSH_SUPERAGENT_TICKET')
  })

  it('finds the Web UI URL the DSH Web app prints', () => {
    const log = ['starting', 'dsh web: http://127.0.0.1:3082/?token=abc', 'noise'].join('\n')
    expect(findWebUrl(log)).toBe('http://127.0.0.1:3082/?token=abc')
    expect(findWebUrl('nothing here')).toBeUndefined()
    expect(originOf('http://127.0.0.1:3082/?token=abc')).toBe('http://127.0.0.1:3082')
    expect(originOf('not a url')).toBeUndefined()
  })

  it('expands ~ and resolves relative paths', () => {
    expect(expandPath('~/state')).toMatch(/state$/)
    const base = tmpdir()
    expect(expandPath('state', base)).toBe(resolve(base, 'state'))
    expect(expandPath('~/state')).toBe(join(homedir(), 'state'))
  })

  it('strips the variables a running instance injects into its host process', () => {
    const env = cleanEnv({
      PATH: ['/usr/bin', '/state/superagent/worker-bin', '/bin'].join(process.platform === 'win32' ? ';' : ':'),
      GH_CONFIG_DIR: '/state/superagent/gh-agent',
      GIT_CONFIG_GLOBAL: '/state/superagent/worker-gitconfig',
      GH_TOKEN: 'secret',
      HOME: '/home/user',
    })
    expect(env.GH_CONFIG_DIR).toBeUndefined()
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.HOME).toBe('/home/user')
    expect(env.PATH).not.toContain('worker-bin')
    expect(env.PATH).toContain('/usr/bin')
  })
})
