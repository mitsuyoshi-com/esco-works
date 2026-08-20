// Claude Agent SDK を使った1会話ぶんの実行管理。
// AI-Buddy (00_PIT/ai-buddy) で実証済みの呼び出しパターンを簡略化して流用。
const { randomUUID } = require('crypto')

// 作業モードごとのシステムプロンプト追記とモデル設定キー
const COMMON_PROMPT = `あなたは株式会社エスココーポレーションの社員を手伝う社内AIアシスタント「ESCO Works」です。
- 日本語で、専門用語を避けて分かりやすく話します。相手は非エンジニアの社員です。
- ユーザーのPC上でファイルの読み書き・整理・資料作成を代行できます。
- 方針・保存先・デザイン案などユーザーに決めてもらう分岐があるときは、文章で長々と選択肢を書くのではなく ask_user ツールで選択肢を提示して選んでもらってください。
- 作業フォルダの外にあるファイルは、ユーザーの明確な指示がない限り変更しません（読むのは可）。
- メッセージ中の「（ファイル: パス）」は、ユーザーがドラッグ&ドロップで渡した資料です。まずそれを読んでから作業します。
- 作業の前に何をするか短く伝え、終わったら結果を簡潔にまとめます。`

const MODES = {
  chat: {
    label: 'チャット',
    append: `${COMMON_PROMPT}
- いまは相談・質問モードです。文章の下書きや調べものに簡潔に答えます。`
  },
  docs: {
    label: '資料作成',
    append: `${COMMON_PROMPT}
- いまは資料作成モードです。提案書・案内文・報告書などを作ります。
- 渡された資料（PDF・テキスト等）の要約・抜粋をもとに資料化することもできます。
- まず目的・宛先・分量を1回だけ確認し、その後は完成まで進めます。
- 必要なら作業フォルダ内に案件用のサブフォルダを作って、そこに保存します。
- 完成した資料は作業フォルダにファイルとして保存します（指定がなければHTML、文章だけならテキスト）。`
  },
  files: {
    label: 'フォルダ整理',
    append: `${COMMON_PROMPT}
- いまはフォルダ整理モードです。作業フォルダ内のファイルの分類・移動・リネームを行います。
- 実行する前に、対象ファイルの一覧と変更案（変更前→変更後）を必ず提示して確認を取ります。
- 削除は行わず、不要ファイルは作業フォルダ内の「_不要」フォルダへ移動します。
- 作業フォルダの外は絶対に触りません。`
  }
}

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

// このPCに npx（Node.js）があるか一度だけ判定してキャッシュする。
// 無いPC（多くの社員PC）ではブラウザ操作MCPを起動せず、毎ターンのエラーを防ぐ。
let _npxAvailable
function hasNpx() {
  if (_npxAvailable !== undefined) return _npxAvailable
  try {
    const r = spawnSync('cmd', ['/c', 'npx --version'], { timeout: 8000, windowsHide: true })
    _npxAvailable = r.status === 0
  } catch {
    _npxAvailable = false
  }
  return _npxAvailable
}

// 承認なしで常に許可する読み取り系（外部送信の能力がないもののみ）。
// WebSearch/WebFetchは外部にデータを送れるため、ここには入れず確認フローに回す。
const READONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'])

// 明らかに破壊的で、常に拒否するコマンド。format はドライブフォーマットに限定して誤検知を防ぐ。
const DANGEROUS = /(\bshutdown\b|\bformat(\.com)?\s+[a-z]:|Format-Volume\b|\breg\s+(add|delete)\b|\bdel\s+\/s\b|\brd\s+\/s\b|\bdiskpart\b|\bbcdedit\b|Remove-Item[^\n]*-Rec)/i

