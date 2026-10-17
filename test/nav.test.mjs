/**
 * §3 (what reaches the lists) and §4 (in what order).
 *
 * These filters are the part of the feature most likely to be silently wrong —
 * an archived or subagent Session showing up on a phone is a bug nobody notices
 * until it is in front of them — so every rule in the table has a test.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { buildView, canonicalPath, collectSessions, folderPage, groupByWorkspace, sessionView } from '../lib/nav.mjs'
import { summary, tempDir, workspace } from './fixtures.mjs'

/** Two real directories, so path canonicalization is exercised for real. */
function twoFolders() {
  const root = tempDir()
  const alpha = path.join(root, 'alpha')
  const beta = path.join(root, 'beta')
  fs.mkdirSync(alpha)
  fs.mkdirSync(beta)
  return { root, alpha, beta }
}

test('canonicalPath normalizes a trailing separator and a missing directory', () => {
  const { alpha } = twoFolders()
  assert.equal(canonicalPath(`${alpha}${path.sep}`), canonicalPath(alpha))
  assert.equal(canonicalPath(alpha), fs.realpathSync.native(alpha))
  // A vanished directory falls back to the literal path, so its Sessions are
  // still classifiable instead of disappearing from every list.
  assert.equal(canonicalPath(`${alpha}-gone`), `${alpha}-gone`)
  assert.equal(canonicalPath(''), null)
  assert.equal(canonicalPath(null), null)
})

test('sessionView reads the title and blank flag out of the projections', () => {
  const view = sessionView(summary('session-1', { cwd: '/tmp', title: '  Фикс авторизации  ', blank: true }), {})
  assert.equal(view.title, 'Фикс авторизации', 'the title is trimmed')
  assert.equal(view.blank, true)
  assert.equal(sessionView(summary('session-2', { cwd: '/tmp' }), {}).title, null)
})

test('rule 1: subagents and their descendants never reach a list', () => {
  const sessions = collectSessions([
    summary('root', { cwd: '/tmp' }),
    summary('sub', { cwd: '/tmp', origin: 'subagent', parentSessionId: 'root' }),
    // A nested subagent can lack the origin mark; the parent link still catches it.
    summary('sub-sub', { cwd: '/tmp', parentSessionId: 'sub' }),
    // A child whose parent is not in the list cannot be proven to be a root.
    summary('orphan', { cwd: '/tmp', parentSessionId: 'missing-parent' }),
  ])
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ['root'])
})

test('rule 2: a blank session is skipped', () => {
  const sessions = collectSessions([
    summary('filled', { cwd: '/tmp' }),
    summary('empty', { cwd: '/tmp', blank: true }),
  ])
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ['filled'])
})

test('rule 3: archived sessions are skipped, by the registry set', () => {
  const sessions = collectSessions(
    [summary('visible', { cwd: '/tmp' }), summary('hidden', { cwd: '/tmp' })],
    { archivedSessionIds: ['hidden'] },
  )
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ['visible'])
})

test('a session without a directory cannot be classified and is skipped', () => {
  const sessions = collectSessions([summary('no-cwd'), summary('with-cwd', { cwd: '/tmp' })])
  assert.deepEqual(sessions.map((entry) => entry.sessionId), ['with-cwd'])
})

test('rule 4: only folders that hold a session are listed', () => {
  const { alpha, beta } = twoFolders()
  const sessions = collectSessions([summary('a1', { cwd: alpha })])
  const grouped = groupByWorkspace(sessions, [workspace('w-alpha', alpha, 'alpha'), workspace('w-empty', beta, 'beta')])
  assert.deepEqual(grouped.workspaces.map((entry) => entry.id), ['w-alpha'])
})

test('sessions are matched to folders through the canonical path', () => {
  const { alpha } = twoFolders()
  // A trailing separator and a differently-cased spelling must still land in
  // the same folder, because that is what the two registries hand over.
  const sessions = collectSessions([
    summary('a1', { cwd: `${alpha}${path.sep}` }),
    summary('a2', { cwd: alpha.toUpperCase() }),
  ])
  const grouped = groupByWorkspace(sessions, [workspace('w-alpha', alpha, 'alpha')])
  assert.equal(grouped.orphans.length, process.platform === 'win32' ? 0 : 1, 'case folding only applies on Windows')
  assert.equal(grouped.workspaces[0].sessionCount, grouped.orphans.length === 0 ? 2 : 1)
})

test('a session outside every registered folder is reported as an orphan', () => {
  const { alpha } = twoFolders()
  const sessions = collectSessions([summary('elsewhere', { cwd: tempDir() })])
  const grouped = groupByWorkspace(sessions, [workspace('w-alpha', alpha, 'alpha')])
  assert.deepEqual(grouped.workspaces, [])
  assert.deepEqual(grouped.orphans.map((entry) => entry.sessionId), ['elsewhere'])
})

