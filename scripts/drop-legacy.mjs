/**
 * Drop the pre-TypeScript artifacts once the running Harness has been restarted.
 *
 * Until a restart, the live host still holds the entry paths it resolved from the
 * old `package.json` (`./index.js`, `./client.js`); deleting them underneath it
 * would leave the panel stat'ing a file that no longer exists. After a restart
 * `dist/` is the only entry, and these three hand-written files plus the old
 * `test/host.mjs` are pure duplication.
 *
 * Refuses to run while `package.json` still points anywhere but `dist/`.
 */
import { existsSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const entry = typeof manifest.main === 'string' ? manifest.main : ''
const client = manifest.exports?.['./client']
if (!entry.startsWith('./dist/') || typeof client !== 'string' || !client.startsWith('./dist/')) {
  throw new Error('drop-legacy: package.json does not point at dist/ yet; nothing removed')
}

const legacy = ['index.js', 'mise.js', 'client.js', 'test/host.mjs']
const removed = []
for (const relative of legacy) {
  const target = new URL(relative, root)
  if (!existsSync(target)) continue
  rmSync(target)
  removed.push(relative)
}
process.stdout.write(removed.length ? `drop-legacy: removed ${removed.join(', ')}\n` : 'drop-legacy: nothing left to remove\n')
