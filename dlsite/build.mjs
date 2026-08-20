// DLサイト(index.html)を生成する。スクリオットを data URI で埋め込み自己完結にする。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

const b64 = (p) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')
const shotMain = b64(path.join(root, 'build', 'shots', 'main.png'))
const shotSettings = b64(path.join(root, 'build', 'shots', 'settings.png'))
const icon = b64(path.join(root, 'build', 'icon.png'))

// __DOWNLOAD_URL__ と __VERSION__ は公開時に置換する
const DOWNLOAD_URL = process.env.DL_URL || '#download-pending'
const VERSION = process.env.DL_VER || '0.1.0'

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ESCO Works</title>
<link rel="icon" href="${icon}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
:root{
  --bg:#f5f8f6; --ground:#ffffff; --ink:#16242c; --muted:#5b6f78;
  --line:#e2e9e6; --accent:#0e7a5f; --accent2:#1f6feb; --bright:#10b981;
  --warm:#fff8e6; --warmline:#e6d9a8; --warmink:#6b5900;
  --shadow:0 10px 40px rgba(16,40,32,.08);
}
:root:not([data-theme="light"]) { }
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#0d1418; --ground:#131e24; --ink:#eaf2ee; --muted:#9fb2ab;
    --line:#233139; --accent:#2fd3a5; --accent2:#5b9bff; --bright:#2fd3a5;
    --warm:#2a2410; --warmline:#4a4020; --warmink:#e8d9a8;
    --shadow:0 10px 40px rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"]{
  --bg:#0d1418; --ground:#131e24; --ink:#eaf2ee; --muted:#9fb2ab;
  --line:#233139; --accent:#2fd3a5; --accent2:#5b9bff; --bright:#2fd3a5;
  --warm:#2a2410; --warmline:#4a4020; --warmink:#e8d9a8;
  --shadow:0 10px 40px rgba(0,0,0,.4);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:"Noto Sans JP",sans-serif;line-height:1.8;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto;padding:0 24px}
h1,h2,h3{font-family:"Zen Kaku Gothic New",sans-serif;text-wrap:balance;line-height:1.35}
a{color:var(--accent)}
.eyebrow{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--accent);font-weight:700}

/* hero */
.hero{position:relative;overflow:hidden;background:
  radial-gradient(1200px 500px at 80% -10%, rgba(31,111,235,.14), transparent 60%),
  radial-gradient(900px 500px at 0% 0%, rgba(14,122,95,.14), transparent 55%);
  border-bottom:1px solid var(--line)}
.hero .wrap{padding-top:64px;padding-bottom:56px}
.brandrow{display:flex;align-items:center;gap:14px;margin-bottom:28px}
.brandrow img{width:44px;height:44px;border-radius:11px;box-shadow:var(--shadow)}
.brandrow b{font-family:"Zen Kaku Gothic New";font-weight:900;font-size:19px;letter-spacing:.01em}
.hero h1{font-size:clamp(30px,5vw,50px);font-weight:900;margin:10px 0 16px}
.hero h1 .g{background:linear-gradient(100deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.lead{font-size:clamp(16px,2.2vw,19px);color:var(--muted);max-width:34em}
.cta{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-top:30px}
.btn{display:inline-flex;align-items:center;gap:9px;background:var(--accent);color:#fff;text-decoration:none;
  font-weight:700;padding:14px 26px;border-radius:12px;box-shadow:var(--shadow);font-size:16px}
.btn.sec{background:transparent;color:var(--ink);border:1px solid var(--line)}
.meta{font-size:13px;color:var(--muted)}
.shot{margin-top:44px;border-radius:14px;border:1px solid var(--line);box-shadow:var(--shadow);width:100%;display:block}

section{padding:64px 0}
section h2{font-size:clamp(22px,3.4vw,30px);font-weight:900;margin-bottom:8px}
.sub{color:var(--muted);margin-bottom:34px;max-width:40em}

.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px}
.card{background:var(--ground);border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:var(--shadow)}
.card .ic{font-size:24px;margin-bottom:10px}
.card h3{font-size:17px;margin-bottom:6px}
.card p{font-size:14px;color:var(--muted)}

.steps{display:flex;flex-direction:column;gap:16px}
.step{display:grid;grid-template-columns:44px 1fr;gap:18px;background:var(--ground);border:1px solid var(--line);
  border-radius:14px;padding:22px;box-shadow:var(--shadow)}
.num{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));
  color:#fff;display:flex;align-items:center;justify-content:center;font-family:"Zen Kaku Gothic New";font-weight:900}
.step h3{font-size:17px;margin-bottom:4px}
.step p{font-size:14.5px;color:var(--muted)}
.step code{background:rgba(0,0,0,.06);padding:1px 7px;border-radius:5px;font-size:.9em}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .step code{background:rgba(255,255,255,.08)}}

.modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.mode{border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--ground)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 12px;border-radius:999px;margin-bottom:10px}
.pill.n{background:rgba(91,111,122,.12);color:var(--muted)}
.pill.p{background:rgba(47,111,214,.14);color:var(--accent2)}
.pill.b{background:rgba(194,65,12,.14);color:#c2410c}
.mode p{font-size:14px;color:var(--muted)}

.note{background:var(--warm);border:1px solid var(--warmline);color:var(--warmink);border-radius:12px;padding:18px 20px;font-size:14.5px}
.note b{color:var(--warmink)}

footer{border-top:1px solid var(--line);padding:34px 0;color:var(--muted);font-size:13px;text-align:center}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <div class="brandrow"><img src="${icon}" alt="ESCO Works" /><b>ESCO Works</b></div>
    <div class="eyebrow">社内AIアシスタント誕生</div>
    <h1>あなたのPCで動く、<br><span class="g">エスコ専用のAI</span>。</h1>
    <p class="lead">資料づくり、フォルダ整理、調べもの、ブラウザ操作まで。話しかけるだけで、面倒な作業をそのまま代わりにやってくれます。エンジニアの知識はいりません。</p>
    <div class="cta">
      <a class="btn" href="${DOWNLOAD_URL}" download>⬇ Windows版をダウンロード</a>
      <a class="btn sec" href="#howto">使い方を見る</a>
      <span class="meta">バージョン ${VERSION} ・ Windows 10/11</span>
    </div>
    <img class="shot" src="${shotMain}" alt="ESCO Works の画面" />
  </div>
</header>

<section id="can">
  <div class="wrap">
    <div class="eyebrow">できること</div>
    <h2>3つのタブで、だいたいの仕事が回ります</h2>
    <p class="sub">画面上部のタブを選ぶだけ。難しい設定はありません。</p>
    <div class="cards">
      <div class="card"><div class="ic">💬</div><h3>チャット</h3><p>相談、文章の下書き、調べもの。わからないことを気軽に聞けます。</p></div>
      <div class="card"><div class="ic">📄</div><h3>資料作成</h3><p>「この資料を要約して提案書にして」。PDFを渡すだけで清書まで。</p></div>
      <div class="card"><div class="ic">🗂️</div><h3>フォルダ整理</h3><p>散らかったフォルダの分類・リネームを一括で。削除はせず安全に。</p></div>
      <div class="card"><div class="ic">🌐</div><h3>ブラウザ操作</h3><p>「このサイトを開いて調べて」。Chromeを動かして情報を集めます。</p></div>
      <div class="card"><div class="ic">🪟</div><h3>並行作業</h3><p>ウィンドウを増やせば、別々の案件を同時に進められます。</p></div>
      <div class="card"><div class="ic">🔒</div><h3>安全設計</h3><p>危ない操作は必ず確認。大事なファイルを勝手に消したりしません。</p></div>
    </div>
  </div>
</section>

<section id="howto" style="background:var(--ground);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap">
    <div class="eyebrow">使い方</div>
    <h2>インストールから最初の1回まで</h2>
    <p class="sub">3分あれば使い始められます。</p>
    <div class="steps">
      <div class="step"><div class="num">1</div><div><h3>ダウンロードして実行</h3><p>上の「ダウンロード」ボタンから <code>ESCO Works Setup.exe</code> を保存し、ダブルクリックでインストールします。デスクトップにアイコンができます。</p></div></div>
      <div class="step"><div class="num">2</div><div><h3>タブを選んで話しかける</h3><p>「チャット」「資料作成」「フォルダ整理」から選び、下の入力欄にやってほしいことを書いて送信するだけ。資料はドラッグ＆ドロップで渡せます。</p></div></div>
      <div class="step"><div class="num">3</div><div><h3>確認が出たら選ぶだけ</h3><p>AIが方針に迷うと、ボタンで質問してきます。押すだけで作業が進みます。ファイルを触る操作は「許可」を押すと実行されます。</p></div></div>
      <div class="step"><div class="num">4</div><div><h3>更新は自動</h3><p>新しいバージョンが出ると、起動時に自動でダウンロードされます。「今すぐ再起動して更新」を押すだけで最新になります。</p></div></div>
    </div>
  </div>
</section>

<section id="modes">
  <div class="wrap">
    <div class="eyebrow">安心のしくみ</div>
    <h2>3つのモード（Shift+Tabで切替）</h2>
    <p class="sub">どこまでAIに任せるかを、その場で選べます。</p>
    <div class="modes">
      <div class="mode"><span class="pill n">● ノーマル</span><p>ファイルを触る操作の前に毎回確認します。ふだんはこれで安心。</p></div>
      <div class="mode"><span class="pill p">◐ Plan</span><p>まず「何をするか」の計画だけ立てて、実行はしません。相談に便利。</p></div>
      <div class="mode"><span class="pill b">⚡ バイパス</span><p>確認なしで一気に実行。急ぎのとき用。慣れてきたら。</p></div>
    </div>
    <div style="margin-top:26px"><img class="shot" src="${shotSettings}" alt="設定画面" style="max-width:520px" /></div>
  </div>
</section>

<section id="faq" style="background:var(--ground);border-top:1px solid var(--line)">
  <div class="wrap">
    <div class="eyebrow">はじめに</div>
    <h2>よくある質問</h2>
    <div class="cards" style="margin-top:24px">
      <div class="card"><h3>お金はかかる？</h3><p>会社のAI利用分としてまとめて管理しています。使いすぎの心配はいりません。ふだんどおり使ってOKです。</p></div>
      <div class="card"><h3>ファイルを消される？</h3><p>削除はしません。いらないファイルは「_不要」フォルダへ移すだけ。危ない操作は必ず確認します。</p></div>
      <div class="card"><h3>むずかしくない？</h3><p>日本語で話しかけるだけ。専門用語もコマンドも不要です。困ったら「どうすればいい？」と聞いてください。</p></div>
    </div>
    <div class="note" style="margin-top:24px"><b>設定について：</b> 初回起動時、右上の⚙からお名前を入れておくと便利です。APIキーの設定は管理者（山本）が行いますので、届いていない場合はそのままお使いください。</div>
  </div>
</section>

<footer>ESCO Works ・ 株式会社エスココーポレーション 社内ツール ・ 制作 ULTRIX</footer>
</body>
</html>`

fs.writeFileSync(path.join(__dirname, 'index.html'), html, 'utf8')
console.log('dlsite/index.html を生成しました (' + Math.round(html.length / 1024) + ' KB)')
