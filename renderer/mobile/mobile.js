/* ESCO Works スマホ版 — SSE + fetch でメインプロセスのRemoteServerと通信する */
const $ = (id) => document.getElementById(id)

const TOKEN_KEY = 'escoRemoteToken'
let token = null
let busy = false
let lastSeq = 0
let es = null // EventSource
let currentAiEl = null
let currentAiRaw = ''

function nearBottom() {
  const m = $('messages')
  return m.scrollHeight - m.scrollTop - m.clientHeight < 60
}
function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight
}
function addMsg(cls, text) {
  const el = document.createElement('div')
  el.className = `msg ${cls}`
  el.textContent = text
  $('messages').appendChild(el)
  scrollToBottom()
  return el
}

/* --- 「考え中」インジケーター（デスクトップ版と同じ動き） --- */
let pending = null
function showPending(label) {
  if (pending) {
    pending.label = label
    renderPending()
    return
  }
  const el = addMsg('ai pending', label)
  pending = { el, label, t0: Date.now(), timer: setInterval(renderPending, 500) }
  renderPending()
}
function renderPending() {
  if (!pending) return
  const atBottom = nearBottom()
  const s = Math.floor((Date.now() - pending.t0) / 1000)
  const dots = '.'.repeat((Math.floor(Date.now() / 500) % 3) + 1)
  pending.el.textContent = `${pending.label}${dots}${s >= 3 ? ` (${s}s)` : ''}`
  if (atBottom) scrollToBottom()
}
function clearPending() {
  if (!pending) return
  clearInterval(pending.timer)
  pending.el.remove()
  pending = null
}

function setBusy(b) {
  busy = b
  $('sendBtn').disabled = b
  $('stopBtn').hidden = !b
}

/* --- API --- */
async function api(pathname, body) {
  const res = await fetch(pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  })
  if (res.status === 401) {
    showPairScreen('接続の有効期限が切れました。パソコンのESCO Worksで ⚙設定 →「スマホ連携」のQRコードを、もう一度読み取ってください。')
    throw new Error('unauthorized')
  }
  return res
}

function showPairScreen(msg) {
  if (msg) $('pairMsg').textContent = msg
  $('pairScreen').hidden = false
  if (es) {
    es.close()
    es = null
  }
}

/* --- SSE接続（EventSourceは自動再接続+Last-Event-ID再送が組み込み） --- */
function connectSse() {
  if (es) es.close()
  es = new EventSource(`/api/events?token=${encodeURIComponent(token)}&last=${lastSeq}`)
  es.onopen = () => {
    $('connBar').hidden = true
  }
  es.onerror = () => {
    $('connBar').hidden = false
    // 完全に閉じられた場合（サーバー再起動等）は自前で張り直す
    if (es && es.readyState === EventSource.CLOSED) {
      es = null
      setTimeout(async () => {
        try {
          const r = await api('/api/state')
          if (r.ok) connectSse()
        } catch {
          /* 401はshowPairScreen済み */
        }
      }, 3000)
    }
  }
  es.onmessage = (e) => {
    let data
    try {
      data = JSON.parse(e.data)
    } catch {
      return
    }
    if (e.lastEventId) lastSeq = parseInt(e.lastEventId, 10) || lastSeq
    handleEvent(data.ev, data.payload || {})
  }
}

