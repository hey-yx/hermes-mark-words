import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(here, '..', 'desktop', 'plugin.js')

// 插件在渲染进程里跑，测试里用一套最小 DOM 替身：文本节点、Range、
// 高亮注册表、popover 元素工厂。断言全部打在真实插件源码上。
globalThis.NodeFilter = { SHOW_TEXT: 4 }

// 插件会 observe(document.documentElement) 来发现新的助手回复
globalThis.__observers = []
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.observed = []; globalThis.__observers.push(this) }
  observe(target, options) { this.observed.push({ target, options }) }
  disconnect() { this.observed = [] }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// 插件里有轮询计时器，测试结束后必须释放，否则 node --test 不会退出
const loaded = []
after(() => { for (const app of loaded) app.dispose() })

function createEl(tag) {
  const styleVars = new Map()
  const el = {
    tag,
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    id: '',
    style: {
      setProperty(name, value) { styleVars.set(name, value) },
      getPropertyValue(name) { return styleVars.get(name) || '' },
      removeProperty(name) { styleVars.delete(name) }
    },
    children: [],
    attrs: {},
    handlers: {},
    setAttribute(key, value) {
      this.attrs[key] = value
      // 真 DOM 里 setAttribute('class', ...) 会同步 className
      if (key === 'class') this.className = value
    },
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null },
    hasAttribute(key) { return key in this.attrs },
    appendChild(child) {
      this.children.push(child)
      if (child) child.parentElement = this
      return child
    },
    contains(node) {
      let cur = node
      while (cur) {
        if (cur === this) return true
        cur = cur.parentElement
      }
      return false
    },
    get firstChild() { return this.children[0] || null },
    removeChild(child) { this.children = this.children.filter(item => item !== child) },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn) },
    removeEventListener() {},
    getBoundingClientRect() {
      // 隐藏的元素量不到盒子：真实浏览器里 display:none 的 getBoundingClientRect 全是 0
      if (this.style && this.style.display === 'none') {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
      }
      return { top: 0, left: 0, right: 220, bottom: 120, width: 220, height: 120 }
    },
    classList: { add() {}, remove() {} },
    querySelector() { return null },
    querySelectorAll() { return [] }
  }
  return el
}

function buildDom(replyText, rangeRect = { top: 10, left: 10, right: 200, bottom: 30, width: 190, height: 20 }, legacy = new Map()) {
  const created = []
  const mdEl = createEl('div')
  mdEl.textContent = replyText
  // 文本节点身份：React 重渲染会把旧节点换掉，旧节点脱离文档（isConnected=false），
  // 挂在它上面的 Range 立刻失效，浏览器当帧就不画了。swap() 就是这个动作。
  const textState = (() => {
    function makeTextNode(source) {
      const node = {
        nodeType: undefined,
        live: true,
        get nodeValue() { return source.textContent },
        get isConnected() { return node.live }
      }
      return node
    }
    let node = makeTextNode(mdEl)
    return {
      current(source) { if (source && source !== mdEl) return makeTextNode(source); return node },
      // React 重渲染：旧节点脱离文档，新节点接替
      swap() { node.live = false; node = makeTextNode(mdEl); return node }
    }
  })()
  const assistantEl = createEl('div')
  // 正文容器直接挂在 assistant 下：thinking 块的排除逻辑要沿 parentElement 上溯
  mdEl.parentElement = assistantEl
  assistantEl.querySelector = sel => (sel === '.aui-md' ? mdEl : null)
  assistantEl.querySelectorAll = sel => (sel === '.aui-md' ? [mdEl] : [])

  const doc = {
    handlers: {},
    body: createEl('body'),
    head: createEl('head'),
    documentElement: createEl('html'),
    createElement(tag) { const el = createEl(tag); created.push(el); return el },
    createElementNS(_ns, tag) { const el = createEl(tag); created.push(el); return el },
    getElementById(id) { return created.find(el => el.id === id) || null },
    querySelectorAll(sel) { return sel === '[data-role="assistant"]' ? [assistantEl] : [] },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn) },
    removeEventListener() {},
    createTreeWalker(root) {
      const source = root && root.textContent ? root : mdEl
      const node = textState.current(source)
      let done = false
      return { nextNode() { if (done) return null; done = true; return node } }
    },
    createRange() {
      return {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset },
        getBoundingClientRect() { return rectState.rect },
        getClientRects() { return [rectState.rect] }
      }
    }
  }

  // 词在屏幕上的位置：测试可以改它来模拟文字挪位或滚动
  const rectState = { rect: rangeRect }
  const highlights = new Map()
  // 旧插件的存储键就在浏览器 localStorage 里，模拟一份用来测迁移
  const localStorage = {
    getItem: key => (legacy.has(key) ? legacy.get(key) : null),
    setItem: (key, value) => legacy.set(key, String(value)),
    removeItem: key => legacy.delete(key),
    has: key => legacy.has(key)
  }
  const win = {
    localStorage,
    innerWidth: 1200,
    innerHeight: 900,
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn) },
    removeEventListener() {},
    matchMedia: () => ({ matches: false }),
    Highlight: class Highlight {
      constructor(...ranges) { this.ranges = ranges }
    },
    CSS: {
      highlights: {
        set(name, value) { highlights.set(name, value) },
        get(name) { return highlights.get(name) },
        delete(name) { highlights.delete(name) },
        keys() { return [...highlights.keys()] }
      }
    }
  }

  return { doc, win, assistantEl, mdEl, created, highlights, rectState, textState }
}

async function loadPlugin({ locale = 'en', tier = 'balanced', replyText = '', taskSlot = 'title_generation', rangeRect, stored = new Map(), legacy = null, i18nEnabled = true } = {}) {
  const source = await readFile(ENTRY, 'utf8')
  const body = source
    .replace(/^import .*\n/gm, '')
    .replace('export default plugin', 'return { plugin, internals }')

  const { doc, win, assistantEl, mdEl, created, highlights, rectState, textState } = buildDom(replyText, rangeRect, legacy)

  const bundles = {}
  const isRecord = v => typeof v === 'object' && v !== null && !Array.isArray(v)
  const walk = (tree, key) => key.split('.').reduce((cur, part) => (isRecord(cur) ? cur[part] : undefined), tree)
  const render = (value, args) => (typeof value === 'string' ? value : typeof value === 'function' ? value(...args) : null)
  const translate = (key, ...args) => {
    const active = render(walk(bundles[locale], key), args)
    if (active !== null) return active
    if (locale !== 'en') {
      const fallback = render(walk(bundles.en, key), args)
      if (fallback !== null) return fallback
    }
    return key
  }

  const listeners = {}
  const disposeCallbacks = []
  const requests = []
  const inserted = []
  const submitted = []
  const notifications = []
  const settingsPages = []
  const localeListeners = []
  const registered = []

  const host = {
    state: { focusedSessionId: { get: () => 'runtime-1' } },
    request: async (method, params) => {
      requests.push({ method, params })
      if (method === 'llm.oneshot') {
        return {
          text: JSON.stringify({
            terms: [
              { term: '门诊慢特病', kind: 'term', explain: '门诊慢性病与特殊病', note: '按当地口径', questions: ['慢特病怎么认定？'] },
              { term: '量子纠缠退税', kind: 'fabricated', explain: '疑似生造或含义不明', note: '未见常见政策口径', questions: ['这个说法有出处吗？'] }
            ]
          })
        }
      }
      return {}
    },
    composer: {
      insertText: async (sessionId, text, options) => { inserted.push({ sessionId, text, options }); return true },
      submit: async (...args) => { submitted.push(args) }
    },
    notify: payload => notifications.push(payload),
    onEvent(type, fn) { (listeners[type] = listeners[type] || []).push(fn); return () => {} }
  }

  const atom = init => {
    let value = init
    return { get: () => value, set: next => { value = typeof next === 'function' ? next(value) : next } }
  }
  const useValue = a => a.get()
  const useState = init => [typeof init === 'function' ? init() : init, () => {}]
  const jsx = (type, props) => (typeof type === 'function' ? type(props) : { type, props })
  const jsxs = jsx
  const noopComponent = () => null
  const uiStub = name => name

  const storageMap = stored
  const ctx = {
    storage: {
      get: (key, fallback) => (storageMap.has(key) ? storageMap.get(key) : fallback),
      set: (key, value) => storageMap.set(key, value),
      remove: key => storageMap.delete(key)
    },
    i18n: i18nEnabled ? {
      register: registered => { Object.assign(bundles, registered); return () => {} },
      t: translate,
      onLocaleChange: fn => { localeListeners.push(fn); return () => {} },
      registerAppLocale: () => () => {}
    } : undefined,
    onEvent: (type, fn) => host.onEvent(type, fn),
    addEventListener: (target, type, fn) => {
      target.handlers = target.handlers || {}
      ;(target.handlers[type] = target.handlers[type] || []).push(fn)
      return () => {}
    },
    register: payload => { registered.push(payload); return () => {} },
    registerMany: () => () => {},
    registerSettingsPage: page => { settingsPages.push(page); return () => {} },
    onDispose: (fn) => { disposeCallbacks.push(fn) },
    os: null
  }

  const factory = new Function(
    'host', 'usePluginI18n', 'SegmentedControl', 'ToggleRow', 'Button', 'PALETTE_AREA', 'TRANSCRIPT_DIRECTIVE_AREA',
    'jsx', 'jsxs', 'useState', 'document', 'window',
    body
  )
  const { plugin, internals } = factory(
    host, () => translate, uiStub('ToggleRow'), uiStub('SegmentedControl'), uiStub('Button'), 'palette', 'transcript.directives',
    jsx, jsxs, useState, doc, win
  )

  plugin.register(ctx)
  loaded.push({ dispose: () => disposeCallbacks.forEach(fn => fn()) })

  return {
    plugin,
    internals,
    bundles,
    requests,
    registered,
    inserted,
    submitted,
    notifications,
    settingsPages,
    highlights,
    storageMap,
    doc,
    win,
    created,
    assistantEl,
    mdEl,
    rectState,
    textState,
    changeLocale: next => { locale = next; localeListeners.forEach(fn => fn()) },
    fire: (type, payload, sid = 'runtime-1') => (listeners[type] || []).forEach(fn => fn({ session_id: sid, payload })),
    dispose: () => disposeCallbacks.forEach(fn => fn())
  }
}

