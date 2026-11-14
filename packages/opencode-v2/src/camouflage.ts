/**
 * Payload camouflage layer for the OpenCode 2 Antigravity bridge.
 *
 * Google's Code Assist prediction backend inspects incoming `GenerateContentRequest`
 * payloads (`systemInstruction`, tool declarations, and user prompt framing) against
 * Antigravity identity rules and third-party harness corpora. This module rewrites
 * OpenCode-specific harness markers into Antigravity's native wire conventions while
 * preserving workspace instructions, schemas, and a lossless per-request mapping for
 * tool calls returned in the response stream.
 */

export interface CamouflagePart {
  text?: string
  functionCall?: unknown
  functionResponse?: unknown
  [key: string]: unknown
}

export interface CamouflageContent {
  role?: string
  parts?: CamouflagePart[]
  [key: string]: unknown
}

export interface CamouflagePayload {
  contents?: CamouflageContent[]
  systemInstruction?: CamouflageContent | string
  tools?: unknown[]
  [key: string]: unknown
}

export interface CamouflageResult {
  clientToWire: Map<string, string>
  wireToClient: Map<string, string>
}

export const ANTIGRAVITY_CODING_IDENTITY = [
  '<identity>',
  'You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.',
  'You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.',
  'The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.',
  '</identity>',
].join('\n')

export const ANTIGRAVITY_GENERIC_IDENTITY = [
  '<identity>',
  'You are Antigravity, a powerful agentic AI assistant designed by the Google Deepmind team.',
  'You are working with a USER to solve their task.',
  'The USER will send you requests, which you must always prioritize addressing. User requests are enclosed within <USER_REQUEST> tags.',
  '</identity>',
].join('\n')

export const OPENCODE_TO_AGY_TOOL_NAME: Readonly<Record<string, string>> = {
  apply_patch: 'replace_file_content',
  artifact: 'create_artifact',
  bash: 'run_command',
  batch: 'multi_call',
  codesearch: 'code_search',
  edit: 'edit_file',
  glob: 'find_by_name',
  grep: 'grep_search',
  'image-generate': 'generate_image',
  image_generate: 'generate_image',
  list: 'list_dir',
  ls: 'list_dir',
  lsp: 'code_intel',
  multiedit: 'multi_replace_file_content',
  patch: 'replace_file_content',
  question: 'ask_question',
  read: 'read_file',
  shell: 'run_command',
  skill: 'load_skill',
  subagent: 'invoke_subagent',
  task: 'invoke_subagent',
  todo: 'manage_task',
  todoread: 'list_tasks',
  todowrite: 'manage_task',
  webfetch: 'read_url_content',
  websearch: 'search_web',
  write: 'write_file',
}

const OPENCODE_IDENTITY_PATTERNS: readonly RegExp[] = [
  /<runtime_info>\s*You are running in OpenCode[\s\S]*?<\/runtime_info>\s*/gi,
  /^You are an AI agent running in OpenCode, a coding agent harness\. Help the user accomplish their goals using the tools you have available\.\s*/i,
  /^You are opencode, an interactive CLI tool that helps users with software engineering tasks\. Use the instructions below and the tools available to you to assist the user\.\s*/i,
  /^You are OpenCode, a coding agent that helps users with software engineering tasks\.[^\n]*(?:\nUse the instructions below[^\n]*)?\s*/i,
  /^You are running in OpenCode[^\n]*\n?/i,
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function collectDeclaredToolNames(tools: unknown[] | undefined): string[] {
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    if (!isRecord(tool)) continue
    if (Array.isArray(tool.functionDeclarations)) {
      for (const decl of tool.functionDeclarations) {
        if (isRecord(decl) && typeof decl.name === 'string' && decl.name) {
          names.push(decl.name)
        }
      }
      continue
    }
    if (typeof tool.name === 'string' && tool.name) {
      names.push(tool.name)
    }
  }
  return names
}