function handleEvent(ev, p) {
  switch (ev) {
    case 'agent:token': {
      clearPending()
      const atBottom = nearBottom()
      if (!currentAiEl) {
        currentAiEl = addMsg('ai', '')
        currentAiRaw = ''
      }
      currentAiRaw += p.delta
      currentAiEl.innerHTML = md(currentAiRaw)
      if (atBottom) scrollToBottom()
      break
    }
    case 'agent:text':
      clearPending()
      currentAiEl = addMsg('ai', '')
      currentAiRaw = p.text
      currentAiEl.innerHTML = md(p.text)
      break
    case 'agent:tool':
      currentAiEl = null
      currentAiRaw = ''
      showPending(p.tool)
      break
    case 'agent:done':
      clearPending()
      clearAsks()
      setBusy(false)
      break
    case 'agent:error':
      clearPending()
      clearAsks()
      addMsg('error', `エラー: ${p.message}`)
      setBusy(false)
      break
    case 'agent:ask':
      addPermCard(p)
      break
    case 'agent:choice':
      addChoiceCard(p)
      break
    case 'relay:route':
      // サーバー経由モードのみ届く。応答元が切り替わったときだけ知らせる
      if (p.via !== lastRoute) {
        lastRoute = p.via
        addMsg(
          'sys',
          p.via === 'cloud'
            ? '☁ パソコンが起動していないため、サーバーが代わりに応答します（ファイル操作はできません）'
            : '💻 パソコンに接続しました。ファイル作業も頼めます'
        )
      }
      break
    default:
      break
  }
}
let lastRoute = 'pc' // 初回のPC応答では通知を出さない（クラウド代打時のみ知らせる）

/* --- 許可カード（デスクトップ版から移植。応答は fetch POST） --- */
const openCards = new Set()

function labelFor(req) {
  const t = req.tool || ''
  if (t.startsWith('mcp__playwright')) return 'ブラウザ操作'
  return req.label || t
}
function addPermCard(req) {
  const card = document.createElement('div')
  card.className = 'permcard'
  const head = document.createElement('div')
  head.className = 'pc-head'
  head.innerHTML = `<b>${escapeHtml(labelFor(req))}</b> を実行してよいですか？<br><span style="font-size:12px;color:#8a7a30">※パソコン上で実行されます</span>`
  card.appendChild(head)
  if (req.detail) {
    const pre = document.createElement('pre')
    pre.textContent = req.detail
    card.appendChild(pre)
  }
  const btns = document.createElement('div')
  btns.className = 'pc-btns'
  const allow = document.createElement('button')
  allow.className = 'pc-allow'
  allow.textContent = '許可'
  const always = document.createElement('button')
  always.textContent = '常に許可'
  const deny = document.createElement('button')
  deny.textContent = '拒否'
  btns.append(allow, always, deny)
  card.appendChild(btns)
  $('messages').appendChild(card)
  scrollToBottom()

  const finish = (approved, remember, resultText) => {
    if (!openCards.has(card)) return
    openCards.delete(card)
    api('/api/perm', { requestId: req.requestId, approved, remember }).catch(() => {})
    btns.remove()
    const r = document.createElement('div')
    r.className = 'pc-result'
    r.textContent = resultText
    card.appendChild(r)
    card.classList.add('answered')
  }
  allow.addEventListener('click', () => finish(true, false, '許可しました'))
  always.addEventListener('click', () => finish(true, true, '常に許可にしました'))
  deny.addEventListener('click', () => finish(false, false, '拒否しました'))
  card.__cancel = () => finish(false, false, 'キャンセルされました')
  openCards.add(card)
  currentAiEl = null
  currentAiRaw = ''
}
function clearAsks() {
  for (const card of Array.from(openCards)) {
    if (card.__cancel) card.__cancel()
  }
}

/* --- 選択肢カード --- */
function addChoiceCard(req) {
  const card = document.createElement('div')
  card.className = 'permcard choicecard'
  const head = document.createElement('div')
  head.className = 'pc-head'
  head.innerHTML = `<b>${escapeHtml(req.question || '選んでください')}</b>`
  card.appendChild(head)
  const btns = document.createElement('div')
  btns.className = 'pc-btns'
  const finish = (answer) => {
    if (!openCards.has(card)) return
    openCards.delete(card)
    api('/api/choice', { requestId: req.requestId, answer }).catch(() => {})
    btns.remove()
    const r = document.createElement('div')
    r.className = 'pc-result'
    r.textContent = `→ ${answer}`
    card.appendChild(r)
    card.classList.add('answered')
  }
  for (const opt of req.options || []) {
    const b = document.createElement('button')
    b.textContent = opt
    b.addEventListener('click', () => finish(opt))
    btns.appendChild(b)
  }
  card.appendChild(btns)
  $('messages').appendChild(card)
  scrollToBottom()
  card.__cancel = () => finish('（キャンセルされました）')
  openCards.add(card)
  currentAiEl = null
  currentAiRaw = ''
}

