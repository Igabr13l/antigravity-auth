import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Host } from '@opencode-ai/plugin/host'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../')
const PACKAGE_ROOT = join(REPO_ROOT, 'packages/opencode-v2')
const CORE_ROOT = join(REPO_ROOT, 'packages/core')
const PACKAGE_NAME = '@cortexkit/opencode-v2-antigravity-auth'

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`,
    )
  }
  return result.stdout
}

function pack(packageRoot: string, destination: string): string {
  const output = run(
    'bun',
    ['pm', 'pack', '--destination', destination],
    packageRoot,
  )
  const tarball = output
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz') && existsSync(line))
  if (!tarball) {
    throw new Error(`bun pm pack did not report a tarball for ${packageRoot}`)
  }
  return tarball
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agy-opencode2-pack-'))
  try {
    const packDir = join(root, 'pack')
    const consumerDir = join(root, 'consumer')
    mkdirSync(packDir, { recursive: true })
    mkdirSync(consumerDir, { recursive: true })

    const coreTarball = pack(CORE_ROOT, packDir)
    const adapterTarball = pack(PACKAGE_ROOT, packDir)
    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'antigravity-opencode2-pack-consumer',
          private: true,
          type: 'module',
          dependencies: { [PACKAGE_NAME]: adapterTarball },
          overrides: {
            '@cortexkit/antigravity-auth-core': coreTarball,
          },
        },
        null,
        2,
      )}\n`,
    )
    run('bun', ['install', '--no-save'], consumerDir)

    const resolved = Host.resolve({
      directory: consumerDir,
      name: PACKAGE_NAME,
    })
    if (!resolved.server) {
      throw new Error(
        'OpenCode 2 host resolver did not discover a server entry',
      )
    }
    if (!resolved.tui || !resolved.rpc) {
      throw new Error(
        'OpenCode 2 host resolver requires TUI and RPC compatibility exports',
      )
    }
    if (
      existsSync(join(consumerDir, 'node_modules', '@opencode-ai', 'plugin'))
    ) {
      throw new Error(
        'Packed adapter unexpectedly installed the host plugin SDK',
      )
    }
    const installedRoot = join(
      consumerDir,
      'node_modules',
      '@cortexkit',
      'opencode-v2-antigravity-auth',
    )
    const resolvedPath = realpathSync(fileURLToPath(resolved.server))
    const installedPath = realpathSync(installedRoot)
    const installedRelative = relative(installedPath, resolvedPath)
    if (installedRelative.startsWith('..') || isAbsolute(installedRelative)) {
      throw new Error(
        `Host resolver escaped installed package: ${resolved.server}`,
      )
    }
    const manifest = JSON.parse(
      readFileSync(join(installedRoot, 'package.json'), 'utf8'),
    ) as { files?: string[]; 'oc-plugin'?: string[] }
    if (
      !manifest.files?.includes('dist/') ||
      !manifest.files.includes('CHANGELOG.md') ||
      manifest['oc-plugin']?.[0] !== 'server' ||
      !manifest['oc-plugin']?.includes('tui')
    ) {
      throw new Error('Packed OpenCode 2 manifest lost its server contract')
    }
    const module = (await import(resolved.server)) as {
      default?: { setup?: unknown }
    }
    if (typeof module.default?.setup !== 'function') {
      throw new Error('Packed OpenCode 2 server entry has no setup function')
    }
    // The TUI entry is host-consumed: OpenCode 2's loader rewrites its
    // `@opentui/solid/jsx-runtime` import to the embedded runtime, so it only
    // resolves outside the host when that runtime is installed. Assert the
    // packed resolution path instead of importing it here.
    const tuiPath = realpathSync(fileURLToPath(resolved.tui))
    const tuiRelative = relative(installedPath, tuiPath)
    if (tuiRelative.startsWith('..') || isAbsolute(tuiRelative)) {
      throw new Error(
        `Packed OpenCode 2 TUI entry escaped the installed package: ${resolved.tui}`,
      )
    }
    const rpcModule = (await import(resolved.rpc)) as {
      default?: { id?: unknown }
    }
    if (typeof rpcModule.default?.id !== 'string') {
      throw new Error('Packed OpenCode 2 compatibility RPC entry is invalid')
    }

    console.log(
      `[smoke:pack] OK — packed package resolved through Host.resolve at ${resolved.server}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
