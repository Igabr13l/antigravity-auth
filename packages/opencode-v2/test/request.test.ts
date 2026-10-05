import { describe, expect, it } from 'bun:test'

import {
  AgyRequestSessionStore,
  resolveModelForHeaderStyle,
  SKIP_THOUGHT_SIGNATURE,
} from '@cortexkit/antigravity-auth-core'

import { buildEnvelope, resolveJobSessionID } from '../src/plugin.ts'

function scopeForRequest() {
  const sessions = new AgyRequestSessionStore('opencode-v2-request-test')
  return sessions.beginRequest('session')
}

describe('OpenCode 2 Antigravity request envelope', () => {
  it('appends a real user turn when the host payload ends with a model turn', () => {
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'Start' }] },
        { role: 'model', parts: [{ text: 'Previous answer' }] },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.7-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('applies the shared Claude thinking and schema transform', () => {
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              text: 'foreign thought',
              thought: true,
              thoughtSignature: 'gemini-signature',
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'claude-sonnet-4-6-thinking',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
    )
    const generationConfig = envelope.request.generationConfig
    expect(generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 1024,
    })
    expect(generationConfig?.maxOutputTokens).toBe(64_000)
    expect(
      envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature,
    ).toBeUndefined()
    expect(
      (
        envelope.request.toolConfig?.functionCallingConfig as
          | { mode?: string }
          | undefined
      )?.mode,
    ).toBe('VALIDATED')
  })

  it('normalizes replay signatures across parallel function calls', () => {
    const validSignature = 's'.repeat(64)
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'first', args: {} },
              thoughtSignature: validSignature,
            },
            {
              functionCall: { name: 'second', args: {} },
              thoughtSignature: 'other'.repeat(20),
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.8-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-gemini',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.[0]?.parts).toEqual([
      {
        functionCall: { name: 'first', args: {} },
        thoughtSignature: validSignature,
      },
      { functionCall: { name: 'second', args: {} } },
    ])
  })

  it('injects the supported sentinel when Claude replay has no valid signature', () => {
    const payload = {
      contents: [
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read_file', args: { path: 'a.ts' } },
              thoughtSignature: 'c'.repeat(64),
            },
          ],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'claude-sonnet-4-6-thinking',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature).toBe(
      SKIP_THOUGHT_SIGNATURE,
    )

    const sameModelEnvelope = buildEnvelope(
      payload,
      resolved,
      'project-claude',
      scopeForRequest(),
      { preserveFunctionCallSignatures: true },
    )
    expect(
      sameModelEnvelope.request.contents?.[0]?.parts?.[0]?.thoughtSignature,
    ).toBe('c'.repeat(64))
  })

  it('uses the native model role for same-target function responses', () => {
    const payload = {
      contents: [
        { role: 'user', parts: [{ text: 'Read the file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'read', args: { path: 'README.md' } },
              thoughtSignature: 's'.repeat(64),
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { output: 'contents' },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.8-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'project-gemini',
      scopeForRequest(),
    )
    expect(envelope.request.contents?.at(-2)?.role).toBe('model')
    expect(envelope.request.contents?.at(-1)).toEqual({
      role: 'user',
      parts: [{ text: '[Continue]' }],
    })
  })

  it('removes unsupported tools and thinking from image requests', () => {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Draw a lighthouse' }] }],
      tools: [{ functionDeclarations: [{ name: 'read' }] }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { thinkingConfig: { thinkingBudget: 1024 } },
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.1-flash-image',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.tools).toBeUndefined()
    expect(envelope.request.toolConfig).toBeUndefined()
    expect(envelope.request.generationConfig).toMatchObject({
      imageConfig: { aspectRatio: '1:1' },
      candidateCount: 1,
    })
    expect(envelope.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('sets VALIDATED on tool requests and removes host provider options', () => {
    const payload = {
      contents: [{ role: 'user', parts: [{ text: 'Use a tool' }] }],
      providerOptions: { google: { opaque: true } },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
              },
            },
          ],
        },
      ],
    }
    const resolved = resolveModelForHeaderStyle(
      'gemini-3.7-flash-medium',
      'antigravity',
    )

    const envelope = buildEnvelope(
      payload,
      resolved,
      'request-test-project',
      scopeForRequest(),
    )

    expect(envelope.request.providerOptions).toBeUndefined()
    expect(envelope.request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    })
  })
})

describe('resolveJobSessionID', () => {
  it('keeps a real session id, trimmed', () => {
    expect(resolveJobSessionID('ses-1', () => 'unused')).toBe('ses-1')
    expect(resolveJobSessionID('  ses-2  ', () => 'unused')).toBe('ses-2')
  })

  it('isolates anonymous requests instead of collapsing them onto one key', () => {
    // Regression: an omitted sessionID fell back to a shared '__default__'
    // key, so unrelated sessions shared one AGY conversation/trajectory and
    // could mix thinking signatures.
    const first = resolveJobSessionID('', () => 'a')
    const second = resolveJobSessionID(undefined, () => 'b')
    expect(first).toBe('anonymous:a')
    expect(second).toBe('anonymous:b')
    expect(first).not.toBe(second)
  })
})