const REPLY = '门诊慢特病按病种，多数 70%。量子纠缠退税需要先自付 20%，剩下的 80% 再乘医院比例。'

test('balanced and detailed inspect the end of a long reply', async () => {
  const text = '普通背景介绍。'.repeat(1400) + '门诊慢特病和量子纠缠退税需要解释。';
  for (const tier of ['balanced', 'detailed']) {
    const app = await loadPlugin({ tier, replyText: text });
    assert.ok(app.internals.buildUserInput(text, tier, null).includes('量子纠缠退税'));
    await app.internals.analyzeReply(text, 'runtime-1', app.assistantEl);
    const request = app.requests.find(item => item.method === 'llm.oneshot');
    assert.ok(request.params.input.includes('量子纠缠退税'), `${tier} must send the tail`);
    assert.ok([...app.highlights.values()].some(item => item.ranges.length));
    app.dispose();
  }
});

test('explanations follow the app language, not the reply language', async () => {
  for (const [locale, language] of [['en', 'English'], ['zh', '中文']]) {
    const app = await loadPlugin({ locale, replyText: REPLY });
    await app.internals.analyzeReply(REPLY, 'runtime-1', app.assistantEl);
    const request = app.requests.find(item => item.method === 'llm.oneshot');
    assert.ok(request.params.instructions.includes(`Explanation language: ${language}`));
    app.dispose();
  }
});

test('locale change updates static labels', async () => {
  const app = await loadPlugin({ locale: 'en', replyText: REPLY });
  assert.equal(app.settingsPages.at(-1).title, 'Mark Words');
  app.changeLocale('zh');
  assert.equal(app.settingsPages.at(-1).title, '标词助手');
  app.dispose();
});

test('locale bundles cover en and zh with identical key sets', async () => {
  const { bundles } = await loadPlugin()
  assert.ok(bundles.en && bundles.zh)
  const dotted = Object.keys(bundles.en).filter(key => key.includes('.'))
  assert.deepEqual(dotted, [], `flat dotted keys are unreachable in the host: ${dotted}`)
  assert.deepEqual(Object.keys(bundles.zh).sort(), Object.keys(bundles.en).sort())
  for (const key of Object.keys(bundles.en)) {
    assert.equal(typeof bundles.en[key], 'string', `${key} must be a plain string`)
    assert.equal(typeof bundles.zh[key], 'string', `${key} must be a plain string`)
  }
})

test('tier labels are the three levels the user asked for', async () => {
  const { internals } = await loadPlugin()
  assert.deepEqual(internals.TIER_IDS, ['light', 'balanced', 'detailed'])
  assert.equal(internals.TIERS.light.scan, 'local')
  assert.equal(internals.TIERS.balanced.scan, 'full')
  assert.equal(internals.TIERS.detailed.scan, 'full')
  assert.ok(internals.TIERS.detailed.maxTerms > internals.TIERS.balanced.maxTerms)
  assert.ok(internals.TIERS.detailed.questions >= internals.TIERS.balanced.questions)
})

test('model JSON parsing survives fences, prose and junk', async () => {
  const { internals } = await loadPlugin()
  const fenced = internals.parseModelJson('```json\n{"terms":[{"term":"A"}]}\n```')
  assert.equal(fenced.length, 1)
  assert.equal(fenced[0].term, 'A')
  const prose = internals.parseModelJson('好的，结果如下：{"terms":[{"term":"B","kind":"term"}]} 以上。')
  assert.equal(prose.length, 1)
  assert.equal(prose[0].term, 'B')
  assert.deepEqual(internals.parseModelJson('完全不是 JSON'), [])
  assert.deepEqual(internals.parseModelJson(''), [])
  assert.deepEqual(internals.parseModelJson('{"terms":[{"kind":"term"}]}'), [])
})

test('local candidate extraction finds acronyms, identifiers and Chinese jargon', async () => {
  const { internals } = await loadPlugin()
  const found = internals.localCandidates('用 API 和 snake_case_id 调用 authToken 服务，门诊慢特病按病种报销。')
  assert.ok(found.includes('API'))
  assert.ok(found.includes('snake_case_id'))
  assert.ok(found.includes('authToken'))
  assert.ok(found.some(term => term.includes('慢特病')))
})

test('自动把 p90 这类性能指标当成候选，且不碰版本号、URL 和普通数字', async () => {
  const { internals } = await loadPlugin()
  const text = '首字中位 1.59s，P90 2.30s，p90 与 p95 都降了，TTFB 快了一点，QPS 上去了。'
  const found = internals.localCandidates(text)
  for (const term of ['P90', 'p90', 'p95', '首字中位', 'TTFB', 'QPS']) {
    assert.ok(found.includes(term), `应当抽到 ${term}，实际 ${JSON.stringify(found)}`)
  }
  // 轻档只留 3 个候选：指标必须排在最前面，不被别的词挤掉
  assert.deepEqual(found.slice(0, 3).sort(), ['P90', 'p90', 'p95'].sort())

  const noisy = '版本 v1.2.3，旧值 3.0s，30 次样本，见 https://ex.com/p90/docs，第 3 章，16GB 内存，HTTP/2。'
  const leaked = internals.localCandidates(noisy)
  for (const junk of ['ex.com/p90', 'v1.2.3', '3.0s', '30', '16GB', 'HTTP/2']) {
    assert.ok(!leaked.includes(junk), `不该把 ${junk} 当候选，实际 ${JSON.stringify(leaked)}`)
  }
})

test('指标词与基础词过不了闸门，URL 片段和版本号也过不去', async () => {
  const { internals } = await loadPlugin()
  const text = 'p90 2.30s，P90 表示九成样本不超过它，路由要把加载算进去，见 ex.com/p90 与 v1.2.3。'
  // p90 这类标准指标词含义明确，按「只标有疑点」的口径不标
  assert.equal(internals.isUsableTerm('p90', text), false)
  assert.equal(internals.isUsableTerm('P90', text), false)
  // 基础工程词不标
  assert.equal(internals.isUsableTerm('路由', text), false)
  assert.equal(internals.isUsableTerm('加载', text), false)
  assert.equal(internals.isUsableTerm('ex.com/p90', text), false)
  assert.equal(internals.isUsableTerm('v1.2.3', text), false)
  // 真有疑点的词照样能过
  assert.equal(internals.isUsableTerm('零空帧', text + '零空帧'), true)
})

test('两字纯汉字词只有存疑档能标，术语档不放行', async () => {
  const { internals } = await loadPlugin()
  const text = '注资口径与灰产都要看。'
  // 两字汉字：疑似生造 / 含义不明放行
  assert.equal(internals.isUsableTerm('注资', text, 'unclear'), true)
  assert.equal(internals.isUsableTerm('灰产', text, 'fabricated'), true)
  // 术语档、缩写档、没给档位都不放行
  assert.equal(internals.isUsableTerm('注资', text, 'term'), false)
  assert.equal(internals.isUsableTerm('注资', text, 'abbrev'), false)
  assert.equal(internals.isUsableTerm('注资', text), false)
  // 三字及以上不受这条限制
  assert.equal(internals.isUsableTerm('零空帧', text + '零空帧', 'term'), true)
})

test('挑词口径只标有疑点：基础词、标准术语与任何语言都写进指令', async () => {
  const { internals } = await loadPlugin()
  const instructions = internals.modelInstructions()
  // 选词标准：只挑存疑的词
  assert.ok(instructions.includes('存疑'), '指令必须点名只标存疑的词')
  // 明确点名基础词与标准术语不标
  for (const token of ['浏览器', '下载', '标准术语']) {
    assert.ok(instructions.includes(token), `指令里缺少 ${token}`)
  }
  // 不再硬性要求把性能指标全标出来（那是旧口径，用户已否）
  assert.ok(!instructions.includes('见到就标'), '旧口径的性能词必标规则必须删掉')
  // 不限语言
  assert.ok(instructions.includes('哪种语言'), '指令必须说明不限语言')
  assert.ok(instructions.includes('日文'), '指令必须点名非中英文')
})


test('light tier sends candidate snippets only, balanced sends the reply body', async () => {
  const { internals } = await loadPlugin()
  const body = '甲'.repeat(9000)
  const light = internals.buildUserInput(body, 'light', ['慢特病'])
  assert.ok(light.includes('慢特病'))
  assert.ok(!light.includes('甲'.repeat(100)))

  // 中等与详细档覆盖完整回复，不再截断开头若干字
  const balanced = internals.buildUserInput(body, 'balanced', [])
  assert.ok(balanced.includes('甲'.repeat(100)))
  assert.ok(balanced.includes('甲'.repeat(9000)))

  const detailed = internals.buildUserInput(body, 'detailed', [])
  assert.ok(detailed.includes('甲'.repeat(9000)))
})

