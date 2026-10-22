/**
 * Seal the browser half after `tsc`.
 *
 * `module: NodeNext` + `"type": "module"` make every source file a module, so
 * tsc appends a bare `export {};` to `dist/client.js` to keep the file a module
 * even though the bundle has no imports or exports of its own. The Harness
 * serves plugin bundles as a classic `<script src>` (the client module registry
 * reads the bundle bytes and hands them to the page as `text/javascript`), and a
 * classic script cannot contain `export` — the page would die with a SyntaxError
 * and the settings section would never register.
 *
 * So: drop that one statement and prove the result still parses as a classic
 * script. Everything else in the emitted file is left exactly as tsc wrote it
 * (including the source-map trailer, whose lines all precede the marker).
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'

const TARGET = new URL('../dist/client.js', import.meta.url)
const MARKER = /^export \{\};?[ \t]*\r?\n/m

const original = readFileSync(TARGET, 'utf8')
const sealed = original.replace(MARKER, '')

if (sealed === original) {
  // Already script-shaped: nothing to strip. Still checked below, because a
  // missing marker must not hide a real problem.
  process.stdout.write('finish-client: no module marker to strip\n')
} else {
  writeFileSync(TARGET, sealed)
  process.stdout.write('finish-client: stripped the trailing `export {}` marker\n')
}

if (!sealed.includes('window.__ModuleLoader__.load(')) {
  throw new Error('finish-client: dist/client.js no longer registers itself on window.__ModuleLoader__')
}

// The whole point: this must parse the way a browser parses a classic script.
new Script(sealed, { filename: 'dist/client.js' })
process.stdout.write('finish-client: dist/client.js parses as a classic script\n')

// Bridge for the host that is already running: it resolved `./client.js` from
// the pre-TypeScript manifest and keeps stat'ing that path, so a rebuild in
// `dist/` never reaches the browser until a restart. While that legacy copy
// still exists, keep it identical to the real bundle — and once the host has
// been restarted, `npm run legacy:drop` deletes it for good.
const legacy = new URL('../client.js', import.meta.url)
if (existsSync(legacy)) {
  copyFileSync(TARGET, legacy)
  process.stdout.write('finish-client: synced the legacy root copy client.js (running-host bridge)\n')
}