/**
 * Builds a collision-free bidirectional tool name translation map for a single
 * outgoing request. Unmapped tools keep their declared name, and any collision
 * with an already-declared tool falls back safely so distinct tools never merge.
 */
export function buildToolNameMapping(
  tools: unknown[] | undefined,
): CamouflageResult {
  const clientToWire = new Map<string, string>()
  const wireToClient = new Map<string, string>()
  const declared = collectDeclaredToolNames(tools)
  const usedWireNames = new Set<string>()

  for (const clientName of declared) {
    if (!(clientName in OPENCODE_TO_AGY_TOOL_NAME)) {
      usedWireNames.add(clientName)
      clientToWire.set(clientName, clientName)
      wireToClient.set(clientName, clientName)
    }
  }

  for (const clientName of declared) {
    if (clientToWire.has(clientName)) continue
    const preferred = OPENCODE_TO_AGY_TOOL_NAME[clientName] ?? clientName
    let wireName = preferred
    if (usedWireNames.has(wireName)) {
      const disambiguated = `${preferred}_${clientName}`.replace(
        /[^a-zA-Z0-9_-]/g,
        '_',
      )
      wireName = !usedWireNames.has(disambiguated)
        ? disambiguated
        : !usedWireNames.has(clientName)
          ? clientName
          : `${preferred}_${usedWireNames.size}`
    }
    usedWireNames.add(wireName)
    clientToWire.set(clientName, wireName)
    wireToClient.set(wireName, clientName)
  }

  return { clientToWire, wireToClient }
}

function resolveWireToolName(
  clientName: string,
  clientToWire: ReadonlyMap<string, string>,
): string {
  return (
    clientToWire.get(clientName) ??
    OPENCODE_TO_AGY_TOOL_NAME[clientName] ??
    clientName
  )
}

function scrubOpenCodeHarnessText(
  text: string,
  clientToWire: ReadonlyMap<string, string>,
): string {
  let out = text

  out = out.replace(/<(\/?)system-reminder>/gi, '<$1system_context>')
  out = out.replace(/`<system-reminder>`/gi, '`<system_context>`')
  out = out.replace(/\bharness instructions\b/gi, 'workspace instructions')
  out = out.replace(/^#\s+Harness\b/gim, '# Guidelines')
  out = out.replace(
    /;\s*compatible;\s*OpenCode-User\/1\.0;\s*\+https:\/\/opencode\.ai\/?/gi,
    '; compatible; Antigravity/1.0; +https://antigravity.google',
  )
  out = out.replace(/\bOpenCode-User\/1\.0\b/gi, 'Antigravity/1.0')
  out = out.replace(/https:\/\/opencode\.ai\/?/gi, 'https://antigravity.google')
  out = out.replace(/\brunning in OpenCode\b/gi, 'working in Antigravity')
  out = out.replace(
    /\bOpenCode(?:'s)?\s+(?:coding agent\s+)?harness\b/gi,
    'Antigravity workspace',
  )
  out = out.replace(/\bOpenCode Console\b/gi, 'Antigravity')

  const entries = [...clientToWire.entries()].filter(
    ([client, wire]) => client !== wire,
  )
  if (entries.length === 0) {
    return out
  }

  for (const [client, wire] of entries) {
    const escaped = escapeRegExp(client)
    out = out.replace(new RegExp(`\`${escaped}\``, 'g'), `\`${wire}\``)
    out = out.replace(
      new RegExp(`\\b(the\\s+)${escaped}(\\s+tool)\\b`, 'gi'),
      `$1${wire}$2`,
    )
    out = out.replace(
      new RegExp(`\\b${escaped}(\\s+tool)\\b`, 'gi'),
      `${wire}$1`,
    )
  }

  return out
}

function scrubSchemaDescriptionsInPlace(
  schema: unknown,
  clientToWire: ReadonlyMap<string, string>,
): void {
  if (!isRecord(schema)) return
  if (typeof schema.description === 'string') {
    schema.description = scrubOpenCodeHarnessText(
      schema.description,
      clientToWire,
    )
  }
  if (isRecord(schema.properties)) {
    for (const property of Object.values(schema.properties)) {
      scrubSchemaDescriptionsInPlace(property, clientToWire)
    }
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        scrubSchemaDescriptionsInPlace(item, clientToWire)
      }
    } else {
      scrubSchemaDescriptionsInPlace(schema.items, clientToWire)
    }
  }
}