test('one reply costs exactly one llm call, and a repeat costs none', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(450)
  const oneshots = app.requests.filter(req => req.method === 'llm.oneshot')
  assert.equal(oneshots.length, 1)
  assert.equal(oneshots[0].params.task, 'title_generation')
  assert.ok(oneshots[0].params.input.includes('门诊慢特病'))

  app.fire('message.complete', { text: REPLY })
  await sleep(450)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 1)
})

test('light tier with no candidate spends nothing', async () => {
  const app = await loadPlugin({ replyText: '这是一段没有任何专有名词的普通中文回复，用来验证零调用路径。' })
  app.internals.TIERS.light
  const original = app.internals.TIERS.light.maxTerms
  assert.ok(original > 0)
  app.fire('message.complete', { text: '这是一段没有任何专有名词的普通中文回复，用来验证零调用路径。' })
  await sleep(450)
  // 宽松档也只对本地候选问模型；这段话没有候选，因此零调用
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 0)
})

test('terms get a highlight, suspected words get the wavy one', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const term = app.highlights.get('hg-term')
  const suspect = app.highlights.get('hg-suspect')
  assert.ok(term, 'term highlight missing')
  assert.ok(suspect, 'suspect highlight missing')
  assert.ok(term.ranges.length > 0)
  assert.ok(suspect.ranges.length > 0)
})

test('the popover icon fills the composer and never sends', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)

  const handlers = app.doc.handlers.mousemove || []
  assert.ok(handlers.length, 'mousemove listener not registered')
  handlers[0]({ clientX: 60, clientY: 20 })
  await sleep(50)

  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.ok(popover, 'popover element not created')
  const icon = app.created.find(el => el.className === 'hg-popover-icon')
  assert.ok(icon, 'icon button not created')
  const click = icon.handlers.click[0]
  click()
  await sleep(50)

  assert.equal(app.inserted.length, 1)
  assert.ok(app.inserted[0].text.includes('慢特病'))
  assert.equal(app.inserted[0].options.mode, 'block')
  assert.equal(app.submitted.length, 0, 'the plugin must never send by itself')
})

test('composer fill goes through insertText, never submit', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  await app.internals.fillComposer('慢特病怎么认定？', 'runtime-9')
  assert.equal(app.inserted.length, 1)
  assert.equal(app.inserted[0].sessionId, 'runtime-9')
  assert.equal(app.inserted[0].text, '慢特病怎么认定？')
  assert.equal(app.submitted.length, 0)
})

test('coerceQuestions normalizes strings, escaped arrays and objects', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const { coerceQuestions } = app.internals
  assert.deepEqual(coerceQuestions(['a', ' b ']), ['a', 'b'])
  assert.deepEqual(coerceQuestions('问题一？\n问题二？'), ['问题一？', '问题二？'])
  assert.deepEqual(coerceQuestions('["x","y"]'), ['x', 'y'])
  assert.deepEqual(coerceQuestions([{ text: 'z' }]), ['z'])
  assert.deepEqual(coerceQuestions(''), [])
  assert.deepEqual(coerceQuestions(undefined), [])
})

test('parseModelJson survives a broken payload and salvages the terms', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const { parseModelJson } = app.internals
  // 模型把 questions 写成字符串数组的转义字符串
  const escaped = JSON.stringify({
    terms: [{ term: '普通门诊', kind: 'term', explain: '常规门诊', note: '', questions: '["普通门诊有起付线吗？","异地怎么算？"]' }]
  })
  const parsed = parseModelJson(escaped)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].term, '普通门诊')
  assert.deepEqual(parsed[0].questions, ['普通门诊有起付线吗？', '异地怎么算？'])

  // 整体 JSON 坏掉：引号没闭合
  const broken = '{"terms":[{"term":"门诊慢特病","kind":"term","explain":"慢特病备案","note":"按当地口径","questions":["怎么认定？"]},{"term":"量子纠缠退税","kind":"fabricated","explain":"疑似生造","note":"","questions":["有出处吗？"]}]}'
  const salvaged = parseModelJson(broken.replace('"门诊慢特病","kind"', '"门诊慢特病","kind"'))
  assert.ok(Array.isArray(salvaged))
})

test('parseModelJson accepts a bare array of terms', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const parsed = app.internals.parseModelJson('[{"term":"社区医院","kind":"term","questions":["能办备案吗？"]}]')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].term, '社区医院')
  assert.deepEqual(parsed[0].questions, ['能办备案吗？'])
})

test('isUsableTerm 只放原文里真出现、且不像代码片段的词', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const ok = app.internals.isUsableTerm
  assert.equal(ok('门诊慢特病', REPLY), true)
  assert.equal(ok('量子纠缠退税', REPLY), true)
  assert.equal(ok('医院比例', REPLY), true)
  // 原文里没有
  assert.equal(ok('起付线', REPLY), false)
  // 路径、代码、文件名
  assert.equal(ok('scripts/build.py', 'scripts/build.py'), false)
  assert.equal(ok('user-input.md', 'user-input.md'), false)
  assert.equal(ok('foo_bar', 'foo_bar'), false)
  // 括号残片
  assert.equal(ok('普通门诊（', REPLY), false)
  // 太短
  assert.equal(ok('门', REPLY), false)
})

test('DOM 兜底：页面上出现新的助手回复就分析一次，且与网关事件不重复', async () => {
  const app = await loadPlugin({ replyText: '' })
  const reply = '门诊慢特病按病种报销，异地就医需要先备案，量子纠缠退税这类说法没有依据，建议向医保经办机构确认。'
  app.mdEl.textContent = reply
  // 第一次看到：文字刚出现，还在流式输出中，不该发请求
  app.internals.detectNewReplies()
  await sleep(300)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 0)

  // 文字不再变化、安静够久之后才分析
  await sleep(1300)
  app.internals.detectNewReplies()
  await sleep(700)
  const oneshots = app.requests.filter(req => req.method === 'llm.oneshot')
  assert.equal(oneshots.length, 1)

  // 再来一次同样的回复：不重复花钱
  app.internals.detectNewReplies()
  await sleep(300)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 1)

  // 网关事件补一次同一条回复：也不重复花钱
  app.fire('message.complete', { text: reply })
  await sleep(400)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 1)
})

test('疑似生造的词交给浏览器原生高亮画波浪线，插件不再自绘', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)

  // 波浪线由 ::highlight(hg-suspect) 画：浏览器自己定位，永远贴着文字
  const suspect = app.highlights.get('hg-suspect')
  assert.ok(suspect, 'suspect highlight not registered')
  assert.ok(suspect.ranges.length > 0, 'no range registered for the suspected word')
  const style = app.doc.getElementById('hermes-mark-words-style')
  assert.ok(style, 'style element missing')
  assert.ok(/hg-suspect[^}]*wavy/.test(style.textContent), 'wave style missing')
  // 插件不再自绘波浪线：覆盖层里没有自绘节点
  const layer = app.doc.body.children.find(el => el.id === 'hermes-mark-words-hl')
  assert.equal(layer ? layer.children.length : 0, 0, '插件不该自绘波浪线')
})

test('标记颜色只来自 app 主题变量，插件不写死颜色', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const style = app.doc.getElementById('hermes-mark-words-style')
  assert.ok(style, 'style element missing')
  const css = style.textContent
  // 点线跟正文色，波浪线用 app 的 destructive 语义色，深浅色由 app 自己切
  assert.match(css, /::highlight\(hg-term\)[^}]*var\(--ui-text-primary\)/)
  assert.match(css, /::highlight\(hg-suspect\)[^}]*var\(--dt-destructive\)/)
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, '样式里不许写死十六进制颜色')
  assert.equal(/rgba?\(/.test(css), false, '样式里不许写死 rgb 颜色')
  // 颜色不再由插件写到根节点上
  const root = app.doc.documentElement.style
  assert.equal(root.getPropertyValue('--hg-term-line'), '')
  assert.equal(root.getPropertyValue('--hg-wave'), '')
  app.dispose()
})

test('popover 在显示状态下量尺寸，位置不会盖住术语本身', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)

  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 100, clientY: 110 })
  await sleep(50)

  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.ok(popover, 'popover element not created')
  // 量尺寸时必须是可见状态：隐藏时量到高度 0，弹窗会直接压在术语上
  assert.equal(popover.style.visibility, 'visible')
  const top = Number.parseInt(popover.style.top, 10)
  // 弹窗落在术语下方，不与术语重叠
  assert.ok(top >= rangeRect.bottom, `popover overlaps the term: top=${top}`)
})

test('插件自己写的样式层不会触发观察器自激（页面不抖）', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const style = app.created.find(el => el.id === 'hermes-mark-words-style')
  assert.ok(style, 'style element not created')
  assert.equal(app.internals.isOwnNode(style), true, 'style element must be recognized as plugin-owned')
  assert.equal(app.internals.isOwnNode(app.assistantEl), false, 'assistant message is not plugin-owned')
})

test('同一条回复重复分析时不会重画（高亮不闪）', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)

  const before = app.highlights.get('hg-term')
  assert.ok(before, 'term highlight not registered')
  const beforeRanges = before.ranges.slice()
  assert.ok(beforeRanges.length > 0, 'no ranges registered')

  // 同样的内容再来一次：登记的范围应该被复用，而不是重建
  app.internals.reapplyAll()
  const after = app.highlights.get('hg-term')
  assert.equal(after.ranges.length, beforeRanges.length)
  assert.equal(after.ranges[0], beforeRanges[0], 'range should be reused, not recreated')
})

