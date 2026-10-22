// Assemble a static page from the plugin's own CSS so a headless browser can
// answer two questions a render test cannot: does the 0fr→1fr fold really
// interpolate (and is the shut fold really zero tall), and does the panel still
// lay out with the extra disclosure wrapper in place?
import { readFileSync, writeFileSync } from 'node:fs'

const bundle = readFileSync(new URL('../../dist/client.js', import.meta.url), 'utf8')
const start = bundle.indexOf('const CSS = [')
const end = bundle.indexOf("].join('')", start)
if (start < 0 || end < 0) throw new Error('preview: could not find the CSS array in the bundle')
const CSS = new Function(`return ${bundle.slice(bundle.indexOf('[', start), end + 1)}`)().join('')

const chev = (open) =>
  `<span class="dsmise-chev${open ? ' is-open' : ''}" aria-hidden="true"><svg viewBox="0 0 9 9" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 1.6 6.4 4.5 3.2 7.4"/></svg></span>`

const subRows = ['1.7.1', '1.6.0']
  .map(
    (version, index) => `
        <div class="dsmise-sub-row">
          <div class="dsmise-row-main"><span class="dsmise-mono">${version}</span>${
            index === 0 ? '<button type="button" class="dsmise-update">↑1.8.2</button>' : ''
          }</div>
          <div class="dsmise-row-main">${
            index === 0 ? '<span class="dsmise-chip is-active">生效</span>' : '<span class="dsmise-chip is-warn">未使用</span>'
          }</div>
          <span class="dsmise-dim dsmise-mono dsmise-ellipsis">/home/x/.local/share/mise/installs/jq/${version}</span>
          <div class="dsmise-row-main dsmise-cell-actions">${
            index === 0 ? '' : '<button type="button" class="dsmise-btn">启用</button>'
          }<button type="button" class="dsmise-btn" title="uninstallHint">卸载</button></div>
        </div>`,
  )
  .join('')

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>dsh-mise motion preview</title>
<style>
  :root{--dsw-alias-label-primary:#1c1f23;--dsw-alias-label-secondary:#6b7280;--dsw-alias-bg-base:#fff;--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f4f5f7;--dsw-alias-border-l1:#e3e5e8;--dsw-alias-border-l2:#cfd3d8;--dsw-alias-brand-primary:#2f6fed;--dsw-alias-state-success-primary:#1a9e5c;--dsw-alias-state-warn-primary:#b7791f;--dsw-alias-state-error-primary:#d0342c;--dsw-radius-md:8px;--dsw-focus-ring-width:2px}
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;padding:24px;background:#fff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  .page{max-width:760px}
  ${CSS}
</style></head>
<body><div class="page"><div class="dsmise">
  <div class="dsmise-head"><h2>工具链管理</h2></div>
  <section class="dsmise-sec">
    <div class="dsmise-row">
      <input class="dsmise-input grow" placeholder="工具名或用途，如 node / pnpm@12 / javascript runtime">
      <button type="button" class="dsmise-btn primary">查找</button>
      <button type="button" class="dsmise-btn">刷新</button>
    </div>
  </section>
  <div class="dsmise-sec">
    <div class="dsmise-table">
      <div class="dsmise-tr is-head"><span>工具</span><span>当前</span><span style="text-align:right">已装</span></div>
      <div class="dsmise-tr">
        <div class="dsmise-cell"><div class="dsmise-row-main">
          <button type="button" class="dsmise-tool" aria-expanded="true">${chev(true)}<span class="dsmise-name dsmise-mono">jq</span></button>
        </div></div>
        <div class="dsmise-cell"><div class="dsmise-row-main"><span class="dsmise-mono">1.7.1</span><button type="button" class="dsmise-update">↑1.8.2</button></div></div>
        <div class="dsmise-cell dsmise-cell-count"><span class="dsmise-count dsmise-mono">2 个版本</span></div>
      </div>
      <div class="dsmise-collapse dsmise-sub-wrap is-open" id="sub">
        <div class="dsmise-sub"><div class="dsmise-sub-inner">
          <div class="dsmise-sub-row is-head"><span>版本</span><span>状态</span><span>路径</span><span style="text-align:right">操作</span></div>
          ${subRows}
          <div class="dsmise-sub-row is-system">
            <span class="dsmise-mono">jq-1.7</span>
            <span class="dsmise-row-main"><span class="dsmise-chip is-system">系统</span></span>
            <span class="dsmise-dim dsmise-mono dsmise-ellipsis">/usr/bin/jq</span>
            <div class="dsmise-row-main dsmise-cell-actions"></div>
          </div>
        </div></div>
      </div>
      <div class="dsmise-tr">
        <div class="dsmise-cell"><div class="dsmise-row-main"><span class="dsmise-name dsmise-mono">node</span></div></div>
        <div class="dsmise-cell"><div class="dsmise-row-main"><span class="dsmise-mono">20.20.2</span></div></div>
        <div class="dsmise-cell dsmise-cell-count"><span class="dsmise-count dsmise-mono">1 个版本</span></div>
      </div>
    </div>
    <div class="dsmise-fold">
      <button type="button" class="dsmise-fold-head" aria-expanded="false" id="foldHead"><span id="foldChevWrap">${chev(false)}</span><span>系统自带 · 2</span></button>
      <div class="dsmise-collapse dsmise-fold-wrap" id="fold">
        <div class="dsmise-fold-body"><div class="dsmise-fold-inner">
          <div class="dsmise-sys-row"><button type="button" class="dsmise-tool"><span class="dsmise-name dsmise-mono">corepack</span></button><span class="dsmise-mono">0.29.0</span><span class="dsmise-dim dsmise-mono dsmise-ellipsis">/usr/local/bin/corepack</span></div>
          <div class="dsmise-sys-row"><button type="button" class="dsmise-tool"><span class="dsmise-name dsmise-mono">node</span></button><span class="dsmise-mono">v24.0.0</span><span class="dsmise-dim dsmise-mono dsmise-ellipsis">/usr/local/bin/node</span></div>
        </div></div>
      </div>
    </div>
  </div>
  <div class="dsmise-card">
    <div class="dsmise-row">
      <div class="dsmise-row-main"><span class="dsmise-live" aria-hidden="true"></span><span class="dsmise-name dsmise-mono">安装 jq@1.8.2</span></div>
      <span class="dsmise-dim">已用 3s</span>
    </div>
    <pre class="dsmise-log">mise jq@1.8.2 downloading…</pre>
  </div>
  <div class="dsmise-alert has-close ok"><div class="dsmise-notice-body"><div>已切换 jq@1.7.1</div></div><button type="button" class="dsmise-alert-close">✕</button></div>
</div></div>
<div id="out">waiting</div>
<script>
  // A DOM stand-in for the component's own effect, checked through the
  // transition objects rather than a stopwatch: headless virtual time cannot be
  // trusted to let a 200ms curve play out, but a real height transition with
  // the plugin's duration is exactly what the component depends on.
  const fold = document.getElementById('fold')
  const head = document.getElementById('foldHead')
  const chev = document.querySelector('#foldChevWrap .dsmise-chev')
  const out = document.getElementById('out')
  const hh = () => Math.round(fold.getBoundingClientRect().height)
  const running = (el) =>
    el.getAnimations().map((a) => (a.transitionProperty || a.animationName) + '/' + a.effect.getTiming().duration).join(',') || 'none'
  const settle = (el) => { el.getAnimations().forEach((a) => a.finish()) }
  const report = ['shut=' + hh()]
  const face = (on) => { head.classList.toggle('is-open', on); chev.classList.toggle('is-open', on) }

  // open: pin the measured height, as the component does
  face(true)
  fold.classList.add('is-open')
  fold.style.height = fold.scrollHeight + 'px'
  report.push('open runs ' + running(fold))
  settle(fold)
  report.push('open end=' + hh())
  fold.style.height = 'auto'

  // close: pin what it is now, then let go to zero
  fold.style.height = fold.scrollHeight + 'px'
  void fold.offsetHeight
  face(false)
  fold.classList.remove('is-open')
  fold.style.height = '0px'
  report.push('close runs ' + running(fold))
  settle(fold)
  report.push('close end=' + hh())

  // Leave it open for the screenshot, the way the component does it: pinned,
  // then released to auto once the fold has arrived.
  face(true)
  fold.classList.add('is-open')
  fold.style.height = fold.scrollHeight + 'px'
  fold.getAnimations().forEach((a) => a.finish())
  fold.style.height = 'auto'
  out.textContent = report.join('  |  ')
</script>
</body></html>`

writeFileSync(new URL('./preview.html', import.meta.url), page)
console.log('preview written:', CSS.length, 'bytes of CSS')