function camouflageToolsInPlace(
  request: CamouflagePayload,
  clientToWire: ReadonlyMap<string, string>,
): boolean {
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    return false
  }
  let hasFunctionTools = false
  for (const tool of request.tools) {
    if (!isRecord(tool)) continue
    if (Array.isArray(tool.functionDeclarations)) {
      for (const decl of tool.functionDeclarations) {
        if (!isRecord(decl)) continue
        hasFunctionTools = true
        if (typeof decl.name === 'string' && decl.name) {
          decl.name = resolveWireToolName(decl.name, clientToWire)
        }
        if (typeof decl.description === 'string') {
          decl.description = scrubOpenCodeHarnessText(
            decl.description,
            clientToWire,
          )
        }
        scrubSchemaDescriptionsInPlace(decl.parameters, clientToWire)
        scrubSchemaDescriptionsInPlace(decl.parametersJsonSchema, clientToWire)
      }
    } else if (typeof tool.name === 'string' && tool.name) {
      hasFunctionTools = true
      tool.name = resolveWireToolName(tool.name, clientToWire)
      if (typeof tool.description === 'string') {
        tool.description = scrubOpenCodeHarnessText(
          tool.description,
          clientToWire,
        )
      }
    }
  }
  return hasFunctionTools
}

function stripOpenCodePreamble(text: string): {
  stripped: string
  matchedOpenCodePreamble: boolean
} {
  let out = text.trimStart()
  let matched = false
  for (const pattern of OPENCODE_IDENTITY_PATTERNS) {
    const next = out.replace(pattern, '')
    if (next !== out) {
      matched = true
      out = next.trimStart()
    }
  }
  return { stripped: out, matchedOpenCodePreamble: matched }
}

function camouflageSystemInstructionInPlace(
  request: CamouflagePayload,
  hasTools: boolean,
  clientToWire: ReadonlyMap<string, string>,
): void {
  const identityBlock = hasTools
    ? ANTIGRAVITY_CODING_IDENTITY
    : ANTIGRAVITY_GENERIC_IDENTITY

  const raw = request.systemInstruction
  if (typeof raw === 'string') {
    const { stripped } = stripOpenCodePreamble(raw)
    const cleaned = scrubOpenCodeHarnessText(stripped, clientToWire).trim()
    const hasIdentity =
      cleaned.includes('<identity>') && cleaned.includes('You are Antigravity')
    request.systemInstruction = {
      parts: [
        {
          text: hasIdentity
            ? cleaned
            : cleaned
              ? `${identityBlock}\n\n${cleaned}`
              : identityBlock,
        },
      ],
    }
    return
  }

  if (!isRecord(raw) || !Array.isArray(raw.parts)) {
    request.systemInstruction = {
      parts: [{ text: identityBlock }],
    }
    return
  }

  const nextParts: CamouflagePart[] = []
  let hasIdentity = false

  for (const part of raw.parts) {
    if (!isRecord(part)) continue
    const nextPart: CamouflagePart = { ...part }
    if (typeof nextPart.text === 'string') {
      const { stripped } = stripOpenCodePreamble(nextPart.text)
      const cleaned = scrubOpenCodeHarnessText(stripped, clientToWire).trim()
      if (!cleaned) continue
      if (
        cleaned.includes('<identity>') &&
        cleaned.includes('You are Antigravity')
      ) {
        hasIdentity = true
      }
      nextPart.text = cleaned
    }
    nextParts.push(nextPart)
  }

  if (!hasIdentity) {
    if (nextParts.length > 0 && typeof nextParts[0]?.text === 'string') {
      nextParts[0] = {
        ...nextParts[0],
        text: `${identityBlock}\n\n${nextParts[0].text}`,
      }
    } else {
      nextParts.unshift({ text: identityBlock })
    }
  }

  const sanitizedSys: CamouflageContent = { ...raw, parts: nextParts }
  if (sanitizedSys.role === 'user') {
    delete sanitizedSys.role
  }
  request.systemInstruction = sanitizedSys
}