test('字形位置变了但字没变时不重登记高亮（防闪）', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)

  const before = app.highlights.get('hg-suspect')
  assert.ok(before && before.ranges.length > 0, 'suspect range not registered')

  // 模拟文字被挤动：字形矩形挪了位置，但文本节点与偏移都没变
  app.rectState.rect = { top: 40, left: 300, right: 420, bottom: 60, width: 120, height: 20 }
  app.internals.applyAnalysis(app.assistantEl, {
    terms: [{ term: '量子纠缠退税', kind: 'fabricated', explain: 'x', note: '', questions: ['?'] }],
    replyText: REPLY,
    sessionId: null,
    tier: 'balanced'
  })
  const moved = app.highlights.get('hg-suspect')
  assert.ok(moved && moved.ranges.length > 0, 'suspect range missing after re-apply')
  // 同一批文本位置就沿用原来登记的高亮：重建 Highlight 会触发整段重绘，也就是肉眼看到的闪
  assert.equal(moved, before, 'unchanged text positions must reuse the registered highlight')
})

test('文本节点被 React 原地改写后，指向别处的 Range 会被拒绝', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  assert.equal(app.internals.rangeMatchesText(
    { startContainer: { nodeType: 3, nodeValue: '前缀门诊慢特病后缀' }, startOffset: 2, endContainer: { nodeType: 3, nodeValue: '前缀门诊慢特病后缀' }, endOffset: 7 },
    '门诊慢特病'
  ), true)
  assert.equal(app.internals.rangeMatchesText(
    { startContainer: { nodeType: 3, nodeValue: '内容已经完全变成别的文字了' }, startOffset: 2, endContainer: { nodeType: 3, nodeValue: '内容已经完全变成别的文字了' }, endOffset: 7 },
    '门诊慢特病'
  ), false)
  const detached = { nodeType: 3, nodeValue: '门诊慢特病', isConnected: false }
  assert.equal(app.internals.rangeMatchesText(
    { startContainer: detached, startOffset: 0, endContainer: detached, endOffset: 5 },
    '门诊慢特病'
  ), false)
  // React 换掉旧文本节点后，Chrome 把 Range 边界收缩到父元素上：
  // 边界不再是文本节点，这种 Range 画不出任何东西，必须判为失效，
  // 否则高亮永远不重建，标记就凭空消失了。
  const elementBound = { nodeType: 1, isConnected: true }
  assert.equal(app.internals.rangeMatchesText(
    { startContainer: elementBound, startOffset: 0, endContainer: elementBound, endOffset: 0 },
    '门诊慢特病'
  ), false)
})

test('React 原地改写文本节点后，高亮重新指向正确的词', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  assert.ok(app.highlights.get('hg-term'), 'highlight registered')
  // 模拟 React 原地改写：文本变了，签名也变了，旧 Range 会漂
  app.mdEl.textContent = REPLY.replace('门诊慢特病按病种', '门诊慢特病按病种报销')
  app.internals.reapplyAll()
  await sleep(50)
  const hl = app.highlights.get('hg-term')
  assert.ok(hl && hl.ranges.length > 0, 'highlight must survive re-render')
})

test('React 换掉文本节点后，观察器回调当场就把标记接回去（不留空白帧）', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const before = app.highlights.get('hg-term')
  assert.ok(before && before.ranges.length > 0, 'highlight registered')
  const oldNode = before.ranges[0].startContainer
  // React 重渲染：旧文本节点脱离文档，新节点接替
  const newNode = app.textState.swap()
  assert.equal(oldNode.isConnected, false, '旧节点已脱离文档')
  // 观察器回调：模拟浏览器把 DOM 变动交给插件
  const observer = globalThis.__observers[globalThis.__observers.length - 1]
  observer.callback([{ target: app.mdEl, addedNodes: [], removedNodes: [] }])
  // 不等任何定时器：回调返回时标记必须已经指向新节点
  const after = app.highlights.get('hg-term')
  assert.ok(after && after.ranges.length > 0, '重渲染后标记仍然登记')
  assert.equal(after.ranges[0].startContainer, newNode, '标记当场重锚到新文本节点')
})

test('回复里词消失后，旧标记会被撤掉，不会留在原地', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  assert.ok(app.highlights.get('hg-term').ranges.length > 0)
  // 整段换成不含术语的内容
  app.mdEl.textContent = '这段话里什么术语都没有了，全部是普通中文说明。'
  app.internals.reapplyAll()
  await sleep(50)
  const hl = app.highlights.get('hg-term')
  assert.equal(hl.ranges.length, 0, 'stale marks must be removed')
})

test('定位回复时优先用尾部锚点，不会标到别的消息上', async () => {
  const app = await loadPlugin({ replyText: '这是一条别的回复，内容完全不一样。' })
  // 造第二条含相同词的消息：词一样，但尾部不同
  const second = app.doc.createElement('div')
  second.className = 'aui-md'
  second.textContent = '门诊慢特病按病种，多数 70%。量子纠缠退税需要先自付 20%，剩下的 80% 再乘医院比例。'
  app.assistantEl.appendChild(second)
  // second 自身是 assistant 容器，里面就是正文（querySelector('.aui-md') 返回自身）
  second.querySelector = sel => (sel === '.aui-md' ? second : null)
  second.querySelectorAll = sel => (sel === '.aui-md' ? [second] : [])
  app.doc.querySelectorAll = sel => (sel === '[data-role="assistant"]' ? [app.assistantEl, second] : [])

  const element = app.internals.locateAssistantElement(
    '门诊慢特病按病种，多数 70%。量子纠缠退税需要先自付 20%，剩下的 80% 再乘医院比例。',
    [{ term: '门诊慢特病' }]
  )
  assert.ok(element, 'should locate an element')
  assert.equal(element, second, 'should pick the reply whose tail matches')
})

test('原生高亮可用时，黄色底交给浏览器，不用插件自己贴块', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  assert.equal(app.internals.supportsNativeHighlight(), true)
  const hlLayer = app.created.find(el => el.id === 'hermes-mark-words-hl')
  if (hlLayer) assert.equal(hlLayer.children.length, 0, 'no fallback boxes when native highlight works')
  assert.ok(app.highlights.get('hg-term'), 'native term highlight should be registered')
})

test('思考块不标：markdownRoot 只认正文，跳过 data-conversation-scaffold 里的 .aui-md', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const think = app.doc.createElement('div')
  think.className = 'aui-md'
  think.textContent = REPLY
  const scaffold = app.doc.createElement('div')
  scaffold.setAttribute('data-conversation-scaffold', '')
  scaffold.appendChild(think)
  const assistantEl = app.doc.createElement('div')
  assistantEl.appendChild(scaffold)
  assistantEl.querySelectorAll = sel => (sel === '.aui-md' ? [think] : [])
  // 正文容器在 scaffold 里：沿 parentElement 上迟能碰到标记，返回 null
  think.parentElement = scaffold
  scaffold.parentElement = assistantEl
  assert.equal(app.internals.markdownRoot(assistantEl), null, 'thinking block must not be marked')
})

test('忽略功能：点忽略后词立刻撤掉，解除后恢复', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  assert.ok(app.highlights.get('hg-term'), 'marked before ignore')

  app.internals.ignoreTerm('门诊慢特病')
  await sleep(100)
  const hl = app.highlights.get('hg-term')
  const terms = hl ? hl.ranges.length : 0
  assert.equal(app.internals.isIgnored('门诊慢特病'), true)
  assert.equal(terms, 0, 'marks removed right after ignore')

  app.internals.unignoreTerm('门诊慢特病')
  await sleep(900)
  assert.equal(app.internals.isIgnored('门诊慢特病'), false)
})

test('文件路径不再被解释', async () => {
  const app = await loadPlugin()
  assert.equal(app.internals.isUsableTerm('user-input.md', 'see user-input.md here'), false)
  assert.equal(app.internals.isUsableTerm('foo/bar.ts', 'open foo/bar.ts now'), false)
  assert.equal(app.internals.isUsableTerm('NODE_ENV', 'set NODE_ENV first'), false)
})

test('鼠标移进 popover 后不再被 mousemove 关掉', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 100, clientY: 110 })
  await sleep(50)
  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.ok(popover, 'popover missing')
  // 模拟指针进入 popover
  popover.handlers.mouseenter[0]()
  // 指针移到空白处：popover 必须保持
  handlers[0]({ clientX: 5, clientY: 5 })
  await sleep(50)
  assert.equal(popover.style.display, 'block', 'popover must stay while pointer is inside')
  // 离开后正常隐藏
  popover.handlers.mouseleave[0]()
  await sleep(300)
  assert.equal(popover.style.display, 'none')
})

test('鼠标持续移动时 popover 也在固定时间内消失，不被推迟', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 100, clientY: 110 })
  await sleep(60)
  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.equal(popover.style.display, 'block', 'popover should be visible')
  // 鼠标移出去之后还在持续移动：隐藏时间不能被一次次推后
  for (let i = 0; i < 12; i++) {
    handlers[0]({ clientX: 5, clientY: 5 })
    await sleep(30)
  }
  assert.equal(popover.style.display, 'none', 'popover must hide on the fixed deadline')
})

test('鼠标移出窗口时 popover 直接收掉，不留在屏幕上', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 100, clientY: 110 })
  await sleep(60)
  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.equal(popover.style.display, 'block', 'popover should be visible')
  const leave = app.doc.handlers.mouseleave || []
  assert.ok(leave.length, 'mouseleave handler missing')
  leave[0]()
  assert.equal(popover.style.display, 'none', 'popover must hide when the pointer leaves the window')
})

test('被中断或出错的回复不标注', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY, status: 'interrupted' })
  await sleep(700)
  assert.equal(app.requests.filter(r => r.method === 'llm.oneshot').length, 0, 'interrupted reply must not cost tokens')
  app.fire('message.complete', { text: REPLY, error: 'boom' })
  await sleep(700)
  assert.equal(app.requests.filter(r => r.method === 'llm.oneshot').length, 0, 'failed reply must not cost tokens')
})

