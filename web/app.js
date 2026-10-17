/**
 * Mini App client.
 *
 * Three screens: token entry, chat list, one chat with a live log. The only
 * secret it handles is the control token, which stays inside this page — it is
 * sent once to the bridge and never stored; the page keeps the short-lived
 * session token in memory only, so closing the Mini App forgets it.
 */
const tg = window.Telegram?.WebApp

/** Base path of the bridge, derived from this page's own location. */
const BASE = (() => {
  const path = window.location.pathname
  return path.endsWith('/') ? path.slice(0, -1) : path
})()

const el = (id) => document.getElementById(id)
const screenAuth = el('screen-auth')
const screenList = el('screen-list')
const screenChat = el('screen-chat')
const barTitle = el('bar-title')
const backButton = el('back')

/** Session token issued by the bridge after a successful pairing. */
let sessionToken = null
/** Telegram identity reported by the bridge. */
let me = null
/** Currently open chat. */
let openSession = null
/** Poll generation, so a stale loop stops after the user navigates away. */
let generation = 0

/** Apply Telegram's theme variables and viewport niceties. */
function initTelegram() {
  if (!tg) return
  tg.ready()
  tg.expand()
  try {
    tg.setHeaderColor?.('secondary_bg_color')
    tg.setBackgroundColor?.('bg_color')
  } catch {
    /* older clients */
  }
  tg.BackButton?.onClick(() => showList())
  tg.onEvent?.('themeChanged', () => applyTheme())
  applyTheme()
}

/** Mirror Telegram's palette into the CSS variables this page uses. */
function applyTheme() {
  const params = tg?.themeParams
  if (!params) return
  const map = {
    '--bg': params.bg_color,
    '--bg-2': params.secondary_bg_color,
    '--fg': params.text_color,
    '--muted': params.hint_color,
    '--accent': params.button_color,
    '--accent-fg': params.button_text_color,
  }
  for (const [name, value] of Object.entries(map)) {
    if (typeof value === 'string' && value.length > 0) document.documentElement.style.setProperty(name, value)
  }
}