test('folder counts and last activity come from the surviving sessions', () => {
  const { alpha } = twoFolders()
  const sessions = collectSessions([
    summary('a1', { cwd: alpha, updatedAt: 1000 }),
    summary('a2', { cwd: alpha, updatedAt: 5000 }),
    summary('a3', { cwd: alpha, updatedAt: 3000, blank: true }),
  ])
  const [folder] = groupByWorkspace(sessions, [workspace('w-alpha', alpha, 'alpha')]).workspaces
  assert.equal(folder.sessionCount, 2, 'the blank session is not counted')
  assert.equal(folder.lastActivityAt, 5000)
  assert.deepEqual(folder.sessions.map((entry) => entry.sessionId), ['a2', 'a1'], 'freshest first')
})

test('§4: registry order is kept, and activity order is opt-in', () => {
  const { alpha, beta } = twoFolders()
  const workspaces = [workspace('w-alpha', alpha, 'alpha'), workspace('w-beta', beta, 'beta')]
  const sessions = collectSessions([
    summary('a1', { cwd: alpha, updatedAt: 1000 }),
    summary('b1', { cwd: beta, updatedAt: 9000 }),
  ])
  assert.deepEqual(groupByWorkspace(sessions, workspaces, { sort: 'registry' }).workspaces.map((entry) => entry.id), ['w-alpha', 'w-beta'])
  assert.deepEqual(groupByWorkspace(sessions, workspaces, { sort: 'activity' }).workspaces.map((entry) => entry.id), ['w-beta', 'w-alpha'])
})

test('§3.5: folderPage cuts to N and reports the full count', () => {
  const { alpha } = twoFolders()
  const sessions = collectSessions(
    ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((id, index) => summary(id, { cwd: alpha, updatedAt: 1000 + index })),
  )
  const [folder] = groupByWorkspace(sessions, [workspace('w-alpha', alpha, 'alpha')]).workspaces
  const page = folderPage(folder, 5)
  assert.equal(page.total, 7)
  assert.equal(page.limit, 5)
  assert.deepEqual(page.sessions.map((entry) => entry.sessionId), ['a7', 'a6', 'a5', 'a4', 'a3'])
  assert.equal(folderPage(folder, 10).sessions.length, 7, 'a limit above the count shows everything')
})

test('buildView resolves the bound session and the folder that holds it', () => {
  const { alpha, beta } = twoFolders()
  const workspaces = [workspace('w-alpha', alpha, 'alpha'), workspace('w-beta', beta, 'beta')]
  const sessions = [
    summary('a1', { cwd: alpha, title: 'Фикс авторизации' }),
    summary('b1', { cwd: beta, running: true }),
  ]
  const view = buildView(sessions, workspaces, {
    binding: { sessionId: 'a1', workspaceId: 'w-alpha' },
    createdByBot: (id) => id === 'b1',
  })
  assert.equal(view.bound.title, 'Фикс авторизации')
  assert.equal(view.bound.createdByBot, false)
  assert.equal(view.folderFor('a1').id, 'w-alpha')
  assert.equal(view.folderFor('b1').id, 'w-beta')
  assert.equal(view.runningCount, 1)
  assert.equal(view.workspaceSessionCount, 2)
})

test('buildView reports an unbound chat and a binding to a vanished session', () => {
  const { alpha } = twoFolders()
  const workspaces = [workspace('w-alpha', alpha, 'alpha')]
  const sessions = [summary('a1', { cwd: alpha })]
  const unbound = buildView(sessions, workspaces, { binding: null })
  assert.equal(unbound.binding, null)
  assert.equal(unbound.bound, null)
  // §12: the Session is gone (archived, for instance), so the binding resolves
  // to nothing and the caller is expected to drop it.
  const stale = buildView(sessions, workspaces, { binding: { sessionId: 'a1', workspaceId: 'w-alpha' }, archivedSessionIds: ['a1'] })
  assert.equal(stale.binding.sessionId, 'a1')
  assert.equal(stale.bound, null, 'the folder falls back to the stored workspace id')
  assert.equal(stale.folderFor('a1').id, 'w-alpha')
})

test('the 📱 mark follows the createdByBot predicate', () => {
  const { alpha } = twoFolders()
  const sessions = collectSessions([summary('a1', { cwd: alpha }), summary('a2', { cwd: alpha })], { createdByBot: (id) => id === 'a1' })
  assert.deepEqual(sessions.map((entry) => [entry.sessionId, entry.createdByBot]), [['a1', true], ['a2', false]])
})

test('a corrupt parent cycle does not hang the classification', () => {
  const sessions = collectSessions([
    summary('x', { cwd: '/tmp', parentSessionId: 'y' }),
    summary('y', { cwd: '/tmp', parentSessionId: 'x' }),
  ])
  assert.deepEqual(sessions, [])
})