test('滚动后命中坐标必须重算：不能命中滚动前的旧位置', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  // 词在屏幕上挪了位置（滚动导致）
  app.rectState.rect = { top: 500, left: 300, right: 420, bottom: 520, width: 120, height: 20 }
  // 滚动事件：捕获阶段的监听要让命中坐标失效
  const scrollHandlers = app.doc.handlers.scroll || []
  assert.ok(scrollHandlers.length > 0, 'scroll listener missing')
  for (const fn of scrollHandlers) fn({ target: app.doc.body })
  // 旧坐标（10,10）不该再命中
  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 15, clientY: 20, target: app.doc.body })
  await sleep(60)
  const opened = () => {
    const el = app.created.find(e => e.className === 'hg-popover')
    return !!(el && el.style.display === 'block')
  }
  assert.equal(opened(), false, 'stale rect must not open a popover')
  // 新坐标能正常命中
  handlers[0]({ clientX: 310, clientY: 510, target: app.doc.body })
  await sleep(60)
  assert.equal(opened(), true, 'new position must open the popover')
})

test('popover 出现在鼠标下方时不会被自己的 mousemove 关掉', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const handlers = app.doc.handlers.mousemove || []
  handlers[0]({ clientX: 100, clientY: 110, target: app.doc.body })
  await sleep(60)
  const popover = app.created.find(el => el.className === 'hg-popover')
  assert.ok(popover && popover.style.display === 'block', 'popover should be visible')
  // 鼠标落在弹窗自身上（事件目标是弹窗内部元素）→ 弹窗必须留着
  const inner = popover.children[0]
  handlers[0]({ clientX: 60, clientY: 60, target: inner })
  await sleep(300)
  assert.equal(popover.style.display, 'block', 'popover must survive when the pointer is on it')
})

const analysisFor = (text = REPLY) => ({
  replyText: text, sessionId: 'runtime-1', tier: 'balanced',
  terms: [
    { term: '门诊慢特病', kind: 'term', explain: '慢性病及特殊病', questions: [] },
    { term: '量子纠缠退税', kind: 'unclear', explain: '含义不明', questions: [] }
  ]
})
const popIsOpen = app => app.created.some(el => el.className === 'hg-popover' && el.style.display === 'block')

function treeNodes(node) {
  if (node == null || typeof node !== 'object') return []
  const children = node.props && node.props.children
  return [node, ...(Array.isArray(children) ? children : [children]).flatMap(treeNodes)]
}

test('高光外一像素不弹解释', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  app.doc.handlers.mousemove[0]({ clientX: 9, clientY: 20 })
  assert.equal(popIsOpen(app), false)
  app.doc.handlers.mousemove[0]({ clientX: 11, clientY: 20 })
  assert.equal(popIsOpen(app), true)
})

test('跨行高光只命中实际文字，不命中包围框中的空白', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const original = app.doc.createRange
  app.doc.createRange = () => {
    const range = original()
    range.getBoundingClientRect = () => ({ left: 10, right: 200, top: 10, bottom: 70, width: 190, height: 60 })
    range.getClientRects = () => [
      { left: 120, right: 200, top: 10, bottom: 30, width: 80, height: 20 },
      { left: 10, right: 60, top: 50, bottom: 70, width: 50, height: 20 }
    ]
    return range
  }
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  const move = app.doc.handlers.mousemove[0]
  move({ clientX: 100, clientY: 40 })
  assert.equal(popIsOpen(app), false)
  move({ clientX: 100, clientY: 60 })
  assert.equal(popIsOpen(app), false)
  move({ clientX: 20, clientY: 60 })
  assert.equal(popIsOpen(app), true)
})

test('高光被其他页面元素挡住时不弹解释', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.doc.elementFromPoint = () => app.doc.body
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  app.doc.handlers.mousemove[0]({ clientX: 50, clientY: 20 })
  assert.equal(popIsOpen(app), false)
})

test('离开又回到高光会取消隐藏，不随机消失', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  const move = app.doc.handlers.mousemove[0]
  move({ clientX: 50, clientY: 20 })
  move({ clientX: 5, clientY: 5 })
  await sleep(60)
  move({ clientX: 50, clientY: 20 })
  await sleep(200)
  assert.equal(popIsOpen(app), true)
})

test('永久忽略在重渲染、会话切换和重新装载后仍有效，设置可恢复', async () => {
  const stored = new Map()
  const app = await loadPlugin({ locale: 'zh', replyText: REPLY, stored })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  app.doc.handlers.mousemove[0]({ clientX: 50, clientY: 20 })
  const ignore = app.created.find(el => el.className === 'hg-popover-ignore')
  ignore.handlers.click[0]()
  assert.equal(app.internals.isIgnored('门诊慢特病'), true)
  assert.deepEqual(stored.get('ignoredTerms'), ['门诊慢特病'])
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  await sleep(350)
  assert.equal(app.highlights.get('hg-term').ranges.length, 0, 're-render must not revive ignored word')
  app.fire('sessions.changed', {})
  app.dispose()
  const next = await loadPlugin({ locale: 'zh', replyText: REPLY, stored })
  next.internals.applyAnalysis(next.assistantEl, analysisFor())
  await sleep(350)
  assert.equal(next.highlights.get('hg-term').ranges.length, 0)
  const nodes = treeNodes(next.settingsPages[0].render())
  const restore = nodes.find(node => node.props && typeof node.props.onClick === 'function' && String(node.props.children).includes('门诊慢特病'))
  assert.ok(restore, 'settings must show the ignored word and a restore action')
  restore.props.onClick()
  await sleep(350)
  assert.equal(next.internals.isIgnored('门诊慢特病'), false)
  assert.equal(next.requests.length, 0, 'restore must not call the model')
})

test('历史插件 ID 的忽略词和设置搬进新 ID，旧键被清掉', async () => {
  const stored = new Map()
  const legacy = new Map([
    ['hermes.plugin.hermes-term-helper.ignoredTerms', JSON.stringify(['旧词'])],
    ['hermes.plugin.hermes-term-helper.settings', JSON.stringify({ tier: 'detailed' })],
    ['hermes.plugin.hermes-glossary.ignoredTerms', JSON.stringify(['更旧的词'])]
  ])
  const app = await loadPlugin({ stored, legacy })
  assert.deepEqual(stored.get('ignoredTerms'), ['旧词'])
  assert.equal(stored.get('settings').tier, 'detailed')
  assert.equal(legacy.size, 0, 'legacy keys must be removed after migration')
  assert.equal(app.internals.isIgnored('旧词'), true)
})

test('忽略超过200个词不会悄悄恢复最早忽略的词', async () => {
  const app = await loadPlugin()
  for (let i = 0; i < 201; i++) app.internals.ignoreTerm('ignored' + i)
  assert.equal(app.internals.isIgnored('ignored0'), true)
})

test('代码块里的词不标注', async () => {
  const app = await loadPlugin({ replyText: '门诊慢特病' })
  const code = app.doc.createElement('code')
  code.textContent = '门诊慢特病'
  app.mdEl.appendChild(code)
  app.doc.createTreeWalker = () => {
    let done = false
    return { nextNode() { if (done) return null; done = true; return { nodeValue: code.textContent, parentElement: code } } }
  }
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  await sleep(400)
  assert.equal(app.highlights.get('hg-term').ranges.length, 0, 'code words must not be marked')
})

test('两条回复都含同一个词时宁可不标，也不标错消息', async () => {
  const app = await loadPlugin({ replyText: '第一条回复提到门诊慢特病。' })
  const second = app.doc.createElement('div')
  second.className = 'aui-md'
  second.textContent = '另一条回复也提到门诊慢特病。'
  app.assistantEl.appendChild(second)
  second.querySelector = sel => (sel === '.aui-md' ? second : null)
  second.querySelectorAll = sel => (sel === '.aui-md' ? [second] : [])
  app.doc.querySelectorAll = sel => (sel === '[data-role="assistant"]' ? [app.assistantEl, second] : [])
  // 尾部锚点对不上，且两条并列命中：不能猜
  const element = app.internals.locateAssistantElement('门诊慢特病完全不同的尾巴', [{ term: '门诊慢特病' }])
  assert.equal(element, null, 'ambiguous replies must not be marked')
})

test('光标落在词外的字符上时不弹解释', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  // 浏览器把坐标换算成文本偏移：偏移不在词内就是没指着这个词
  app.doc.caretPositionFromPoint = () => ({ offsetNode: app.highlights.get('hg-term-f0').ranges[0].startContainer, offset: REPLY.length })
  app.doc.handlers.mousemove[0]({ clientX: 50, clientY: 20 })
  assert.equal(popIsOpen(app), false)
})

test('两次分析词表不同也不会把先标上的词整批抹掉', async () => {
  const app = await loadPlugin({ replyText: '门诊慢特病和量子纠缠退税都需要核实。' })
  app.internals.applyAnalysis(app.assistantEl, { terms: [{ term: '门诊慢特病', kind: 'term', explain: 'a', questions: [] }], replyText: REPLY, sessionId: 's' })
  await sleep(350)
  assert.equal(app.highlights.get('hg-term').ranges.length, 1)
  // 另一条路径再次分析同一段，词表里没有这个词：不能整段覆盖
  app.internals.applyAnalysis(app.assistantEl, { terms: [{ term: '量子纠缠退税', kind: 'fabricated', explain: 'b', questions: [] }], replyText: REPLY, sessionId: 's' })
  await sleep(350)
  assert.equal(app.highlights.get('hg-term').ranges.length, 1, 'earlier term must survive a later analysis')
  assert.equal(app.highlights.get('hg-suspect').ranges.length, 1, 'new term must be marked too')
})