/** Minimal fetch wrapper that always returns the parsed JSON body. */
async function api(path, body, { auth = true } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (auth && sessionToken) headers['x-tg-token'] = sessionToken
  const response = await fetch(`${BASE}/api/${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error ?? `HTTP ${response.status}`)
  }
  return payload
}

/** Show one screen and keep the header in sync. */
function show(screen, title, { allowBack = false } = {}) {
  for (const node of [screenAuth, screenList, screenChat]) node.hidden = node !== screen
  barTitle.textContent = title
  if (tg?.BackButton) allowBack ? tg.BackButton.show() : tg.BackButton.hide()
  backButton.hidden = !allowBack
}

/** Report an error in the screen that produced it. */
function fail(node, message) {
  node.textContent = message
  node.hidden = false
}

/** Clear one error node. */
function clearError(node) {
  node.textContent = ''
  node.hidden = true
}

/** Timestamp formatting for the chat list. */
function when(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Date.now() - ms
  if (diff < 60_000) return 'только что'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} мин назад`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} ч назад`
  return new Date(ms).toLocaleDateString('ru-RU')
}

// ── Экран входа ─────────────────────────────────────────────────────────────
async function submitToken() {
  const button = el('auth-submit')
  const error = el('auth-error')
  clearError(error)
  const controlToken = el('control-token').value.trim()
  if (controlToken.length === 0) {
    fail(error, 'Введи контрольный токен')
    return
  }
  if (!tg?.initData) {
    fail(error, 'Панель открыта вне Telegram — подпись initData недоступна')
    return
  }
  button.disabled = true
  try {
    const payload = await api('auth', { initData: tg.initData, controlToken }, { auth: false })
    sessionToken = payload.token
    me = payload.me
    el('control-token').value = ''
    await showList()
  } catch (cause) {
    fail(error, String(cause.message ?? cause))
  } finally {
    button.disabled = false
  }
}

// ── Список чатов ────────────────────────────────────────────────────────────
async function showList() {
  generation += 1
  openSession = null
  show(screenList, 'Чаты')
  await refreshList()
}

async function refreshList() {
  const error = el('list-error')
  clearError(error)
  const list = el('chat-list')
  try {
    const payload = await api('list')
    if (me) el('list-meta').textContent = `tg id ${me.userId}${me.username ? ` · @${me.username}` : ''} · чатов: ${payload.items.length}`
    list.replaceChildren()
    for (const item of payload.items) {
      const li = document.createElement('li')
      const name = document.createElement('div')
      name.className = 'name'
      name.textContent = item.title ?? item.short
      const meta = document.createElement('div')
      meta.className = 'meta'
      const badges = []
      if (item.running) badges.push('<span class="badge run">выполняется</span>')
      else if (item.live) badges.push('<span class="badge">активна</span>')
      if (item.cwd) badges.push(item.cwd)
      if (item.updatedAt) badges.push(when(item.updatedAt))
      meta.innerHTML = badges.join(' · ')
      li.append(name, meta)
      li.addEventListener('click', () => openChat(item))
      list.append(li)
    }
    if (payload.items.length === 0) {
      const li = document.createElement('li')
      li.textContent = 'Пока нет ни одной сессии — создай новую кнопкой «＋ новый».'
      list.append(li)
    }
  } catch (cause) {
    fail(error, String(cause.message ?? cause))
  }
}

// ── Диалог ──────────────────────────────────────────────────────────────────
async function openChat(item) {
  openSession = item
  const myGeneration = ++generation
  show(screenChat, item.title ?? item.short, { allowBack: true })
  el('log').replaceChildren()
  clearError(el('chat-error'))
  el('chat-meta').textContent = [item.sessionId, item.running ? 'выполняется' : 'ожидает'].join(' · ')
  try {
    const payload = await api('session', { sessionId: item.sessionId, maxMessages: 60 })
    renderPage(payload.page)
  } catch (cause) {
    fail(el('chat-error'), String(cause.message ?? cause))
  }
  void pump(item.sessionId, myGeneration)
}

/** Render one history page returned by the bridge. */
function renderPage(page) {
  const records = page?.records ?? page?.items ?? []
  const log = el('log')
  log.replaceChildren()
  for (const record of records) renderRecord(record)
  log.scrollTop = log.scrollHeight
}

/** Append one durable event. */
function renderRecord(record) {
  const type = record?.event?.type ?? record?.type
  const data = record?.event?.data ?? record?.data ?? {}
  const message = data.message ?? {}
  const text = contentText(message.content) ?? (typeof data.text === 'string' ? data.text : null)
  if (type === 'tool/call') return pushBubble('tool', `🔧 ${data.name ?? 'tool'}`)
  if (message.role === 'user' && text) return pushBubble('user', text)
  if (message.role === 'assistant' && text) return pushBubble('assistant', text)
  return null
}

/** Flatten a message content array. */
function contentText(content) {
  if (!Array.isArray(content)) return null
  const parts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
  const joined = parts.join('\n').trim()
  return joined.length > 0 ? joined : null
}

/** Append a bubble and keep the view pinned to the bottom. */
function pushBubble(kind, text, { replaceLast = false } = {}) {
  const log = el('log')
  if (replaceLast) {
    const last = log.lastElementChild
    if (last && last.dataset.streaming === '1') {
      last.textContent = text
      log.scrollTop = log.scrollHeight
      return last
    }
  }
  const node = document.createElement('div')
  node.className = `msg ${kind}`
  node.textContent = text
  if (kind === 'assistant') node.dataset.streaming = '1'
  log.append(node)
  log.scrollTop = log.scrollHeight
  return node
}

/** Long-poll the session stream until the user leaves this chat. */
async function pump(sessionId, myGeneration) {
  let since = 0
  let streamed = ''
  while (generation === myGeneration) {
    let payload
    try {
      payload = await api('stream', { sessionId, since, timeoutMs: 20_000 })
    } catch (cause) {
      if (generation !== myGeneration) return
      fail(el('chat-error'), String(cause.message ?? cause))
      await new Promise((resolve) => setTimeout(resolve, 3000))
      continue
    }
    if (generation !== myGeneration) return
    clearError(el('chat-error'))
    since = payload.next ?? since
    for (const frame of payload.frames ?? []) {
      if (frame.kind === 'snapshot') {
        for (const record of frame.records ?? []) renderRecord(record)
      } else if (frame.kind === 'event') {
        streamed = ''
        renderRecord(frame)
      } else if (frame.kind === 'chunk') {
        if (typeof frame.text === 'string' && frame.text.length > 0) {
          streamed += frame.text
          pushBubble('assistant', streamed, { replaceLast: true })
        }
      }
    }
    if (payload.closed) {
      since = 0
      try {
        const fresh = await api('session', { sessionId, maxMessages: 40 })
        renderPage(fresh.page)
      } catch {
        /* keep the current view */
      }
    }
  }
}

/** Send the composer text. */
async function sendPrompt(event) {
  event?.preventDefault?.()
  const input = el('prompt')
  const text = input.value.trim()
  if (text.length === 0 || !openSession) return
  input.value = ''
  input.style.height = 'auto'
  pushBubble('user', text)
  try {
    await api('prompt', { sessionId: openSession.sessionId, text })
  } catch (cause) {
    fail(el('chat-error'), String(cause.message ?? cause))
  }
}

/** Cancel the running turn. */
async function stopTurn() {
  if (!openSession) return
  try {
    await api('cancel', { sessionId: openSession.sessionId })
  } catch (cause) {
    fail(el('chat-error'), String(cause.message ?? cause))
  }
}

/** Create a fresh session and open it. */
async function createChat() {
  const error = el('list-error')
  clearError(error)
  try {
    const payload = await api('create', {})
    const sessionId = payload.value?.sessionId ?? payload.value?.id
    await refreshList()
    if (sessionId) await openChat({ sessionId: String(sessionId), title: 'Новая сессия', running: false })
  } catch (cause) {
    fail(error, String(cause.message ?? cause))
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────
backButton.addEventListener('click', () => showList())
el('refresh').addEventListener('click', () => (openSession ? openChat(openSession) : refreshList()))
el('auth-submit').addEventListener('click', submitToken)
el('control-token').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void submitToken()
})
el('new-chat').addEventListener('click', createChat)
el('composer').addEventListener('submit', sendPrompt)
el('prompt').addEventListener('input', (event) => {
  const node = event.target
  node.style.height = 'auto'
  node.style.height = `${Math.min(node.scrollHeight, window.innerHeight * 0.3)}px`
})
el('stop').addEventListener('click', stopTurn)

initTelegram()
if (tg?.initData) show(screenAuth, 'Вход')
else {
  show(screenAuth, 'Вход')
  fail(el('auth-error'), 'Открой эту страницу кнопкой в чате с ботом — вне Telegram вход невозможен.')
}
