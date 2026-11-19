/** Mount the real Superagent panel. The DSH client slot in src/client/index.tsx is not used:
    this stand-in has no Cordis host. English is forced; a Desktop session follows the host locale. */
import { createRoot } from 'react-dom/client'
import { App } from '../../../../src/client/app.tsx'
import { en } from '../../../../src/client/locales.ts'
import type { T } from '../../../../src/client/text.ts'

const dictionary = en as Record<string, string>
const t = ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}) as T

const root = document.getElementById('root')
if (!root) throw new Error('verification page is missing #root')
createRoot(root).render(<App t={t} openSession={async () => {
  throw new Error('The Linux stand-in has no DSH Session catalog. Open main Session stays unverified.')
}} deploymentForm={undefined} />)