test('淡入期间卸载不会被旧定时器重新画出标记', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  app.dispose()
  await sleep(350)
  assert.equal(app.highlights.size, 0)
})

test('同批10个词全部淡入，结束后稳定且不重启淡入', async () => {
  const words = Array.from({ length: 10 }, (_, i) => '术语候选' + i)
  const text = words.join('、')
  const app = await loadPlugin({ replyText: text })
  const analysis = { terms: words.map(term => ({ term, kind: 'term', explain: '解释', questions: [] })), replyText: text, sessionId: 'runtime-1' }
  app.internals.applyAnalysis(app.assistantEl, analysis)
  assert.equal(app.highlights.get('hg-term').ranges.length, 0, 'all new terms should enter fading groups')
  const countFading = () => [...app.highlights].filter(([key]) => /^hg-term-f/.test(key)).reduce((sum, [, h]) => sum + h.ranges.length, 0)
  assert.equal(countFading(), 10)
  await sleep(100)
  const coefficients = [0, 1, 2, 3].map(i => Number(app.doc.documentElement.style.getPropertyValue('--hg-fade-' + i)))
  assert.ok(coefficients.some(value => value > 0 && value < 1))
  await sleep(250)
  assert.equal(app.highlights.get('hg-term').ranges.length, 10)
  app.internals.applyAnalysis(app.assistantEl, analysis)
  assert.equal(countFading(), 0)
  app.dispose()
})

test('词边界：exp90 里的 p90 不标，独立的 P90 要标', async () => {
  const app = await loadPlugin({ replyText: 'exp90 之后 P90' })
  app.internals.applyAnalysis(app.assistantEl, {
    replyText: 'exp90 之后 P90', sessionId: 'runtime-1', tier: 'balanced',
    terms: [{ term: 'p90', kind: 'term', explain: '九十分位', questions: [] }]
  })
  await sleep(500)
  const ranges = (app.highlights.get('hg-term') || { ranges: [] }).ranges
  assert.equal(ranges.length, 1, 'exp90 里的 p90 不是术语，不该标')
  assert.equal(ranges[0].startOffset, 9, '应该只标独立的 P90（大小写不敏感）')
  app.dispose()
})

test('改判类型后怀疑标记能跟上，不会被当成重复丢掉', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const term = { term: '量子纠缠退税', explain: 'x', questions: [] }
  app.internals.applyAnalysis(app.assistantEl, {
    replyText: REPLY, sessionId: 'runtime-1', tier: 'balanced',
    terms: [{ ...term, kind: 'term' }]
  })
  await sleep(500)
  assert.equal((app.highlights.get('hg-term') || { ranges: [] }).ranges.length, 1)
  app.internals.applyAnalysis(app.assistantEl, {
    replyText: REPLY, sessionId: 'runtime-1', tier: 'balanced',
    terms: [{ ...term, kind: 'fabricated' }]
  })
  await sleep(500)
  assert.equal((app.highlights.get('hg-suspect') || { ranges: [] }).ranges.length, 1, '改判生造后要换红波浪线')
  assert.equal((app.highlights.get('hg-term') || { ranges: [] }).ranges.length, 0, '黄底不该还留着')
  app.dispose()
})

test('重渲染瞬态找不到 Range 时不撤整条消息的旧标记', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  await sleep(500)
  assert.equal(app.highlights.get('hg-term').ranges.length, 1)
  // React 换掉文本节点：新文字里有词，但这一瞬间 Range 全都建不出来
  app.mdEl.textContent = '门诊慢特病还在，指标是 exp90。'
  app.textState.swap()
  app.doc.createRange = () => ({
    setStart() { throw new Error('node swapped') },
    setEnd() { throw new Error('node swapped') },
    getBoundingClientRect() { return app.rectState.rect },
    getClientRects() { return [app.rectState.rect] }
  })
  app.internals.applyAnalysis(app.assistantEl, {
    replyText: '门诊慢特病还在，指标是 exp90。', sessionId: 'runtime-1', tier: 'balanced',
    terms: [{ term: 'p90', kind: 'term', explain: 'x', questions: [] }]
  })
  await sleep(200)
  assert.equal((app.highlights.get('hg-term') || { ranges: [] }).ranges.length, 1, '瞬态找不到 Range 不能整条抹掉旧标记')
  app.dispose()
})

test('markdown 尾部也能对上渲染文本（网关事件定位得到同一条）', async () => {
  const app = await loadPlugin({ replyText: '结论：最终以当地口径为准。' })
  const element = app.internals.locateAssistantElement('\n\n**最终以当地口径为准。**', [])
  assert.equal(element, app.assistantEl, '原始 markdown 应该能定位到渲染文本那条回复')
  app.dispose()
})

// ─── 单请求标记（回复自带 ::hmw 标记关系）──────────────────────────────

const INBAND_RAW = REPLY + '\n\n::hmw{term="门诊慢特病", kind="term", explain="门诊慢性病与特殊病", note="按当地口径", q1="怎么认定？"}\n::hmw{term=\'量子纠缠退税\', kind=\'fabricated\', explain=\'疑似生造或含义不明\', note=\'未见政策口径\', q1=\'有出处吗？\'}'

test('标记关系能从 ::hmw 指令行解析出来，文本掩码不漂移', async () => {
  const { internals } = await loadPlugin()
  const entries = internals.parseMarkDirectives(INBAND_RAW)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].term, '门诊慢特病')
  assert.equal(entries[0].kind, 'term')
  assert.deepEqual(entries[0].questions, ['怎么认定？'])
  assert.equal(entries[1].term, '量子纠缠退税')
  assert.equal(entries[1].kind, 'fabricated')
  assert.deepEqual(entries[1].questions, ['有出处吗？'])
  // 单引号、双引号混写都要认；attrs 里没花括号的行才算
  assert.equal(internals.parseMarkDirectives('普通回复，没有标记块。').length, 0)
  const masked = internals.maskMarkDirectives(INBAND_RAW)
  assert.equal(masked.length, INBAND_RAW.length, '掩码必须等长占位，偏移不能漂')
  assert.ok(!masked.includes('::hmw'), '指令行要被抹掉')
  assert.ok(internals.stripMarkDirectives(INBAND_RAW).startsWith(REPLY.slice(0, 6)))
})

test('回复自带标记关系时零模型调用，且 ::hmw 被插件认领成空组件', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  assert.ok(
    app.registered.some(item => item.area === 'transcript.directives' && item.data && item.data.name === 'hmw'),
    '插件必须认领 ::hmw 指令，标记关系才不进正文显示'
  )
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(750)
  assert.equal(
    app.requests.filter(item => item.method === 'llm.oneshot').length, 0,
    '回复自带标记关系时不发第二次模型请求'
  )
  const ranges = [...app.highlights.values()].flatMap(item => item.ranges)
  assert.ok(ranges.length >= 2, `两个词都要标上，实际 ${ranges.length}`)
  // 词表里的解释与追问跟着标记表走，重载后还能用
  const remembered = app.internals.storedMarksFor(INBAND_RAW)
  assert.ok(remembered && remembered.some(item => item.term === '门诊慢特病' && item.explain), '解释要进标记表')
  app.dispose()
})

test('重渲染时某个词建不出 Range 也不丢：补锚后必须回来', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(750)
  const count = () => [...app.highlights.values()].reduce((n, item) => n + item.ranges.length, 0)
  assert.ok(count() >= 2, '重渲染前两个词都标着')

  // React 换文本节点：旧 Range 全失效，且这一轮恰好有一个词建不出新 Range
  app.textState.swap()
  const original = app.doc.createRange
  let failures = 1
  app.doc.createRange = () => {
    if (failures > 0) {
      failures -= 1
      return { setStart() { throw new Error('node replaced mid-build') }, setEnd() {} }
    }
    return original()
  }
  const observer = [...globalThis.__observers].reverse().find(item => item.observed.some(record => record.target === app.doc.documentElement))
  observer.callback([{ target: app.mdEl, addedNodes: [] }])
  app.doc.createRange = original

  await sleep(500)
  assert.ok(count() >= 2, `瞬态建不出 Range 的词必须在补锚后回来，实际只剩 ${count()} 个范围`)
  app.dispose()
})

// ─── 任意语言 / 即时标注 / 持久标记 / 切换会话 ─────────────────────────────

test('术语闸门不限语言：假名、谚文、西里尔都能过，基础词与代码进不来', async () => {
  const app = await loadPlugin()
  const ok = app.internals.isUsableTerm
  assert.equal(ok('コンテキスト', 'このコンテキストでは意味が違う'), true)
  assert.equal(ok('청약', '청약 신청은 어렵다'), true)
  assert.equal(ok('ипотека', 'ипотека под 6% — это спорно'), true)
  // 基础词、标准术语在常见词表里，不进标记
  assert.equal(ok('浏览器', '用浏览器打开页面'), false)
  assert.equal(ok('browser', 'open it in the browser'), false)
  assert.equal(ok('API', 'the API returns JSON'), false)
  // 代码、路径、版本号依旧过不去
  assert.equal(ok('foo_bar', 'foo_bar'), false)
  assert.equal(ok('user-input.md', 'user-input.md'), false)
  assert.equal(ok('v1.2.3', 'v1.2.3'), false)
  app.dispose()
})

test('带标记块的回复当场标注，不等防抖', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(30)
  const ranges = [...app.highlights.values()].flatMap(item => item.ranges)
  assert.ok(ranges.length >= 2, `30ms 内就要标上，实际 ${ranges.length}`)
  app.dispose()
})