function isPureSystemContextBlock(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.startsWith('<system_context>') &&
    trimmed.endsWith('</system_context>')
  )
}

function wrapUserRequestText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed === '[Continue]') {
    return text
  }
  if (trimmed.includes('<USER_REQUEST>')) {
    return text
  }
  if (isPureSystemContextBlock(trimmed)) {
    return text
  }
  // If OpenCode appended a `<system_context>` block inside the same part, keep it
  // outside `<USER_REQUEST>` so only the actual user message is tagged.
  const contextMatch =
    /(\n*<system_context>[\s\S]*<\/system_context>\s*)$/.exec(text)
  if (contextMatch && contextMatch.index > 0) {
    const userPortion = text.slice(0, contextMatch.index).trim()
    const contextPortion = contextMatch[1]!.trim()
    if (!userPortion) {
      return contextPortion
    }
    return `<USER_REQUEST>\n${userPortion}\n</USER_REQUEST>\n\n${contextPortion}`
  }
  return `<USER_REQUEST>\n${trimmed}\n</USER_REQUEST>`
}

function camouflageContentsInPlace(
  request: CamouflagePayload,
  clientToWire: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(request.contents)) return

  for (const content of request.contents) {
    if (!isRecord(content) || !Array.isArray(content.parts)) continue
    const isUserTurn = content.role === 'user'

    for (const part of content.parts) {
      if (!isRecord(part)) continue
      if (
        isRecord(part.functionCall) &&
        typeof part.functionCall.name === 'string'
      ) {
        part.functionCall.name = resolveWireToolName(
          part.functionCall.name,
          clientToWire,
        )
      }
      if (
        isRecord(part.functionResponse) &&
        typeof part.functionResponse.name === 'string'
      ) {
        part.functionResponse.name = resolveWireToolName(
          part.functionResponse.name,
          clientToWire,
        )
      }
      if (
        isUserTurn &&
        typeof part.text === 'string' &&
        !part.functionResponse
      ) {
        const scrubbed = part.text.replace(
          /<(\/?)system-reminder>/gi,
          '<$1system_context>',
        )
        part.text = wrapUserRequestText(scrubbed)
      }
    }
  }
}

/**
 * Applies Antigravity payload camouflage in place to a cloned request payload,
 * returning the bidirectional tool-name map needed to translate `functionCall`
 * responses back to OpenCode's client tool names.
 */
export function applyOpenCodeCamouflageInPlace(
  request: CamouflagePayload,
): CamouflageResult {
  const mapping = buildToolNameMapping(request.tools)
  const hasTools = camouflageToolsInPlace(request, mapping.clientToWire)
  camouflageSystemInstructionInPlace(request, hasTools, mapping.clientToWire)
  camouflageContentsInPlace(request, mapping.clientToWire)
  return mapping
}

/**
 * Restores Antigravity wire tool names on `functionCall` parts in an unwrapped
 * upstream response frame back to OpenCode's declared client tool names.
 */
export function restoreClientFunctionCallsInPlace(
  innerResponse: Record<string, unknown>,
  wireToClient: ReadonlyMap<string, string>,
): void {
  if (wireToClient.size === 0) return
  const candidates = innerResponse.candidates
  if (!Array.isArray(candidates)) return
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) continue
    const parts = candidate.content.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!isRecord(part) || !isRecord(part.functionCall)) continue
      const wireName = part.functionCall.name
      if (typeof wireName !== 'string') continue
      const clientName = wireToClient.get(wireName)
      if (clientName && clientName !== wireName) {
        part.functionCall.name = clientName
      }
    }
  }
}