// コマンド連結・置換・改行など、単純判定を破る可能性があるメタ文字。
// これらを含むコマンドは autoApprove でも必ずユーザー確認へ回す。
const SHELL_META = /[\r\n;&|`<>]|\$\(/

// 機密ファイルの読み取りを承認フローに回すためのパス（トークン・鍵など）
const SENSITIVE_DIRS = [
  path.join(os.homedir(), '.claude'),
  path.join(os.homedir(), '.ssh'),
  path.join(os.homedir(), '.aws'),
  path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data')
]

// シンボリックリンク/ジャンクションを実体解決した上で親子関係を判定する。
// 書き込み対象は未作成のことがあるため、存在する最も近い祖先まで遡って解決する。
function realResolve(p) {
  let cur = path.resolve(p)
  for (;;) {
    try {
      return fs.realpathSync.native(cur)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return cur // ドライブルートまで遡った
      cur = parent
    }
  }
}

function isInside(child, parent) {
  if (!child || !parent) return false
  const rel = path.relative(realResolve(parent), realResolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function isSensitivePath(p) {
  if (!p) return false
  try {
    const rp = realResolve(p)
    return SENSITIVE_DIRS.some((d) => {
      const rel = path.relative(d, rp)
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
    })
  } catch {
    return false
  }
}

// 配布ビルド時、SDKが起動するネイティブCLI(claude.exe)の実体パスを解決する。
// app.asar内では起動できないため app.asar.unpacked 側を指す。開発時は null（自動解決に任せる）。
let _exeCache
function resolveClaudeExecutable() {
  if (_exeCache !== undefined) return _exeCache
  _exeCache = null
  try {
    const { app } = require('electron')
    if (!app || !app.isPackaged) return _exeCache
    // process.resourcesPath から app.asar.unpacked 配下を直接組み立てる（asar内require.resolveに依存しない）
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@anthropic-ai')
    const candidates = [
      // 入れ子: claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
      path.join(unpacked, 'claude-agent-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
      // フラット
      path.join(unpacked, 'claude-agent-sdk-win32-x64', 'claude.exe')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        _exeCache = c
        return _exeCache
      }
    }
    // 最後の手段: unpacked配下を再帰探索
    const stack = [path.join(process.resourcesPath, 'app.asar.unpacked')]
    while (stack.length) {
      const dir = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name === 'claude.exe') {
          _exeCache = full
          return _exeCache
        }
      }
    }
  } catch {
    _exeCache = null
  }
  return _exeCache
}

// Playwright MCPのうち、閲覧・観測系だけを自動許可する（能動操作は確認へ）
const PLAYWRIGHT_READONLY = new Set([
  'mcp__playwright__browser_snapshot',
  'mcp__playwright__browser_take_screenshot',
  'mcp__playwright__browser_console_messages',
  'mcp__playwright__browser_network_requests',
  'mcp__playwright__browser_tabs'
])

class AgentRunner {
  /**
   * @param {object} deps
   * @param {() => object} deps.getSettings 現在の設定を返す
   * @param {(ev: string, payload: object) => void} deps.emit rendererへのイベント送信
   */
  constructor({ getSettings, emit }) {
    this.getSettings = getSettings
    this.emit = emit
    this.sessionId = undefined
    this.sessionCwd = undefined
    this.abort = null
    this.pending = new Map() // requestId -> { resolve, key }
    this.pendingChoices = new Map() // requestId -> resolve(answerText)  選択肢質問用
    this.remembered = new Set() // 「常に許可」されたツールのキー（セッション中保持）
    this._permMode = 'normal'
    this._askServer = null
  }

  // rendererからの選択肢回答を受け取る
  respondChoice(requestId, answer) {
    const resolve = this.pendingChoices.get(requestId)
    if (resolve) {
      this.pendingChoices.delete(requestId)
      resolve(answer)
    }
  }

  respondPermission(requestId, approved, remember = false) {
    const entry = this.pending.get(requestId)
    if (entry) {
      this.pending.delete(requestId)
      if (approved && remember && entry.key) this.remembered.add(entry.key)
      entry.resolve(approved)
    }
  }

  interrupt() {
    this.abort?.abort()
    this.abort = null
    // 未回答の選択肢質問を解放する
    for (const [, resolve] of this.pendingChoices) resolve('（キャンセルされました）')
    this.pendingChoices.clear()
  }

  newConversation() {
    this.sessionId = undefined
    this.sessionCwd = undefined
  }

  buildCanUseTool(workFolder, autoApprove) {
    // workFolder が null（未選択）の場合、書き込みの自動許可は一切しない
    return async (toolName, input, { signal }) => {
      // 選択肢質問ツールは常に許可（UI操作でユーザーが直接答える）
      if (toolName === 'mcp__ask__ask_user') return { behavior: 'allow', updatedInput: input }

      // バイパスモード: すべて自動許可（上級者向け・自己責任）
      if (this._permMode === 'bypass') return { behavior: 'allow', updatedInput: input }

      // Planモード: 一切作らない。読み取り・調査系のみ許可し、変更系は全て拒否する。
      if (this._permMode === 'plan') {
        if (READONLY_TOOLS.has(toolName) || toolName === 'WebSearch' || toolName === 'WebFetch') {
          return { behavior: 'allow', updatedInput: input }
        }
        // Playwrightは閲覧・観測のみ許可（能動操作は計画段階では不可）
        if (
          toolName === 'mcp__playwright__browser_snapshot' ||
          toolName === 'mcp__playwright__browser_take_screenshot' ||
          toolName === 'mcp__playwright__browser_console_messages' ||
          toolName === 'mcp__playwright__browser_network_requests'
        ) {
          return { behavior: 'allow', updatedInput: input }
        }
        // 読み取り専用のシェルコマンドだけ許可
        if (toolName === 'Bash') {
          const cmd = String((input && input.command) || '')
          if (
            !SHELL_META.test(cmd) &&
            /^\s*(dir|ls|type|cat|Get-Content|Get-ChildItem|gci|findstr|Select-String|where|pwd|cd|git\s+(status|log|diff|branch|show))\b/i.test(
              cmd
            )
          ) {
            return { behavior: 'allow', updatedInput: input }
          }
        }
        // それ以外（Write/Edit/mkdir/その他の実行）は計画段階では行わない
        return {
          behavior: 'deny',
          message: 'Planモード中です。まず計画を提示し、実行はモードを切り替えてから行います。'
        }
      }

      // 読み取り系は許可。ただし機密パスの読み取りは確認へ回す。
      if (READONLY_TOOLS.has(toolName)) {
        const p = input && (input.file_path || input.path || input.pattern)
        if ((toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') && isSensitivePath(p)) {
          // 確認フローへ落とす
        } else {
          return { behavior: 'allow', updatedInput: input }
        }
      }

      // ブラウザ操作: 画面に見える操作なので基本は自動許可。
      // ファイルアップロードと、http/https以外へのnavigateだけ確認へ回す。
      if (toolName.startsWith('mcp__playwright')) {
        if (toolName === 'mcp__playwright__browser_file_upload') {
          // 確認へ
        } else if (toolName === 'mcp__playwright__browser_navigate') {
          const url = String((input && input.url) || '')
          if (/^https?:\/\//i.test(url) || !url) return { behavior: 'allow', updatedInput: input }
          // file:/about:/chrome: などは確認へ
        } else {
          return { behavior: 'allow', updatedInput: input }
        }
      }

      // ファイル書き込みは作業フォルダ内（実体解決後）なら許可
      if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
        const p = input && (input.file_path || input.notebook_path)
        if (workFolder && p && isInside(p, workFolder)) return { behavior: 'allow', updatedInput: input }
      }

      // シェル実行
      if (toolName === 'Bash') {
        const cmd = String((input && input.command) || '')
        if (DANGEROUS.test(cmd)) {
          return { behavior: 'deny', message: '安全ポリシーにより、この操作は実行できません' }
        }
        const hasMeta = SHELL_META.test(cmd)
        // フォルダ作成は非破壊なので許可（連結・置換・改行を含まない単独のmkdirのみ）
        if (!hasMeta && /^\s*(mkdir|New-Item\s+[^\r\n]*-ItemType\s+Directory)\s+\S/i.test(cmd)) {
          return { behavior: 'allow', updatedInput: input }
        }
        // 自動許可はメタ文字を含まないコマンドに限る（連結で危険操作を混ぜられるのを防ぐ）
        if (autoApprove && !hasMeta) return { behavior: 'allow', updatedInput: input }
      }

      // 「常に許可」済みのツールは確認せず許可
      const key = toolName
      if (this.remembered.has(key)) return { behavior: 'allow', updatedInput: input }

      // それ以外はユーザーに確認
      const requestId = randomUUID()
      const detail =
        toolName === 'Bash'
          ? String((input && input.command) || '')
          : JSON.stringify(input || {}).slice(0, 500)
      this.emit('agent:ask', { requestId, tool: toolName, label: toolChip(toolName), detail })
      const approved = await new Promise((resolve) => {
        this.pending.set(requestId, { resolve, key })
        signal?.addEventListener('abort', () => {
          this.pending.delete(requestId)
          resolve(false)
        })
      })
      return approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'ユーザーが承認しませんでした' }
    }
  }

  /**
   * 1ターン実行。text: ユーザー入力 / mode: chat|docs|files / workFolder: 作業フォルダ
   * autoApprove: ファイル操作の自動許可（フォルダ整理モードの一括処理向け）
   */
  async startTurn({ text, mode, workFolder, cwd, autoApprove, permMode }) {
    const settings = this.getSettings()
    const modeDef = MODES[mode] || MODES.chat
    const model = (settings.models && settings.models[mode]) || 'claude-sonnet-5'
    const effectiveCwd = workFolder || cwd // 未選択時はスクラッチ領域で動く
    this._permMode = permMode || 'normal' // normal | plan | bypass

    // 作業フォルダが変わったらセッションを作り直す（cwd単位で保存されるため）
    if (this.sessionCwd !== effectiveCwd) {
      this.sessionId = undefined
      this.sessionCwd = effectiveCwd
    }

    let append = modeDef.append
    if (this._permMode === 'plan') {
      append += `
- 現在はPlanモードです。ファイルの作成・編集・コマンド実行は一切行いません。
- まず必要に応じて読み取り・調査だけを行い、その上で「何を・どの順で行うか」の計画を箇条書きで提示してください。
- 計画を提示したらそこで止まり、ユーザーの承認を待ってください。勝手に制作を始めないこと。`
    }
    if (!workFolder) {
      append += `
- 現在、作業フォルダは未選択ですが、それを理由に作業を断らないでください。
- ユーザーが場所を明示した依頼（例:「デスクトップにフォルダを作って」「C:\\...のファイルを読んで」）は、そのまま実行してください。必要な操作はユーザーが画面の承認バーで許可します。デスクトップは %USERPROFILE%\\Desktop です。
- 保存先の指定がなく曖昧なときだけ、保存先を質問してください（📁ボタンで作業フォルダを選ぶ方法も一言添えてよい）。`
    }

    const abort = new AbortController()
    this.abort = abort

    // ブラウザ操作は「設定ON かつ npx(Node.js)がある」場合のみ有効
    const browserEnabled = !!settings.enableBrowser && hasNpx()
    this._expectBrowser = browserEnabled

    const env = { ...process.env }
    if (settings.apiKey) env.ANTHROPIC_API_KEY = settings.apiKey

    // 選択肢質問ツール(ask)を初回のみ構築してキャッシュ
    if (!this._askServer) {
      const { createAskMcpServer } = require('./mcp/askTool')
      this._askServer = await createAskMcpServer({
        ask: (question, options) =>
          new Promise((resolve) => {
            const requestId = randomUUID()
            this.pendingChoices.set(requestId, resolve)
            this.emit('agent:choice', { requestId, question, options: options || [] })
          })
      })
    }

    // ブラウザ操作が有効なときのみPlaywright MCP(公式)を接続
    // Windowsではnpxをcmd経由で起動する。--browser chromeでインストール済みChromeを使う
    const mcpServers = {
      ask: this._askServer,
      ...(browserEnabled
        ? {
            playwright: {
              command: 'cmd',
              args: ['/c', 'npx', '-y', '@playwright/mcp@latest', '--browser', 'chrome']
            }
          }
        : {})
    }

    // 配布ビルド(asar)ではSDKがapp.asar内のネイティブclaude.exeをspawnできないため、
    // app.asar.unpacked 側の実体パスを明示する（開発時はundefinedのまま=自動解決）。
    const exePath = resolveClaudeExecutable()

    // 許可モード → SDKのpermissionMode
    // Planモードは独自のcanUseTool+プロンプトで「作らない」を保証するため、
    // SDKのplanモード(ExitPlanModeツールを要する)は使わずdefaultで動かす。
    const sdkPermMode = this._permMode === 'bypass' ? 'bypassPermissions' : 'default'

    const buildOptions = (resumeId) => ({
      cwd: effectiveCwd,
      resume: resumeId,
      includePartialMessages: true,
      permissionMode: sdkPermMode,
      canUseTool: this.buildCanUseTool(workFolder, !!autoApprove),
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      model,
      maxTurns: 80,
      abortController: abort,
      env,
      mcpServers,
      ...(exePath ? { pathToClaudeCodeExecutable: exePath } : {})
    })

    const run = async (resumeId) => {
      let sawToken = false
      let finalText = ''
      // Agent SDKはESM専用のため動的importで読み込む
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const q = query({ prompt: text, options: buildOptions(resumeId) })
      for await (const msg of q) {
        if (abort.signal.aborted) break
        this.handleMessage(msg, {
          onToken: () => (sawToken = true),
          setFinal: (t) => (finalText = t)
        })
      }
      if (!sawToken && finalText) this.emit('agent:text', { text: finalText })
    }

    const isAbort = (err) =>
      abort.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))

    try {
      await run(this.sessionId)
    } catch (err) {
      // ユーザーの停止操作はエラーではなく正常終了として扱う
      if (isAbort(err)) {
        this.emit('agent:done', { costUsd: 0, durationMs: 0 })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      // resume先が見つからない場合はセッションを捨てて1回だけ再実行
      if (this.sessionId && /no conversation found|session id|resume/i.test(message)) {
        this.sessionId = undefined
        try {
          await run(undefined)
          return
        } catch (err2) {
          if (isAbort(err2)) {
            this.emit('agent:done', { costUsd: 0, durationMs: 0 })
            return
          }
          this.emit('agent:error', { message: err2 instanceof Error ? err2.message : String(err2) })
          return
        }
      }
      this.emit('agent:error', { message })
    } finally {
      this.abort = null
    }
  }

  handleMessage(msg, cb) {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init' && msg.session_id) this.sessionId = msg.session_id
        // ブラウザ操作を有効にしたターンで、playwrightサーバーが明確に失敗した場合のみ通知
        if (msg.subtype === 'init' && this._expectBrowser && Array.isArray(msg.mcp_servers)) {
          const pw = msg.mcp_servers.find((s) => s && /playwright/i.test(String(s.name || '')))
          if (pw && /failed|error/i.test(String(pw.status || ''))) {
            this.emit('agent:error', {
              message:
                'ブラウザ操作機能を起動できませんでした。このPCにNode.js/npxが無い可能性があります。設定でブラウザ操作をOFFにするか、管理者にご相談ください。'
            })
          }
        }
        break
      }
      case 'stream_event': {
        const ev = msg.event
        if (!ev) break
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          cb.onToken()
          this.emit('agent:token', { delta: ev.delta.text })
        } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
          this.emit('agent:tool', { tool: toolChip(String(ev.content_block.name || 'tool')) })
        }
        break
      }
      case 'assistant': {
        const content = msg.message?.content
        if (Array.isArray(content)) {
          let text = ''
          for (const block of content) {
            if (block.type === 'text' && typeof block.text === 'string') text += block.text
            if (block.type === 'tool_use') {
              this.emit('agent:tool', { tool: toolChip(String(block.name || 'tool')) })
            }
          }
          if (text) cb.setFinal(text)
        }
        break
      }
      case 'result': {
        this.emit('agent:done', {
          costUsd: msg.total_cost_usd || 0,
          durationMs: msg.duration_ms || 0
        })
        break
      }
      default:
        break
    }
  }
}

function toolChip(name) {
  if (name === 'Bash') return 'Running command'
  if (name === 'Write' || name === 'Edit') return 'Writing files'
  if (name === 'Read') return 'Reading files'
  if (name === 'Glob' || name === 'Grep') return 'Searching files'
  if (name === 'TodoWrite' || name === 'Task') return 'Planning'
  if (name.startsWith('mcp__playwright')) return 'Browsing the web'
  if (name.startsWith('mcp__')) return 'Using external tool'
  return `Running ${name}`
}

module.exports = { AgentRunner, MODES }