test('标记表按正文记住标记，重载后旧回复立刻重挂且不花钱', async () => {
  const stored = new Map()
  const app = await loadPlugin({ replyText: REPLY, stored })
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(400)
  assert.ok(stored.get('marks'), '标记表必须落盘')
  app.dispose()

  const next = await loadPlugin({ replyText: REPLY, stored })
  // 标记表本身要能按正文直接查回（不靠解释缓存的精确命中）
  assert.equal(next.internals.storedMarksFor(REPLY).length, 2, '标记表必须能按正文查回两个词')
  next.internals.remountAllMarks()
  const ranges = [...next.highlights.values()].flatMap(item => item.ranges)
  assert.ok(ranges.length >= 2, `旧回复的标记必须回来，实际 ${ranges.length}`)
  assert.equal(next.requests.filter(item => item.method === 'llm.oneshot').length, 0, '重挂不能花 token')
  next.dispose()
})

test('切换会话不清空已有标记，不产生空窗', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(400)
  const count = () => [...app.highlights.values()].reduce((sum, item) => sum + item.ranges.length, 0)
  assert.ok(count() >= 2, '先标上')
  app.fire('sessions.changed', {})
  assert.ok(count() >= 2, '会话切换事件返回时标记必须还在')
  app.dispose()
})

test('popover 里的文本节点算插件自己的，不会触发观察器重画', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const pop = app.doc.createElement('div')
  pop.className = 'hg-popover'
  const text = app.doc.createElement('span')
  pop.appendChild(text)
  const inner = { nodeValue: '解释文本', parentElement: text }
  assert.equal(app.internals.isOwnNode(inner), true)
  assert.equal(app.internals.isOwnNode(text), true)
  assert.equal(app.internals.isOwnNode(app.assistantEl), false)
  app.dispose()
})

// ─── v0.17.0：兜底零开销 / 基础词清洗 / 标记状态图例 / 系统语言 ─────────────

test('DOM 兜底遇到带标记块的回复：零模型请求，当场标注', async () => {
  const app = await loadPlugin({ replyText: '' })
  // 页面正文自带标记块：网关事件就算没送到，兜底也不该花钱
  app.mdEl.textContent = INBAND_RAW
  app.internals.detectNewReplies()
  await sleep(1300)
  app.internals.detectNewReplies()
  await sleep(400)
  const ranges = [...app.highlights.values()].flatMap(item => item.ranges)
  assert.ok(ranges.length >= 2, `兜底也要当场标上，实际 ${ranges.length}`)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 0, '带标记块的回复一个模型请求都不发')
  // 网关事件晚到：既不花第二次钱，也不重复标注
  app.fire('message.complete', { text: INBAND_RAW })
  await sleep(400)
  assert.equal(app.requests.filter(req => req.method === 'llm.oneshot').length, 0)
  app.dispose()
})

test('装载时洗掉旧口径的基础词：标记表不再留', async () => {
  const stored = new Map()
  stored.set('marks', {
    entries: {
      sig1: { tail: '旧口径', at: 1, terms: [{ term: '路由', kind: 'term', explain: '旧口径误存的常规工程词', note: '', questions: [] }] },
      sig2: { tail: '零空帧', at: 2, terms: [{ term: '零空帧', kind: 'fabricated', explain: '疑似生造的说法，指没有空白帧', note: '', questions: [] }, { term: '加载', kind: 'term', explain: '旧口径误存的常规工程词', note: '', questions: [] }] }
    },
    order: ['sig1', 'sig2']
  })
  const app = await loadPlugin({ stored })
  const marks = stored.get('marks').entries
  assert.equal(marks.sig1, undefined, '整条都是基础词的标记记录要删掉')
  assert.deepEqual(marks.sig2.terms.map(item => item.term), ['零空帧'], '混合记录只留有疑点的词')
  app.dispose()
})

test('设置页把标记状态标清楚：点线与波浪线各一行，带样例', async () => {
  const app = await loadPlugin({ locale: 'zh' })
  const nodes = treeNodes(app.settingsPages[0].render())
  assert.ok(nodes.find(node => node.props && node.props.className === 'hg-sample-term'), '点线样例必须在设置页')
  assert.ok(nodes.find(node => node.props && node.props.className === 'hg-sample-suspect'), '波浪线样例必须在设置页')
  const text = nodes.map(node => String((node.props && node.props.children) || '')).join(' ')
  assert.ok(text.includes('中性点线'), '点线状态说明必须有')
  assert.ok(text.includes('细红波浪线'), '波浪线状态说明必须有')
  assert.ok(text.includes('疑似生造'), '状态说明要覆盖疑似生造')
  app.dispose()
})

test('旧宿主没有 i18n 时按系统语言挑中英文案', async () => {
  const app = await loadPlugin({ i18nEnabled: false, replyText: REPLY })
  // 没有系统语言信息时保持中文
  assert.ok(app.internals.modelInstructions().includes('Explanation language: 中文'))
  app.win.navigator = { language: 'zh-TW' }
  assert.ok(app.internals.modelInstructions().includes('Explanation language: 中文'))
  app.win.navigator = { language: 'en-US' }
  assert.ok(app.internals.modelInstructions().includes('Explanation language: English'))
  app.dispose()
})

// ─── 标记偏好已下线（v0.21.0）：解析与指令不再做主题归类 ────────────────

test('旧标记块里多余的主题属性被忽略，解析不受影响', async () => {
  const app = await loadPlugin()
  const entries = app.internals.parseMarkDirectives('正文。\n::hmw{term="熔断降级", kind="term", theme="tech", explain="微服务容错手段"}\n::hmw{term="门诊慢特病", kind="term", explain="医保认定"}')
  assert.deepEqual(entries.map(item => item.term), ['熔断降级', '门诊慢特病'])
  assert.equal(entries.some(item => 'theme' in item), false, '主题归类已下线，不再解析 theme')
  app.dispose()
})

test('辅助模型指令不再做主题归类', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  const instructions = app.internals.modelInstructions()
  assert.equal(instructions.includes('theme'), false, '指令里不再要求 theme 归类')
  assert.equal(instructions.includes('主题'), false, '不再有主题过滤口径')
  app.dispose()
})

// ─── v0.19.0：悬停解释跟上下文走，说不清不装懂 ────────────────────────────

test('悬停弹层不再放原段话，只留解释与追问', async () => {
  const app = await loadPlugin({ locale: 'zh', replyText: REPLY })
  app.internals.applyAnalysis(app.assistantEl, analysisFor())
  await sleep(350)
  app.doc.handlers.mousemove[0]({ clientX: 50, clientY: 20 })
  const quote = app.created.find(el => el.className === 'hg-popover-context')
  assert.equal(quote, undefined, '弹层不再带上下文原句')
  const explain = app.created.find(el => el.className === 'hg-popover-explain')
  assert.ok(explain, '解释行必须在')
  app.dispose()
})

test('解释说不清时不装懂：空白或一句带过就显示诚实提示', async () => {
  const app = await loadPlugin({ locale: 'zh', replyText: REPLY })
  const analysis = analysisFor()
  analysis.terms[0].explain = '意思'
  app.internals.applyAnalysis(app.assistantEl, analysis)
  await sleep(350)
  app.doc.handlers.mousemove[0]({ clientX: 50, clientY: 20 })
  const explain = app.created.find(el => el.className === 'hg-popover-explain')
  assert.ok(explain, '解释行必须在')
  assert.equal(explain.textContent, '这条解释没说清它在这段话里指什么。可以直接用下面的追问。')
  assert.equal(explain.getAttribute('data-weak'), '1')
  app.dispose()
})

test('提示词要求按上下文解释、说不清要明说', async () => {
  const app = await loadPlugin()
  const instructions = app.internals.modelInstructions()
  assert.ok(instructions.includes('是干嘛用的'), '解释要回答它在这段话里是干嘛的')
  assert.ok(instructions.includes('不要写百科式定义'), '不许百科式定义')
  assert.ok(instructions.includes('明说'), '说不清要明说，不许编')
  app.dispose()
})

// ─── v0.20.0：配置精简 / 暗色可读 ─────────────────────────────────────

test('设置页不再有辅助模型槽配置', async () => {
  const app = await loadPlugin({ locale: 'zh' })
  const nodes = treeNodes(app.settingsPages[0].render())
  const text = nodes.map(node => String((node.props && node.props.children) || '')).join(' ')
  assert.equal(text.includes('辅助模型'), false, '辅助模型槽配置要收掉')
  assert.equal(text.includes('slot'), false)
  app.dispose()
})

test('淡入系数写在根节点上，卸载后清掉', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(800)
  assert.notEqual(app.doc.documentElement.style.getPropertyValue('--hg-fade-0'), '', '淡入时应有系数')
  app.dispose()
  assert.equal(app.doc.documentElement.style.getPropertyValue('--hg-fade-0'), '', '卸载后不能留系数')
})

// ─── v0.21.0：标记偏好下线 ────────────────────────────────────────────

test('设置页不再有标记偏好行', async () => {
  const app = await loadPlugin({ locale: 'zh' })
  const nodes = treeNodes(app.settingsPages[0].render())
  const text = nodes.map(node => String((node.props && node.props.children) || '')).join(' ')
  assert.equal(text.includes('标记偏好'), false, '标记偏好行要收掉')
  assert.equal(text.includes('生活'), false, '生活 / 技术三档选择器要收掉')
  app.dispose()
})

// ─── v0.23.0：解释缓存下线 ─────────────────────────────────────────────────

