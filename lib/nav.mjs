/**
 * Turning the Harness registry into the view model the screens render.
 *
 * This is where §3 (what reaches the lists) and §4 (in what order) live. It is
 * deliberately pure and dependency-injected: the caller hands in the raw
 * `SessionSummary[]` and `Workspace[]`, and this module decides what survives
 * the filters, which folder each Session belongs to, and how the folders are
 * ordered. That makes the whole classification testable without a running
 * Harness, which matters because the filters are the part most likely to be
 * wrong in a way nobody notices until an archived session shows up on a phone.
 */
import fs from 'node:fs'

/** A session's effective directory, as the registry reports it. */
function cwdOf(summary) {
  return typeof summary?.cwd === 'string' && summary.cwd.length > 0 ? summary.cwd : null
}

/**
 * Canonical spelling of a directory, so a Workspace and a Session that name the
 * same folder compare equal.
 *
 * Workspace paths are `fs.realpath` at creation time; Session `cwd` values are
 * whatever the Session header recorded. On a case-insensitive volume those can
 * differ only by case, and on a volume with symlinks they can differ only by an
 * intermediate link — both are the same folder to the user.
 *
 * @param value - a path, or `null`.
 * @returns the canonical path, with trailing separators removed.
 */
export function canonicalPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  let resolved = value
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value)
  } catch {
    // The directory may be gone (a deleted Workspace still holds Sessions).
    // Falling back to the literal path keeps those Sessions classifiable
    // instead of silently dropping them out of every list.
    resolved = value
  }
  return resolved.replace(/[\\/]+$/u, '')
}

/** The comparison key for a folder: canonical, case-folded for Windows volumes. */
function pathKey(value) {
  const canonical = canonicalPath(value)
  if (canonical === null) return null
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/**
 * Reduce one `SessionSummary` to the fields the screens use.
 * @param summary - raw summary from `sessionController.list`.
 * @param options.createdByBot - predicate for the 📱 mark.
 */
export function sessionView(summary, { createdByBot } = {}) {
  const id = String(summary?.sessionId ?? '')
  const projections = summary?.projections?.values
  const listMetadata = projections?.sessionListMetadata
  const title = typeof projections?.title === 'string' ? projections.title.trim() : null
  return {
    sessionId: id,
    title: title && title.length > 0 ? title : null,
    running: summary?.running === true,
    // §1: a cold Session is only listed when it has a directory at all. The
    // controller already enforces that, and this keeps the invariant visible.
    cwd: cwdOf(summary),
    updatedAt: Number.isFinite(Number(summary?.updatedAt)) ? Number(summary.updatedAt) : 0,
    parentSessionId: summary?.parentSessionId ? String(summary.parentSessionId) : null,
    origin: summary?.origin ?? null,
    // `blank` rides inside the persisted list metadata projection, and it is the
    // authoritative "this Session never held a turn" fact.
    blank: listMetadata?.blank === true || summary?.blank === true,
    createdByBot: createdByBot ? createdByBot(id) : false,
  }
}

/**
 * Find every subagent descendant of a listed Session.
 *
 * The `origin === 'subagent'` mark alone is not enough to filter the list: a
 * nested subagent's own children can lack the mark while still being service
 * Sessions. Walking the parent links catches the whole lineage.
 *
 * Depth is walked with a visited set, so a corrupt parent cycle cannot hang the
 * plugin, and a child whose parent is not in the list is still dropped — its
 * parent is gone, so it cannot be proven to be a root conversation.
 */
function descendantIds(sessions) {
  const children = new Map()
  const known = new Set(sessions.map((session) => session.sessionId))
  for (const session of sessions) {
    if (!session.parentSessionId) continue
    const list = children.get(session.parentSessionId) ?? []
    list.push(session.sessionId)
    children.set(session.parentSessionId, list)
  }
  const descendants = new Set()
  const seeds = sessions.filter((session) => session.origin === 'subagent' || (session.parentSessionId && known.has(session.parentSessionId)))
  const queue = seeds.map((session) => session.sessionId)
  while (queue.length > 0) {
    const id = queue.shift()
    if (descendants.has(id)) continue
    descendants.add(id)
    for (const child of children.get(id) ?? []) queue.push(child)
  }
  return descendants
}

/**
 * Apply the §3 filters: root sessions only, no blank ones, no archived ones,
 * and (for the lists) only those inside a registered Workspace.
 *
 * Archive membership comes from the Workspace registry, because the Session
 * list does not report it.
 *
 * @param summaries - raw `SessionSummary[]`.
 * @param options.archivedSessionIds - the registry's archive set.
 * @param options.createdByBot - predicate for the 📱 mark.
 * @returns the surviving session views.
 */
export function collectSessions(summaries, { archivedSessionIds = [], createdByBot } = {}) {
  const all = (Array.isArray(summaries) ? summaries : []).map((summary) => sessionView(summary, { createdByBot }))
  const archived = new Set((archivedSessionIds ?? []).map((id) => String(id)))
  const descendants = descendantIds(all)
  return all.filter((session) => {
    if (session.sessionId.length === 0) return false
    if (session.origin === 'subagent' || session.parentSessionId) return false
    if (descendants.has(session.sessionId)) return false
    if (session.blank) return false
    if (archived.has(session.sessionId)) return false
    return session.cwd !== null
  })
}

/**
 * Group the surviving sessions by Workspace and order the folders.
 *
 * @param sessions - output of {@link collectSessions}.
 * @param workspaces - raw `Workspace[]` in registry order (the sidebar order).
 * @param options.sort - `registry` (registry order) or `activity` (freshest first).
 * @returns `{ workspaces, orphans }`, where `workspaces` holds only folders with
 *   at least one session, each carrying its count and last activity.
 */
export function groupByWorkspace(sessions, workspaces, { sort = 'registry' } = {}) {
  const byKey = new Map()
  const ordered = []
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    const key = pathKey(workspace?.path)
    if (key === null || byKey.has(key)) continue
    const entry = { ...workspace, id: String(workspace.id ?? ''), path: workspace.path, lastActivityAt: 0, sessionCount: 0, sessions: [] }
    byKey.set(key, entry)
    ordered.push(entry)
  }

  const orphans = []
  for (const session of sessions) {
    const key = pathKey(session.cwd)
    const workspace = key === null ? undefined : byKey.get(key)
    if (!workspace) {
      orphans.push(session)
      continue
    }
    workspace.sessions.push(session)
    workspace.sessionCount += 1
    if (session.updatedAt > workspace.lastActivityAt) workspace.lastActivityAt = session.updatedAt
  }

  for (const workspace of ordered) workspace.sessions.sort((left, right) => right.updatedAt - left.updatedAt)

  const populated = ordered.filter((workspace) => workspace.sessionCount > 0)
  const ranked = sort === 'activity'
    ? [...populated].sort((left, right) => right.lastActivityAt - left.lastActivityAt || ordered.indexOf(left) - ordered.indexOf(right))
    : populated

  return { workspaces: ranked, orphans }
}

