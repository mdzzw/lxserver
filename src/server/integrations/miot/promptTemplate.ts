export const PROMPT_TEMPLATE_MAX_LENGTH = 3000

export const normalizePromptTemplate = (value: unknown): string =>
  String(value ?? '').trim().slice(0, PROMPT_TEMPLATE_MAX_LENGTH)

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const stripPromptMarker = (text: string, marker: string): string =>
  String(text || '').replace(new RegExp(`^\\s*${escapeRegExp(marker)}\\s*[：:]\\s*`), '')

export interface RenderedPromptTemplate {
  text: string
  used: Set<string>
}

export const renderPromptTemplate = (template: string, values: Record<string, string>): RenderedPromptTemplate => {
  const used = new Set<string>()
  const text = String(template || '').replace(/\{([a-zA-Z]+)\}/g, (match, key: string) => {
    if (!(key in values)) return match
    used.add(key)
    return values[key]
  })
  return { text, used }
}