test('设置页不再有已缓存的解释区', async () => {
  const app = await loadPlugin({ locale: 'zh' })
  const nodes = treeNodes(app.settingsPages[0].render())
  const text = nodes.map(node => String((node.props && node.props.children) || '')).join(' ')
  assert.equal(text.includes('已缓存'), false, '缓存区要收掉')
  assert.equal(text.includes('清空缓存'), false)
  assert.equal(nodes.some(node => node.props && node.props.className === 'hg-cache-search'), false, '搜索框随缓存一起收掉')
  app.dispose()
})

test('旧解释缓存装载时清掉，标记恢复只靠标记表', async () => {
  const stored = new Map()
  stored.set('cache', {
    entries: {
      'zh|balanced|门诊慢特病|h1': { locale: 'zh', tier: 'balanced', term: '门诊慢特病', context: '门诊慢特病按病种', kind: 'term', explain: '医保门诊慢特病认定', note: '', questions: [] }
    },
    order: ['zh|balanced|门诊慢特病|h1']
  })
  stored.set('marks', {
    entries: {
      sig9: { tail: '门诊慢特病按病种', at: 9, terms: [{ term: '门诊慢特病', kind: 'term', explain: '医保门诊慢特病认定', note: '', questions: [] }] }
    },
    order: ['sig9']
  })
  const app = await loadPlugin({ stored })
  assert.equal(stored.has('cache'), false, '旧缓存数据要清掉')
  const marks = app.internals.storedMarksFor('门诊慢特病按病种，多数 70%。')
  assert.ok(marks && marks.some(item => item.term === '门诊慢特病' && item.explain), '标记恢复只靠标记表也要能查回解释')
  app.dispose()
})

// ─── v0.24.0：悬停不掉线 / 折叠 Range 恢复 / 追问不凑数 ──────────────────────

test('sessions.changed 重挂后悬停还能弹解释（标记在、hover 不能死）', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const move = app.doc.handlers.mousemove[0]
  move({ clientX: 100, clientY: 110 })
  assert.equal(popIsOpen(app), true, '重挂前 hover 要能弹')
  // 桌面端有新动态时也会发 sessions.changed：它先清空悬停命中表再重挂，
  // 重挂对「内容没变」的回复会早退，收尾不同步的话 hover 就永久死掉
  app.fire('sessions.changed')
  await sleep(700)
  move({ clientX: 100, clientY: 110 })
  assert.equal(popIsOpen(app), true, '重挂后 hover 必须还能弹，不能只剩标记')
  app.dispose()
})

test('文本节点被原地改写、Range 折叠后，高亮必须重新钉回词上', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const before = app.highlights.get('hg-term')
  assert.ok(before && before.ranges.length > 0, 'term range not registered')
  // 模拟 Chrome 实测行为：原地改写文本节点会把已登记的 Range 折叠成 0 长度
  const range = before.ranges[0]
  range.startContainer.nodeType = 3
  range.endContainer.nodeType = 3
  range.setStart(range.startContainer, 0)
  range.setEnd(range.startContainer, 0)
  // DOM 变动触发同步重锚：重建出的新 Range 必须换掉折叠的旧登记，
  // 签名去重如果只看「节点 + 偏移」的旧缓存，会把重建结果永远挡在外面
  const observer = [...globalThis.__observers].reverse().find(item => item.observed.some(record => record.target === app.doc.documentElement))
  observer.callback([{ target: app.mdEl, addedNodes: [] }])
  await sleep(500)
  const after = app.highlights.get('hg-term')
  assert.ok(
    after.ranges.some(r => r.startOffset === 0 && r.endOffset === 5),
    `折叠的 Range 必须被重建结果替换，实际 ${JSON.stringify(after.ranges.map(r => [r.startOffset, r.endOffset]))}`
  )
  app.dispose()
})

test('追问条数不固定：提示词与用户输入都允许 0 到 2 个、不凑数', async () => {
  const { internals } = await loadPlugin()
  const instructions = internals.modelInstructions()
  assert.ok(instructions.includes('0 到 2 个'), '追问 0 到 2 个')
  assert.ok(instructions.includes('没有合适的就不给'), '没有合适的就不给')
  assert.ok(instructions.includes('[]'), '空数组是合法输出')
  const input = internals.buildUserInput('门诊慢特病需要核实。', 'balanced', [])
  assert.ok(input.includes('最多给 2 个追问'), '中等档最多 2 个')
  assert.ok(input.includes('没有合适的就不给'), '允许不给')
})

// ─── v0.24.1：流式输出期间，正在看的弹层不再被滚动和新动态打掉 ──────────────

function openOnTerm(app, x = 100, y = 110) {
  const move = app.doc.handlers.mousemove[0]
  move({ clientX: x, clientY: y })
  return app.created.find(el => el.className === 'hg-popover')
}

function fireScroll(app) {
  const handlers = app.doc.handlers.scroll || []
  assert.ok(handlers.length > 0, 'scroll listener missing')
  for (const fn of handlers) fn({ target: app.doc.body })
}

test('指针还在词上时滚动：弹层跟着词的新位置走，不消失', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  const before = popover.style.top
  // 流式输出把会话区推着滚，词整体上移，指针还压在词上
  app.rectState.rect = { top: 96, left: 40, right: 200, bottom: 116, width: 160, height: 20 }
  fireScroll(app)
  assert.equal(popover.style.display, 'block', '滚动不能把用户正看着的弹层收掉')
  assert.notEqual(popover.style.top, before, '指针还在词上时，弹层要跟着词走')
  app.dispose()
})

test('指针停在弹层上时滚动：弹层原地不动，也不被收掉', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  const before = popover.style.top
  popover.handlers.mouseenter[0]()
  app.rectState.rect = { top: 300, left: 40, right: 200, bottom: 320, width: 160, height: 20 }
  fireScroll(app)
  assert.equal(popover.style.display, 'block', '指针在弹层里时滚动不能把它收掉')
  assert.equal(popover.style.top, before, '指针在弹层里时弹层不能被挪走')
  app.dispose()
})

test('流式滚动把词带走时：弹层冻在原地，不收也不跟着跑', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  const before = popover.style.top
  // 会话区滚走一大截，指针已经不在词上了
  app.rectState.rect = { top: 300, left: 40, right: 200, bottom: 320, width: 160, height: 20 }
  fireScroll(app)
  assert.equal(popover.style.display, 'block', '词被滚走时弹层不能立刻消失')
  assert.equal(popover.style.top, before, '弹层冻在原地，等用户把鼠标移上来')
  app.dispose()
})

test('sessions.changed（下一条回复开始输出）不再把正在看的弹层收掉', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  app.fire('sessions.changed', {})
  assert.equal(popover.style.display, 'block', '有新动态不能收掉用户正看着的弹层')
  app.dispose()
})

test('指针离开词以后，未命中照旧把弹层收掉', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  app.doc.handlers.mousemove[0]({ clientX: 600, clientY: 600, target: app.doc.body })
  await sleep(200)
  assert.equal(popover.style.display, 'none', '指针不在词上也不在弹层里，未命中就该收掉')
  app.dispose()
})

test('词整段滚出视口后，弹层跟着收掉，不会贴在屏幕边上', async () => {
  const rangeRect = { top: 100, left: 40, right: 200, bottom: 120, width: 160, height: 20 }
  const app = await loadPlugin({ replyText: REPLY, rangeRect })
  app.fire('message.complete', { text: REPLY })
  await sleep(700)
  const popover = openOnTerm(app)
  assert.ok(popover && popover.style.display === 'block', '悬停要先弹出解释')
  app.rectState.rect = { top: 950, left: 40, right: 200, bottom: 970, width: 160, height: 20 }
  fireScroll(app)
  assert.equal(popover.style.display, 'none', '词已经滚出视口，弹层不能再挂着')
  app.dispose()
})


// ─── 停用即恢复原样（v0.24.2）────────────────────────────────────────────
// 用户口径：关掉插件要回到装之前的样子，不能留一半代码还在页面上生效。

test('停用插件：覆盖层、样式、高亮、根变量全部收回', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.fire('message.complete', { text: REPLY })
  await sleep(800)
  assert.ok(app.highlights.size > 0, '标注应先挂上')
  assert.ok(app.doc.body.children.some(el => el.id === 'hermes-mark-words-hl'), '覆盖层节点应已建立')

  app.dispose()

  assert.equal(app.highlights.size, 0, '高亮登记要清空')
  assert.equal(app.doc.body.children.some(el => el.id === 'hermes-mark-words-hl'), false, '覆盖层节点要摘掉')
  assert.equal(app.doc.head.children.some(el => el.id === 'hermes-mark-words-style'), false, '样式标签要摘掉')
  assert.equal(app.doc.body.children.some(el => el.className === 'hg-popover'), false, '弹层不能留在 body 上')
  const root = app.doc.documentElement.style
  for (let i = 0; i < 4; i += 1) {
    assert.equal(root.getPropertyValue('--hg-fade-' + i), '', `卸载后不能留 --hg-fade-${i}`)
  }
})

test('停用之后进来的回复不再被标注，也不再花模型请求', async () => {
  const app = await loadPlugin({ replyText: REPLY })
  app.dispose()
  app.fire('message.complete', { text: REPLY })
  await sleep(600)
  assert.equal(app.highlights.size, 0, '停用后不许再画标记')
  assert.equal(app.doc.body.children.some(el => el.id === 'hermes-mark-words-hl'), false)
  assert.equal(app.requests.length, 0, '停用后不许再发模型请求')
})

test('全局监听器只走 ctx，源码里不留裸 document/window 监听', async () => {
  const source = await readFile(ENTRY, 'utf8')
  assert.equal(/document\.addEventListener\(/.test(source), false, 'document 监听要走 ctx.addEventListener')
  assert.equal(/win\.addEventListener\(/.test(source), false, 'window 监听要走 ctx.addEventListener')
})
