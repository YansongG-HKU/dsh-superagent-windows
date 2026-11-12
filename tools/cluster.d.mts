/** Declarations for the pure helpers exported by tools/cluster.mjs (used by tests/cluster.spec.ts). */
/** One normalized model route a cluster instance renders. */
export interface ClusterModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
  baseURL?: string
  api?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  compat?: Record<string, boolean | string | null>
  contextWindow?: number
  reasoningEfforts?: Record<string, string | null>
}
export declare const REASONING_EFFORTS: string[]
export declare const PI_AI_PROTOCOLS: string[]
export declare const DEFAULT_MODEL_ROUTE: Readonly<{ provider: string; model: string; reasoningEffort: string }>
export declare function renderTemplate(template: string, values: Record<string, unknown>): string
export declare function yamlScalar(value: unknown): string
export declare function normalizeModelConfig(input: unknown): ClusterModelRoute
export declare function modelRouteOf(config: { defaults?: { model?: unknown } } | undefined,
  instance: { name?: string; model?: unknown } | undefined): ClusterModelRoute
export declare function renderModelProviders(route: ClusterModelRoute): string
export declare function normalizeRepository(value: unknown): string
export declare function deriveInstance(repository: string, existing?: readonly { name: string }[]): { name: string; profile: string }
export declare function nextPort(base: number, instances?: readonly { port?: number }[]): number
export declare function prepareCommand(clone: string): string
export declare function findWebUrl(log: string): string | undefined
export declare function originOf(url: string): string | undefined
export declare function renderProfilePatch(template: string, input: { port: number; stateDir: string; platform?: string; model?: unknown }): string
export declare function expandPath(value: string | undefined, cwd?: string): string | undefined
export declare function cleanEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
