import { describe, expect, it } from 'bun:test'

import {
  ANTIGRAVITY_CODING_IDENTITY,
  ANTIGRAVITY_GENERIC_IDENTITY,
  applyOpenCodeCamouflageInPlace,
  buildToolNameMapping,
  restoreClientFunctionCallsInPlace,
} from '../src/camouflage.ts'

describe('OpenCode 2 payload camouflage', () => {
  it('replaces OpenCode coding preamble, strips <system-reminder>, injects Antigravity identity, and translates tools bidirectionally', () => {
    const payload = {
      systemInstruction: {
        role: 'user',
        parts: [
          {
            text: [
              'You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.',
              '',
              '# Harness',
              '- Responses are rendered as GitHub-flavored Markdown.',
              '- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.',
              '- Use the write tool to create files and prefer the edit tool for targeted changes.',
              '- Prefer `grep` over `bash` for text searches.',
            ].join('\n'),
          },
          {
            text: '<system-reminder>Follow AGENTS.md in /Users/dev/project/opencode-helper</system-reminder>',
          },
        ],
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'bash',
              description: 'Execute a shell command.',
              parameters: {
                type: 'OBJECT',
                properties: {
                  command: {
                    type: 'STRING',
                    description: 'Command to execute via bash tool.',
                  },
                },
              },
            },
            {
              name: 'read',
              description: 'Read a file.',
            },
            {
              name: 'edit',
              description: 'Edit a file.',
            },
            {
              name: 'write',
              description: 'Write a file.',
            },
            {
              name: 'grep',
              description: 'Search with ripgrep.',
            },
            {
              name: 'glob',
              description: 'Glob files.',
            },
            {
              name: 'webfetch',
              description:
                'Fetch URLs with Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OpenCode-User/1.0; +https://opencode.ai',
            },
            {
              name: 'todowrite',
              description: 'Manage todos.',
            },
            {
              name: 'custom_mcp_tool',
              description: 'Project MCP tool.',
            },
          ],
        },
      ],
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Check package.json' },
            { text: '<system-reminder>Plan mode disabled.</system-reminder>' },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read',
                args: { filePath: 'package.json' },
              },
              thoughtSignature: 'sig-1',
            },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { output: '{"name":"demo"}' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [{ text: '[Continue]' }],
        },
      ],
    }

    const { clientToWire, wireToClient } =
      applyOpenCodeCamouflageInPlace(payload)

    expect(clientToWire.get('bash')).toBe('run_command')
    expect(clientToWire.get('read')).toBe('read_file')
    expect(clientToWire.get('edit')).toBe('edit_file')
    expect(clientToWire.get('write')).toBe('write_file')
    expect(clientToWire.get('grep')).toBe('grep_search')
    expect(clientToWire.get('glob')).toBe('find_by_name')
    expect(clientToWire.get('webfetch')).toBe('read_url_content')
    expect(clientToWire.get('todowrite')).toBe('manage_task')
    expect(clientToWire.get('custom_mcp_tool')).toBe('custom_mcp_tool')

    expect(wireToClient.get('run_command')).toBe('bash')
    expect(wireToClient.get('read_file')).toBe('read')
    expect(wireToClient.get('read_url_content')).toBe('webfetch')

    const sys = payload.systemInstruction as {
      role?: string
      parts: Array<{ text: string }>
    }
    expect(sys.role).toBeUndefined()
    expect(sys.parts[0]?.text.startsWith(ANTIGRAVITY_CODING_IDENTITY)).toBe(
      true,
    )
    expect(sys.parts[0]?.text).not.toContain(
      'You are an AI agent running in OpenCode',
    )
    expect(sys.parts[0]?.text).not.toContain('# Harness')
    expect(sys.parts[0]?.text).not.toContain('<system-reminder>')
    expect(sys.parts[0]?.text).toContain('# Guidelines')
    expect(sys.parts[0]?.text).toContain('`<system_context>`')
    expect(sys.parts[0]?.text).toContain('workspace instructions')
    expect(sys.parts[0]?.text).not.toContain('harness instructions')
    expect(sys.parts[0]?.text).toContain('write_file tool')
    expect(sys.parts[0]?.text).toContain('edit_file tool')
    expect(sys.parts[0]?.text).toContain('`grep_search`')
    expect(sys.parts[0]?.text).toContain('`run_command`')
    // Workspace paths containing "opencode" must not be corrupted.
    expect(sys.parts[1]?.text).toBe(
      '<system_context>Follow AGENTS.md in /Users/dev/project/opencode-helper</system_context>',
    )

    const decls = payload.tools[0]?.functionDeclarations ?? []
    expect(decls.map((d) => d.name)).toEqual([
      'run_command',
      'read_file',
      'edit_file',
      'write_file',
      'grep_search',
      'find_by_name',
      'read_url_content',
      'manage_task',
      'custom_mcp_tool',
    ])
    expect(decls[0]?.parameters?.properties?.command?.description).toBe(
      'Command to execute via run_command tool.',
    )
    expect(decls[6]?.description).not.toContain('OpenCode')
    expect(decls[6]?.description).not.toContain('opencode.ai')
    expect(decls[6]?.description).toContain('Antigravity/1.0')

    expect(payload.contents[0]?.parts[0]).toEqual({
      text: '<USER_REQUEST>\nCheck package.json\n</USER_REQUEST>',
    })
    expect(payload.contents[0]?.parts[1]).toEqual({
      text: '<system_context>Plan mode disabled.</system_context>',
    })
    expect(payload.contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'read_file', args: { filePath: 'package.json' } },
      thoughtSignature: 'sig-1',
    })
    expect(payload.contents[2]?.parts[0]).toEqual({
      functionResponse: {
        name: 'read_file',
        response: { output: '{"name":"demo"}' },
      },
    })
    expect(payload.contents[3]?.parts[0]).toEqual({ text: '[Continue]' })

    // Upstream model emits Antigravity wire names; response helper restores client names.
    const upstreamFrame = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'run_command',
                  args: { command: 'bun test' },
                },
              },
              {
                functionCall: {
                  name: 'custom_mcp_tool',
                  args: { q: 'hi' },
                },
              },
            ],
          },
        },
      ],
    }
    restoreClientFunctionCallsInPlace(upstreamFrame, wireToClient)
    expect(
      upstreamFrame.candidates[0]?.content.parts.map(
        (p) => (p.functionCall as { name: string }).name,
      ),
    ).toEqual(['bash', 'custom_mcp_tool'])
  })

  it('uses generic Antigravity identity on tool-less payloads such as title generation and is idempotent', () => {
    const payload = {
      systemInstruction:
        'You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.\nGenerate a concise title.',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Here is the first message of the conversation:\n\n<message>\nhola\n</message>\n\nReply with only the title.',
            },
          ],
        },
      ],
    }

    applyOpenCodeCamouflageInPlace(payload)
    const sys = payload.systemInstruction as unknown as {
      parts: Array<{ text: string }>
    }
    expect(sys.parts[0]?.text.startsWith(ANTIGRAVITY_GENERIC_IDENTITY)).toBe(
      true,
    )
    expect(sys.parts[0]?.text).toContain('Generate a concise title.')
    expect(sys.parts[0]?.text).not.toContain('opencode')
    expect(payload.contents[0]?.parts[0]?.text).toBe(
      '<USER_REQUEST>\nHere is the first message of the conversation:\n\n<message>\nhola\n</message>\n\nReply with only the title.\n</USER_REQUEST>',
    )

    const snapshot = structuredClone(payload)
    applyOpenCodeCamouflageInPlace(payload)
    expect(payload).toEqual(snapshot)
  })

  it('keeps distinct wire names when colliding tools are declared together', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'bash' },
          { name: 'shell' },
          { name: 'read_file' },
          { name: 'read' },
        ],
      },
    ]
    const { clientToWire, wireToClient } = buildToolNameMapping(tools)

    expect(clientToWire.get('read_file')).toBe('read_file')
    expect(clientToWire.get('read')).not.toBe('read_file')
    expect(new Set(clientToWire.values()).size).toBe(4)
    expect(wireToClient.size).toBe(4)
  })
})