/**
 * The last N sessions of one folder (§3.5).
 * @param workspace - an entry from {@link groupByWorkspace}.
 * @param limit - the effective per-chat limit.
 */
export function folderPage(workspace, limit) {
  const sessions = Array.isArray(workspace?.sessions) ? workspace.sessions : []
  const size = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : sessions.length
  return { sessions: sessions.slice(0, size), total: sessions.length, limit: size }
}

/**
 * The whole view model one screen render needs, built from the two registry
 * reads. Kept in one place so L1 and L2 can never disagree about what a folder
 * holds or about which session is on the binding.
 *
 * @param summaries - raw `SessionSummary[]`.
 * @param workspaces - raw `Workspace[]`.
 * @param options.archivedSessionIds - the registry's archive set.
 * @param options.sort - `registry` or `activity`.
 * @param options.limit - per-folder session limit.
 * @param options.createdByBot - predicate for the 📱 mark.
 * @param options.binding - `{ sessionId, workspaceId }` or `null`.
 */
export function buildView(summaries, workspaces, options = {}) {
  const sessions = collectSessions(summaries, options)
  const grouped = groupByWorkspace(sessions, workspaces, { sort: options.sort })
  const binding = options.binding ?? null
  const bound = binding ? (sessions.find((session) => session.sessionId === binding.sessionId) ?? null) : null

  // Every registered folder, keyed by id, including the ones that hold no
  // surviving session. A binding still has to name its folder even after the
  // Session was archived — which is exactly when the user needs the way back.
  const byId = new Map()
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.id !== undefined && workspace?.id !== null) byId.set(String(workspace.id), workspace)
  }

  /** Locate the folder a Session lives in, preferring the binding's stored id. */
  const folderFor = (sessionId) => {
    if (!sessionId) return null
    const direct = grouped.workspaces.find((workspace) => workspace.sessions.some((session) => session.sessionId === sessionId))
    if (direct) return direct
    if (binding?.workspaceId !== undefined && binding?.workspaceId !== null) {
      const stored = byId.get(String(binding.workspaceId))
      if (stored) return stored
    }
    return null
  }

  return {
    sessions,
    workspaces: grouped.workspaces,
    orphans: grouped.orphans,
    runningCount: sessions.filter((session) => session.running).length,
    workspaceSessionCount: sessions.length,
    binding,
    bound,
    folderFor,
  }
}
