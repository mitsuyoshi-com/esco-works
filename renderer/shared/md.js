/* 軽量Markdown → HTML（外部ライブラリ不使用・安全にエスケープしてから整形）
   デスクトップ(renderer.js)とモバイル(mobile.js)の両方から <script src> で読み込む共通部品。
   グローバルに escapeHtml / inlineMd / md を公開する。 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
function inlineMd(s) {
  // この時点でsはエスケープ済み。インライン記法だけHTML化する。
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s
}
function md(text) {
  const lines = escapeHtml(text).split('\n')
  let html = ''
  let inCode = false
  let listType = null // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      html += listType === 'ul' ? '</ul>' : '</ol>'
      listType = null
    }
  }
  let para = []
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inlineMd(para.join('<br>'))}</p>`
      para = []
    }
  }
  for (const raw of lines) {
    const line = raw
    if (/^```/.test(line.trim())) {
      flushPara()
      closeList()
      if (!inCode) {
        html += '<pre><code>'
        inCode = true
      } else {
        html += '</code></pre>'
        inCode = false
      }
      continue
    }
    if (inCode) {
      html += line + '\n'
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      flushPara()
      closeList()
      const lvl = h[1].length
      html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`
      continue
    }
    const ul = line.match(/^\s*[-*・]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (listType !== want) {
        closeList()
        html += want === 'ul' ? '<ul>' : '<ol>'
        listType = want
      }
      html += `<li>${inlineMd((ul || ol)[1])}</li>`
      continue
    }
    if (line.trim() === '') {
      flushPara()
      closeList()
      continue
    }
    para.push(line)
  }
  if (inCode) html += '</code></pre>'
  flushPara()
  closeList()
  return html
}
