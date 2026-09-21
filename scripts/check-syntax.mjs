/**
 * Parses every main-process, provider, and server module.
 *
 * These directories hold plain `.cjs`/`.mjs` that `tsc` never sees, so a syntax
 * error in them survives `npm run typecheck` and only surfaces at runtime — in
 * the packaged app, or on a deployed server. This used to be two scripts
 * enumerating each file by hand, which meant every new module had to be
 * remembered; walking the directories instead means it cannot be forgotten.
 */
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const ROOTS = ['electron', 'providers', 'server', 'scripts']
const EXTENSIONS = new Set(['.cjs', '.mjs'])

async function collect(dir) {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await collect(relative))
    else if (EXTENSIONS.has(path.extname(entry.name))) found.push(relative)
  }
  return found
}

const files = (await Promise.all(ROOTS.map(collect))).flat().sort()

if (!files.length) {
  // A silent pass over nothing would be worse than a failure: it would report
  // success for a check that is no longer looking at anything.
  console.error('check-syntax: no modules found — are the source directories still there?')
  process.exit(1)
}

const failures = []
await Promise.all(files.map(async (file) => {
  try {
    await run(process.execPath, ['--check', path.join(root, file)])
  } catch (error) {
    failures.push({ file, message: error.stderr?.trim() || error.message })
  }
}))

if (failures.length) {
  for (const { file, message } of failures.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(`\n${file}\n${message}`)
  }
  console.error(`\ncheck-syntax: ${failures.length} of ${files.length} modules failed to parse.`)
  process.exit(1)
}

console.log(`check-syntax: ${files.length} modules parsed.`)