/* --- 送信（Enterは改行。送信はボタンのみ＝スマホの標準挙動） --- */
async function send() {
  const text = $('input').value.trim()
  if (!text || busy) return
  $('input').value = ''
  autoGrow()
  addMsg('user', text)
  currentAiEl = null
  currentAiRaw = ''
  setBusy(true)
  showPending('Thinking')
  try {
    const r = await api('/api/chat', { text })
    if (r.status === 409) {
      clearPending()
      addMsg('error', '前の処理が終わっていません。少し待ってからもう一度送ってください。')
      setBusy(false)
    } else if (!r.ok) {
      clearPending()
      addMsg('error', '送信に失敗しました。電波の良いところでもう一度お試しください。')
      setBusy(false)
    }
    // 成功時は agent:done / agent:error がSSEで届いて busy が解除される
  } catch {
    clearPending()
    setBusy(false)
  }
}
$('sendBtn').addEventListener('click', send)
$('stopBtn').addEventListener('click', () => api('/api/interrupt', {}).catch(() => {}))
$('newChatBtn').addEventListener('click', async () => {
  try {
    await api('/api/new', {})
  } catch {
    return
  }
  clearPending()
  clearAsks()
  currentAiEl = null
  setBusy(false)
  $('messages').innerHTML = ''
  addMsg('ai', '新しい会話を始めました。')
})

/* 入力欄の高さを内容に合わせる */
function autoGrow() {
  const t = $('input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 120) + 'px'
}
$('input').addEventListener('input', autoGrow)

// AI応答内リンクは新しいタブで開く（チャット画面が消えないように）
$('messages').addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a')
  if (a) {
    e.preventDefault()
    window.open(a.href, '_blank', 'noopener')
  }
})

// バックグラウンド復帰時に接続を確かめる（iOSはバックグラウンドでSSEが切られる）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token && $('pairScreen').hidden) {
    if (!es || es.readyState === EventSource.CLOSED) connectSse()
  }
})

/* --- 起動: URLフラグメントのワンタイムコード → ペアリング → SSE接続 --- */
async function boot() {
  // QR経由: #p=<code> が付いていたらペアリングする
  const m = location.hash.match(/^#p=([0-9a-f]{32})$/)
  if (m) {
    history.replaceState(null, '', location.pathname) // コードをURLから消す
    try {
      const res = await fetch('/api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: m[1] })
      })
      if (res.ok) {
        const d = await res.json()
        token = d.deviceToken
        try {
          localStorage.setItem(TOKEN_KEY, token)
        } catch {
          /* プライベートモード等では保存できないが今回分は動く */
        }
      } else {
        showPairScreen('QRコードの有効期限が切れています。パソコン側でQRコードを表示し直して、もう一度読み取ってください。')
        return
      }
    } catch {
      showPairScreen('接続できませんでした。パソコンのESCO Worksが起動しているか確認してください。')
      return
    }
  } else {
    try {
      token = localStorage.getItem(TOKEN_KEY)
    } catch {
      token = null
    }
  }
  if (!token) {
    showPairScreen()
    return
  }
  // トークン検証と状態復元
  let state
  try {
    const r = await api('/api/state')
    if (!r.ok) return
    state = await r.json()
  } catch {
    return // 401はshowPairScreen済み
  }
  $('pairScreen').hidden = true
  lastSeq = state.seq || 0
  if (state.busy) {
    setBusy(true)
    showPending('Thinking')
  }
  connectSse()
  const hello = state.userName ? `${state.userName}さん、こんにちは。` : 'こんにちは。'
  addMsg('ai', `${hello}ESCO Worksスマホ版です。\n相談・質問・文章の下書きができます。\n※資料作成やフォルダ整理はパソコン版をお使いください。`)
}

boot()
