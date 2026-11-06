/**
 * hermes-mark-words — 给助手回复里有疑点的词加标记，悬停弹出解释与追问
 *
 * 做什么：
 *   1. 一轮回复结束后（message.complete）取这段回复的正文，只挑「读者会存疑」的词：
 *      疑似生造、含义不明、用法有歧义、或被作者自创的说法。基础词与含义明确的标准术语不标。
 *      回复是哪种语言就按哪种语言找，不限于中文或英文。
 *   2. 标记关系优先来自回复本身：主模型在末尾输出 ::hmw 指令行（正文里不显示），
 *      插件直接按它标注，不发第二次请求；回复没带标记块时才用辅助模型（llm.oneshot）批量解释。
 *   3. 在正文里给这些词加细下划线：普通疑点走中性点线，疑似生造与含义不明走细红波浪线。
 *   4. 鼠标移上去弹 popover：解释 + 不确定性与来源提示 + 能直接问出口的具体问题；
 *      每个问题带一个图标按钮，点一下把问题填进输入框（只填不发）。
 *   5. 每条回复的标记关系另存一份（markStore）：页面重渲染、切换会话、重载插件之后，
 *      旧回复的标记也能按文字重新钉回去，不依赖模型重跑。
 *
 * 三档（设置页切换），差别在「扫多少」和「解释多深」，也就是 token 花在哪：
 *   宽松 light     —— 只做本地高置信候选抽取，有高置信候选才问模型；一句话解释 + 最多 1 个追问。
 *   中等 balanced  —— 整段回复（截断 3000 字）交给模型找词；解释 + 不确定性 + 最多 2 个追问。
 *   详细 detailed  —— 整段回复（截断 8000 字）；解释 + 来源提示 + 最多 3 个追问。
 * 三档都不带历史轮次，但每档的辅助请求都附带最后一条用户提问（用来判断哪些词对他生疏）：
 *   宽松档只送候选词的上下文片段，中等与详细档只送这一段回复。
 *
 * 恢复：解释跟着标记块与标记表走，不留解释缓存；同样的回复文本只分析一次。
 *
 * 安装：~/.hermes/desktop-plugins/hermes-mark-words/plugin.js（目录名 == id）
 */

import { Button, host, PALETTE_AREA, SegmentedControl, ToggleRow, TRANSCRIPT_DIRECTIVE_AREA, usePluginI18n } from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-mark-words'
const PLUGIN_VERSION = '0.24.4'
// 历史插件 ID。改 ID 会换存储键前缀，旧键里的忽略词、设置在这里各搬一次；缓存键搬过来也会被清掉。
const LEGACY_IDS = ['hermes-term-helper', 'hermes-glossary']

// 渲染进程里的全局对象：Electron 主世界里 window 与 globalThis 同源，取不到时退回 globalThis
const win = typeof window !== 'undefined' ? window : globalThis

// ─── 档位 ────────────────────────────────────────────────────────────────
// scan：本地候选（light）还是整段交给模型（balanced / detailed）
// maxChars：整段扫描时送进模型的字数上限
// maxTerms：最多要几个词
// questions：每个词最多几个追问（0 到 2 个，没有合适的就不给）
const TIERS = {
  light: { labelKey: 'tierLight', scan: 'local', maxTerms: 3, questions: 1, maxTokens: 600, contextChars: 260 },
  balanced: { labelKey: 'tierBalanced', scan: 'full', maxTerms: 5, questions: 2, maxTokens: 1200, contextChars: 400 },
  detailed: { labelKey: 'tierDetailed', scan: 'full', maxTerms: 10, questions: 2, maxTokens: 2200, contextChars: 700 }
}
const TIER_IDS = ['light', 'balanced', 'detailed']

// 辅助任务槽：决定术语解释走哪套模型配置。默认 title_generation
// （网关自己的默认槽，指到便宜的 flash 模型）；设置页不暴露此项，默认槽行为恒定。
const TASK_SLOTS = ['title_generation', 'compression', 'memory_query_rewrite', 'skills_hub', 'curator', 'mcp']

const SETTINGS_DEFAULT = { enabled: true, tier: 'balanced', taskSlot: 'title_generation' }
// 用户点「忽略」的词：不再标注；设置页可查看和移除
let ignoredTerms = []
const MIN_REPLY_CHARS = 40
// 流式输出时文字一直在变，等它安静一会儿再判断「这条回复写完了」
const STREAM_SETTLE_MS = 700
const POLL_MS = 450
// 只用于合并同一时刻到达的多条辅助分析请求；带 ::hmw 的回复不过这道防抖
const ANALYZE_DEBOUNCE_MS = 150
const DOM_RETRY_MS = 250
const DOM_RETRY_LIMIT = 8

// 诊断通道：留空即关闭。填 http://127.0.0.1:PORT/ 会把运行轨迹发到本地，
// 用于在真实桌面端确认「事件到了、模型回了、词标上了」。
const DIAG_URL = ''

function diag(event, payload) {
  if (!DIAG_URL) return
  try {
    fetch(DIAG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload })
    }).catch(() => {})
  } catch (err) {
    // 诊断通道失败不影响主流程
  }
}

const HIGHLIGHT_TERM = 'hg-term'
const HIGHLIGHT_SUSPECT = 'hg-suspect'
// 淡入时长（毫秒）
const FADE_MS = 220
// 淡入槽位数：同时淡入的词分批登记到不同的高亮名里
const FADE_SLOTS = 4
const STYLE_ID = 'hermes-mark-words-style'
const HL_ID = 'hermes-mark-words-hl'

// ─── i18n ────────────────────────────────────────────────────────────────
const LOCALES = {
  en: {
    title: 'Mark Words',
    analysisLocale: 'en',
    enabledLabel: 'Enable term marking',
    enabledHint: 'Underline the words in assistant replies that are worth doubting; hover for an explanation and ready-to-ask follow-ups.',
    tierLabel: 'Scan depth',
    tierHint: 'Light only checks high-confidence candidates. Balanced and Detailed scan the whole reply. Deeper tiers cost more tokens.',
    tierLight: 'Light',
    tierBalanced: 'Balanced',
    tierDetailed: 'Detailed',
    kindTerm: 'Term',
    kindAbbrev: 'Abbreviation',
    kindFabricated: 'Possibly invented',
    kindUnclear: 'Meaning unclear',
    noteLabel: 'Uncertainty & source',
    fillTitle: 'Put this question in the composer',
    fillFailed: 'Could not write to the composer',
    rescan: 'Glossary: rescan the last reply',
    ignoreAction: 'Ignore this word',
    ignoreTitle: 'Keep this word unmarked until you restore it in settings',
    ignoredLabel: 'Ignored words',
    ignoredHint: 'Words you dismissed stay unmarked. Remove one here to mark it again.',
    ignoredEmpty: 'Nothing ignored yet.',
    unignore: 'Restore',
    markStatesTitle: 'Mark states',
    markSampleTerm: 'circuit breaking',
    markStateTerm: 'Dotted line · Term / abbreviation',
    markStateTermHint: 'Existing words used in a nonstandard or debatable way. Everyday words and well-established technical terms are never marked.',
    markSampleSuspect: 'zero-blank frame',
    markStateSuspect: 'Red wavy line · Suspected invented / unclear',
    markStateSuspectHint: 'Wording that may not exist, or whose meaning here is unclear and worth asking about.',
    explainWeak: 'This explanation does not say what the word means here. Ask the follow-ups below directly.'
  },
  zh: {
    title: '标词助手',
    analysisLocale: 'zh',
    enabledLabel: '启用术语标注',
    enabledHint: '给助手回复里有疑点的词加下划线，悬停弹出解释和能直接问出口的追问。',
    tierLabel: '扫描深度',
    tierHint: '宽松档只查高置信候选；中等与详细档整段扫描。档位越深，token 花得越多。',
    tierLight: '宽松',
    tierBalanced: '中等',
    tierDetailed: '详细',
    kindTerm: '术语',
    kindAbbrev: '缩写',
    kindFabricated: '疑似生造',
    kindUnclear: '含义不明',
    noteLabel: '不确定性与来源',
    fillTitle: '把这个问题填进输入框',
    fillFailed: '没能写入输入框',
    rescan: '术语：重新扫描上一条回复',
    ignoreAction: '忽略此词',
    ignoreTitle: '一直不再标记，直到你在设置里恢复',
    ignoredLabel: '已忽略的词',
    ignoredHint: '忽略的词不再标注；在这里移除就能恢复标记。',
    ignoredEmpty: '还没有忽略任何词。',
    unignore: '恢复',
    markStatesTitle: '标记状态',
    markSampleTerm: '熔断降级',
    markStateTerm: '中性点线 · 术语 / 缩写',
    markStateTermHint: '用法不标准或值得商榷的既有词。基础词和含义明确的标准术语不标。',
    markSampleSuspect: '零空帧',
    markStateSuspect: '细红波浪线 · 疑似生造 / 含义不明',
    markStateSuspectHint: '可能不存在的说法，或在这里含义说不清、值得追问。',
    explainWeak: '这条解释没说清它在这段话里指什么。可以直接用下面的追问。'
  }
}

// ─── 小工具 ──────────────────────────────────────────────────────────────
function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function hashString(value) {
  let hash = 5381
  const text = String(value || '')
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

// 一段文本里的所有文本节点 + 每个节点的起止偏移
// 代码、行内代码、公式里的词不是术语：解释它们只会标错位置。
const SKIP_ANCESTOR_TAGS = new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'TEXTAREA', 'MATH'])

function insideSkipped(node) {
  let cur = node
  for (let depth = 0; depth < 12 && cur; depth += 1) {
    const tag = cur.tagName
    if (tag && SKIP_ANCESTOR_TAGS.has(String(tag).toUpperCase())) return true
    cur = cur.parentElement
  }
  return false
}

// skipSkipped=true 时只收正文文本节点（跳过代码块等），
// 偏移量必须只按收进来的文本累加，否则 Range 会指到别的字上。
function textNodeIndex(root, skipSkipped) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null)
  const nodes = []
  let text = ''
  let node = walker.nextNode()
  while (node) {
    // 指令行即便落成普通文本（格式写坏、插件没认领），也按空格占位：
    // 正文索引里不能混进标记关系文本
    const value = maskMarkDirectives(node.nodeValue || '')
    if (!skipSkipped || !insideSkipped(node)) {
      nodes.push({ node, start: text.length, end: text.length + value.length })
      text += value
    } else {
      text += ' '.repeat(value.length)
    }
    node = walker.nextNode()
  }
  return { nodes, text }
}

function plainText(root) {
  return textNodeIndex(root, false).text
}

// 可标注文本：跳过代码块等之后剩下的正文。守卫判断必须用它，
// 用含代码块的全文会把「词只在代码里」误判成重渲染瞬态
function markableText(root) {
  return textNodeIndex(root, true).text
}

// 文字里有没有这个词：大小写不敏感，和 findTermRanges 同一口径
function textHasTerm(text, term) {
  return String(text || '').toLowerCase().includes(String(term || '').toLowerCase())
}

// 在 root 里找 term 的所有出现位置，返回 Range 数组
// 大小写不敏感：词表写 p90，正文写 P90 是同一个词。
// ASCII 词只认独立词位：exp90 里的 p90 不是术语，标上去就是错位置。
function findTermRanges(root, term) {
  const needle = String(term || '')
  if (!needle || needle.length < 2) return []
  const { nodes, text } = textNodeIndex(root, true)
  const foldedText = text.toLowerCase()
  const probe = needle.toLowerCase()
  if (!foldedText.includes(probe)) return []
  const headWordChar = /^[A-Za-z0-9_-]/.test(needle)
  const tailWordChar = /[A-Za-z0-9_-]$/.test(needle)
  const ranges = []
  let from = 0
  for (;;) {
    const at = foldedText.indexOf(probe, from)
    if (at === -1) break
    const end = at + probe.length
    from = end
    if (headWordChar && at > 0 && /[A-Za-z0-9_-]/.test(text[at - 1])) continue
    if (tailWordChar && end < text.length && /[A-Za-z0-9_-]/.test(text[end])) continue
    const startHit = nodes.find(item => item.start <= at && at < item.end)
    const endHit = nodes.find(item => item.start < end && end <= item.end)
    if (startHit && endHit) {
      const range = document.createRange()
      try {
        range.setStart(startHit.node, at - startHit.start)
        range.setEnd(endHit.node, end - endHit.start)
      } catch (err) {
        // 文本节点在取 Range 之前被 React 换掉了，跳过这一处
        continue
      }
      // Range 挂上后立刻核对位置：React 会原地改写文本节点，
      // 不核对的话过期的偏移会把标记画到别的字上（乱飘的波浪线就是这么来的）。
      if (!rangeMatchesText(range, needle)) continue
      ranges.push(range)
    }
  }
  return ranges
}

// Range 两端现在指着的文字还和词一致吗？不一致就说明文本节点被改写过
function rangeMatchesText(range, needle) {
  try {
    const start = range.startContainer
    const end = range.endContainer
    if (!start || !end) return false
    const startType = start.nodeType
    const endType = end.nodeType
    // 测试替身不模拟文本节点细节（nodeType 为 undefined），只要求节点还连着
    if (startType === undefined || endType === undefined) {
      if (start.isConnected === false) return false
      return true
    }
    // 真实 DOM 里 Range 的边界一定是文本节点。
    // React 换掉旧文本节点时，Chrome 会把 Range 边界收缩到父元素上
    // （startContainer 变成 P 这类元素、偏移落在子节点位置），
    // 这时 Range 画不出任何东西。把它当有效就会永远不重建高亮，
    // 表现就是标记凭空消失。元素边界一律按失效处理。
    if (startType !== 3 || endType !== 3) return false
    // 节点已脱离文档：直接当漂移处理
    if (start.isConnected === false || end.isConnected === false) return false
    const startText = String(start.nodeValue || '')
    const endText = String(end.nodeValue || '')
    // 同一个节点：偏移区间里必须正好是这个词。
    // 注意不能写成 startText === endText：两个不同节点里恰好是同一段文字时，
    // Range 跨节点覆盖两段，那个词是跨节点的，误判成漂移会让标记整批消失。
    if (start === end) {
      const slice = startText.slice(range.startOffset, range.endOffset)
      return slice.toLowerCase() === String(needle).toLowerCase()
    }
    if (typeof range.toString === 'function' && range.toString !== Object.prototype.toString) {
      return range.toString().toLowerCase() === String(needle).toLowerCase()
    }
    // 仅测试替身没有真实 Range.toString 时检查两端
    const folded = String(needle).toLowerCase()
    const head = startText.slice(range.startOffset, range.startOffset + needle.length)
    const tail = endText.slice(Math.max(0, range.endOffset - needle.length), range.endOffset)
    return head.toLowerCase() === folded || tail.toLowerCase() === folded
  } catch (err) {
    return false
  }
}

// ─── 本地候选抽取（宽松档用，零 token）───────────────────────────────
// 候选按 rank 排序：轻档只留 maxTerms 个，性能指标必须先保住
const CANDIDATE_PATTERNS = [
  { re: /(?<![a-z0-9.\/-])[A-Za-z]{1,4}[0-9]{1,3}(?![a-z0-9.\/-])/g, pick: 0, rank: 0 },
  { re: /(首字延迟|首字中位|首字时间|首字耗时|中位数|长尾延迟|尾延迟|分位值|分位数|时延|抖动|长尾|吞吐量|压力测试|基准测试|压测)/g, pick: 1, rank: 1 },
  { re: /\b[A-Z]{2,6}(?![A-Za-z])/g, pick: 0, rank: 2 },
  { re: /\b[a-z]+(?:_[a-z0-9]+)+\b/g, pick: 0, rank: 3 },
  { re: /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g, pick: 0, rank: 4 },
  { re: /[《「【“"']([^》」】”"']{2,24})[》」】”"']/g, pick: 1, rank: 5 },
  { re: /([\u4e00-\u9fffA-Za-z0-9]{2,14})[（(][^)）]{2,40}[)）]/g, pick: 1, rank: 6 }
]

const CJK_DOMAIN_SUFFIX =
  /(?:率|制|型|险|费|税|证|卡|码|系统|平台|机制|政策|流程|标准|指标|口径|阈值|算法|模型|架构|协议|接口|组件|服务|集群|缓存|索引|事务|队列|消息|日志|链路|迁移|备份|病|症|术|药|疗|保|定额|比例|备案|转诊|门诊|住院|结算|起付|封顶)/

function localCandidates(text) {
  // 按 rank 记录首次命中：rank 小的排前面，轻档截断时先保住性能指标
  const ranked = new Map()
  const source = String(text || '')
  for (const { re, pick, rank = 9 } of CANDIDATE_PATTERNS) {
    const matcher = new RegExp(re.source, re.flags)
    let match = matcher.exec(source)
    while (match) {
      const value = (match[pick] || '').trim()
      if (value && value.length >= 2 && value.length <= 24 && !ranked.has(value)) ranked.set(value, rank)
      match = matcher.exec(source)
    }
  }
  // 中文领域词只做粗筛，真假交给模型判断
  const suffixMatcher = new RegExp(`[\\u4e00-\\u9fff]{2,8}${CJK_DOMAIN_SUFFIX.source}`, 'g')
  let suffixMatch = suffixMatcher.exec(source)
  while (suffixMatch) {
    const value = suffixMatch[0].trim()
    if (value.length >= 3 && value.length <= 12 && !ranked.has(value)) ranked.set(value, 8)
    suffixMatch = suffixMatcher.exec(source)
  }
  return [...ranked.entries()].sort((a, b) => a[1] - b[1]).map(([value]) => value)
}

// 取术语周围的一段语境，用作提示词上下文
function contextAround(text, term, span) {
  const source = String(text || '')
  const at = source.indexOf(term)
  if (at === -1) return ''
  const half = Math.floor(span / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(source.length, at + term.length + half)
  return source.slice(start, end).trim()
}

// ─── 回复自带的标记块（单请求标注）─────────────────────────────────────
// 主模型在回复末尾按约定输出 `::hmw{term="…", kind="…", explain="…", q1="…"}` 指令行，
// 桌面端 transcript.directives 通道把指令行渲染成空组件，标记关系不进正文显示。
// 插件从 message.complete 的原始 markdown 里解析标记关系，直接标注，不再发第二次模型请求。
const MARK_DIRECTIVE = 'hmw'
// 与桌面端解析口径一致：名字 [a-z][a-z0-9-]{0,63}，attrs 段不能含花括号、最长 2048
const DIRECTIVE_LINE_RE = '(?<=^|\\s)::([a-z][a-z0-9-]{0,63})(?:\\{([^{}]{0,2048})\\})?'
const DIRECTIVE_ATTR_RE = /([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')/gi

function directiveAttrs(text) {
  const attrs = {}
  const matcher = new RegExp(DIRECTIVE_ATTR_RE.source, 'gi')
  let match = matcher.exec(String(text || ''))
  while (match) {
    attrs[match[1].toLowerCase()] = String(match[2] ?? match[3] ?? '')
    match = matcher.exec(String(text || ''))
  }
  return attrs
}

// 从回复原始文本里解析 ::hmw 标记关系，返回与模型词表同构的条目
function parseMarkDirectives(rawText) {
  const source = String(rawText || '')
  if (!source.includes('::' + MARK_DIRECTIVE)) return []
  const out = []
  const seen = new Set()
  const matcher = new RegExp(DIRECTIVE_LINE_RE, 'g')
  let match = matcher.exec(source)
  while (match) {
    if (match[1] === MARK_DIRECTIVE && match[2] !== undefined) {
      const attrs = directiveAttrs(match[2])
      const term = String(attrs.term || '').trim()
      if (term && !seen.has(term)) {
        seen.add(term)
        out.push({
          term,
          kind: attrs.kind,
          explain: String(attrs.explain || '').trim(),
          note: String(attrs.note || '').trim(),
          questions: [attrs.q1, attrs.q2, attrs.q3].map(value => String(value || '').trim()).filter(Boolean)
        })
      }
    }
    match = matcher.exec(source)
  }
  return out
}

// 把 ::hmw 指令行从文本里抹成等长空格（偏移不漂），
// 尾部锚点与分析都用抹掉后的文本，才能和渲染文本对上
function maskMarkDirectives(text) {
  return String(text || '').replace(
    new RegExp(`(?<=^|\\s)::${MARK_DIRECTIVE}\\{[^{}]{0,2048}\\}`, 'g'),
    hit => ' '.repeat(hit.length)
  )
}

function stripMarkDirectives(rawText) {
  return maskMarkDirectives(rawText).trim()
}

// ─── 存储与文案 ────────────────────────────────────────────────────────────────
let storage = null
// 旧宿主没有 ctx.i18n：按系统语言挑中文或英文文案，功能不受影响
function localTranslate(locale, key, ...args) {
  const value = LOCALES[locale]?.[key] ?? LOCALES.zh[key] ?? key
  return typeof value === 'function' ? value(...args) : value
}
function guessLocale() {
  // 中英两种就够：系统语言是中文就用中文，其余用英文
  try {
    const lang = String((win && win.navigator && win.navigator.language) || '')
    if (!lang) return 'zh'
    return /^zh/i.test(lang) ? 'zh' : 'en'
  } catch (err) {
    return 'zh'
  }
}
let ctxI18nT = (key, ...args) => localTranslate(guessLocale(), key, ...args)

// 解释用哪种语言：跟应用语言走，不看回复本身是中文还是英文
function analysisLocale() {
  return ctxI18nT('analysisLocale') === 'zh' ? 'zh' : 'en'
}

// ─── 宿主作用域计时器 ───────────────────────────────────────────────────
// ctx.setTimeout / ctx.setInterval 由宿主在卸载时自动清；旧宿主没有这两件时
// 退回原生计时器并登记，dispose 里统一清掉。原则：卸载之后不留还在跑的计时器。
let hostCtx = null
const nativeTimers = new Set()

function later(fn, ms) {
  if (hostCtx && typeof hostCtx.setTimeout === 'function') return hostCtx.setTimeout(fn, ms)
  const id = setTimeout(fn, ms)
  const cancel = () => clearTimeout(id)
  nativeTimers.add(cancel)
  return () => { nativeTimers.delete(cancel); clearTimeout(id) }
}

function every(fn, ms) {
  if (hostCtx && typeof hostCtx.setInterval === 'function') return hostCtx.setInterval(fn, ms)
  const id = setInterval(fn, ms)
  const cancel = () => clearInterval(id)
  nativeTimers.add(cancel)
  return () => { nativeTimers.delete(cancel); clearInterval(id) }
}

function cancelTimer(handle) {
  if (!handle) return
  try { handle() } catch (err) { /* 已经清过 */ }
}

// 一帧之后跑：有 rAF 用 rAF，没有就退回计时器。返回值统一是 cancel 函数
function nextFrame(fn) {
  if (typeof win.requestAnimationFrame === 'function') {
    const id = win.requestAnimationFrame(() => fn())
    return () => { try { if (win.cancelAnimationFrame) win.cancelAnimationFrame(id) } catch (err) {} }
  }
  return later(fn, 16)
}

let settings = { ...SETTINGS_DEFAULT }


function saveIgnoredTerms() {
  if (storage) storage.set('ignoredTerms', ignoredTerms)
}

function isIgnored(term) {
  const value = String(term || '').trim()
  if (!value) return false
  if (ignoredTerms.includes(value)) return true
  const lower = value.toLowerCase()
  return ignoredTerms.some(item => item.toLowerCase() === lower)
}

function ignoreTerm(term) {
  const value = String(term || '').trim()
  if (!value || isIgnored(value)) return
  ignoredTerms.push(value)
  saveIgnoredTerms()
  // 页面上这个词的标记立刻撤掉；标记表不动，解除忽略后还能恢复
  let changed = false
  for (const [element, item] of elementRanges) {
    const keptEntries = item.entries.filter(holder => !isIgnored(holder.entry.term))
    if (keptEntries.length === item.entries.length) continue
    changed = true
    if (!keptEntries.length) {
      elementRanges.delete(element)
      appliedState.delete(element)
      continue
    }
    elementRanges.set(element, {
      termRanges: keptEntries.filter(h => !['fabricated','unclear'].includes(h.entry.kind)).flatMap(h => h.ranges),
      suspectRanges: keptEntries.filter(h => ['fabricated','unclear'].includes(h.entry.kind)).flatMap(h => h.ranges),
      entries: keptEntries,
      sessionId: item.sessionId,
      nodes: keptEntries.flatMap(h => h.ranges.map(r => r.startContainer))
    })
    appliedState.delete(element)
  }
  if (changed) {
    refreshHighlights()
    hoverState.dirty = true
  }
}

function unignoreTerm(term) {
  const value = String(term || '').trim()
  const before = ignoredTerms.length
  ignoredTerms = ignoredTerms.filter(item => item !== value)
  if (ignoredTerms.length !== before) {
    saveIgnoredTerms()
    reapplyAll()
    remountAllMarks()
  }
}

// 旧 ID 的存储键搬到新 ID 下：读到旧值就写进新键，然后删掉旧键。
// 搬完用户之前忽略过的词、设置过的档位都还在。
let migratedKeys = 0
function migrateLegacyStorage() {
  try {
    const ls = win.localStorage
    if (!ls || typeof ls.getItem !== 'function') return
    for (const legacyId of LEGACY_IDS) {
      for (const key of ['settings', 'ignoredTerms', 'cache']) {
        const legacyKey = `hermes.plugin.${legacyId}.${key}`
        let legacy = null
        try {
          legacy = ls.getItem(legacyKey)
        } catch (err) {
          continue
        }
        if (!legacy) continue
        try {
          const current = storage.get(key, null)
          if (current === null || current === undefined) {
            storage.set(key, JSON.parse(legacy))
            migratedKeys += 1
          }
        } catch (err) {
          // 旧值不是合法 JSON，就不要了，总比写坏数据强
        }
        try {
          ls.removeItem(legacyKey)
        } catch (err) {
          // 删不掉旧键也不影响新键已生效
        }
      }
    }
  } catch (err) {
    // 存储不可用时跳过迁移，不影响插件本身工作
  }
}






// ─── 每回复标记表（markStore）──────────────────────────────────────────────
// 标记关系（含解释与追问）按正文存一份：页面重渲染、切会话、重载插件之后，
// 靠尾部锚点找回同一条回复，把标记重新钉回去。
// 这是「旧回复的标记不再消失」的根：不依赖模型重跑。
const MARKS_KEY = 'marks'
const MARKS_LIMIT = 160
let markStore = {}
let markOrder = []

function loadMarkStore() {
  if (!storage) return
  const stored = storage.get(MARKS_KEY, null)
  const entries = stored && typeof stored.entries === 'object' && stored.entries ? stored.entries : {}
  markStore = {}
  markOrder = []
  let dirty = false
  for (const [sig, record] of Object.entries(entries)) {
    if (!record || !Array.isArray(record.terms) || !record.terms.length) continue
    // 洗掉旧口径留下的基础词、文件名与代码片段：重挂时不会再把它们标出来
    let stripped = false
    const kept = record.terms.filter(item => item && isUsableTerm(item.term, item.term, item.kind)).map(item => {
      if (item.theme === undefined) return item
      stripped = true
      const rest = { ...item }
      delete rest.theme
      return rest
    })
    if (!kept.length) {
      dirty = true
      continue
    }
    if (kept.length !== record.terms.length || stripped) dirty = true
    markStore[sig] = { ...record, terms: kept }
    markOrder.push(sig)
  }
  if (Array.isArray(stored && stored.order)) {
    const ordered = stored.order.filter(sig => markStore[sig])
    for (const sig of Object.keys(markStore)) {
      if (!ordered.includes(sig)) ordered.push(sig)
    }
    markOrder = ordered
  }
  // 洗过的标记表要落盘，不然下次装载还会再洗一遍
  if (dirty) saveMarkStore()
}

function saveMarkStore() {
  if (!storage) return
  storage.set(MARKS_KEY, { entries: markStore, order: markOrder })
}

function rememberMarks(text, terms) {
  const clean = normalizeText(stripMarkDirectives(String(text || '')))
  if (!clean || !terms || !terms.length) return
  const sig = hashString(clean)
  markStore[sig] = {
    tail: tailAnchor(clean),
    at: nowMs(),
    terms: terms.map(item => ({
      term: item.term,
      kind: item.kind,
      explain: item.explain,
      note: item.note,
      questions: (item.questions || []).slice(0, 2)
    }))
  }
  markOrder = markOrder.filter(key => key !== sig)
  markOrder.push(sig)
  while (markOrder.length > MARKS_LIMIT) {
    const oldest = markOrder.shift()
    delete markStore[oldest]
  }
  saveMarkStore()
}

// 按正文找这条回复的标记：先算精确哈希，再退回尾部锚点
// （网关拿到的是原始 markdown，页面里是渲染文本，两者只差语法字符，尾部能对上）
function storedMarksFor(text) {
  const clean = normalizeText(stripMarkDirectives(String(text || '')))
  if (!clean) return null
  const exact = markStore[hashString(clean)]
  if (exact) return exact.terms
  const tail = tailAnchor(clean)
  if (!tail) return null
  for (let i = markOrder.length - 1; i >= 0; i -= 1) {
    const record = markStore[markOrder[i]]
    if (!record || !record.tail) continue
    if (record.tail.includes(tail) || tail.includes(record.tail)) return record.terms
  }
  return null
}


// ─── 模型调用 ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT =
  '你是术语标注助手。阅读下面一段助手回复，只挑「读者会存疑」的词：疑似生造或不存在的说法、含义不明或有歧义的词、用法不标准或值得商榷的概念。\n' +
  '宁缺毋滥：日常口语、常识词、广为人知的概念（浏览器、下载、缓存、接口、API、数据库）一律不标；常规工程词（加载、路由、同步、备份、日志、部署、监控这类）和含义明确、行业通行的标准术语也不标，哪怕它技术性很强；文件路径、网址、命令、代码标识符、版本号、纯数字不标。\n' +
  '一段回复通常只有 0 到 3 个够格的词；一个都没有就输出空数组，绝不凑数。回复用哪种语言写，就按哪种语言挑：中文、英文、日文、韩文或其他文字都一样对待，不要因为不是中文或英文就跳过。\n' +
  '只输出 JSON，格式：{"terms":[{"term":"原文里的连续片段","kind":"fabricated|unclear|term","explain":"一句话说明它在这段上下文里指什么、疑点在哪，60 字以内","note":"不确定程度与判断依据；没有就写空字符串","questions":["能直接问出口的具体问题，0 到 2 个，没有合适的就给空数组"]}]}\n' +
  '规则：\n' +
  '1. term 必须逐字出现在原文里（含大小写），不要改写、不要翻译、不要重复；可以是任意语言的词。\n' +
  '2. kind：疑似编造或不存在的说法用 fabricated；含义不明、或在此处有歧义用 unclear；既有词但用法不标准、值得商榷用 term。\n' +
  '3. explain 必须回答「这个词在这段话里指什么、是干嘛用的、跟读者有什么关系」，就着上下文说，不要写百科式定义；含义真判断不出来就明说「从上下文看不出它指什么」再讲哪里可疑，不要硬编一个定义。\n' +
  '4. questions 必须针对这个词在这段内容里的疑点，能落地核实（例如「这个说法出自哪份文件」「这两个口径哪个算数」）；禁止「这是什么意思」这类空问。0 到 2 个就够，没有合适的就不给，不要凑数。\n' +
  '5. questions 必须是纯字符串数组（如 ["问题一"] 或 []），不要写成对象、不要把数组再转义成字符串；explain 和 note 必须是普通字符串。\n'

function modelInstructions() {
  const language = analysisLocale() === 'zh' ? '中文' : 'English'
  return (
    SYSTEM_PROMPT +
    '\n挑词口径：只标有疑点、值得追问的词，不是列术语表。正文里已经讲清楚的词不要再标。结合最后一条用户提问判断哪些说法对这位用户值得挑刺：他问到的、他表现出不熟或有疑问的概念优先。' +
    `\nExplanation language: ${language}. explain、note 和 questions 一律用这个语言写，不管回复本身是什么语言。term 必须与原文逐字一致。`
  )
}

// 最后一条用户提问：辅助模型靠它判断哪些词对这位用户生疏
function lastUserMessage() {
  try {
    const nodes = document.querySelectorAll('[data-role="user"]')
    if (!nodes || !nodes.length) return ''
    return normalizeText(nodes[nodes.length - 1].textContent || '').slice(-400)
  } catch (err) {
    return ''
  }
}

function buildUserInput(text, tier, candidates) {
  const config = TIERS[tier] || TIERS.balanced
  const lines = []
  const asked = lastUserMessage()
  if (asked) {
    lines.push('最后一条用户提问（用来判断哪些词对他生疏）：')
    lines.push(asked)
  }
  if (config.scan === 'full') {
    lines.push('助手回复：')
    lines.push(String(text || ''))
  } else {
    lines.push('助手回复中的候选词与它们的上下文：')
    for (const candidate of candidates) {
      lines.push(`- ${candidate}：「${contextAround(text, candidate, config.contextChars)}」`)
    }
  }
  lines.push(`最多输出 ${config.maxTerms} 个词，每个词最多给 ${config.questions} 个追问，没有合适的就不给；没有够格的词就输出空数组，不要凑数。`)
  return lines.join('\n')
}

// 模型偶尔把 questions 写成字符串，或写成被引号包起来的 JSON 数组，都归一成字符串数组
function coerceQuestions(value) {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (typeof item === 'string') return item
        if (item && typeof item.text === 'string') return item.text
        return ''
      })
      .map(item => item.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        return coerceQuestions(JSON.parse(text))
      } catch (err) {
        // 不是合法 JSON 数组，按行断句处理
      }
    }
    return text
      .split(/[\n；;]+/)
      .map(item => item.trim())
      .filter(Boolean)
  }
  return []
}

// 从一段乱 JSON 里逐个抠出 terms 数组的元素（模型偶尔在个别词上写坏引号或括号）
function salvageTerms(body) {
  const marker = body.indexOf('"terms"')
  if (marker === -1) return []
  const arrayStart = body.indexOf('[', marker)
  if (arrayStart === -1) return []
  const out = []
  let depth = 0
  let inString = false
  let escaped = false
  let elementStart = -1
  for (let i = arrayStart; i < body.length; i += 1) {
    const ch = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) elementStart = i
      depth += 1
      continue
    }
    if (ch === '}') {
      depth -= 1
      if (depth === 0 && elementStart >= 0) {
        const chunk = body.slice(elementStart, i + 1)
        const term = /"term"\s*:\s*"([^"]+)"/.exec(chunk)
        if (term) {
          const explain = /"explain"\s*:\s*"([^"]*)"/.exec(chunk)
          const note = /"note"\s*:\s*"([^"]*)"/.exec(chunk)
          const kind = /"kind"\s*:\s*"([^"]*)"/.exec(chunk)
          const questions = /"questions"\s*:\s*(\[[^\]]*\]|"[^"]*")/.exec(chunk)
          let parsedQuestions = []
          if (questions) {
            try {
              parsedQuestions = coerceQuestions(JSON.parse(questions[1]))
            } catch (err) {
              parsedQuestions = coerceQuestions(questions[1])
            }
          }
          out.push({
            term: term[1],
            kind: kind ? kind[1] : 'term',
            explain: explain ? explain[1] : '',
            note: note ? note[1] : '',
            questions: parsedQuestions
          })
        }
        elementStart = -1
      }
      continue
    }
    if (ch === ']' && depth === 0) break
  }
  return out
}

function parseModelJson(raw) {
  const text = String(raw || '').trim()
  if (!text) return []
  let body = text
  if (body.startsWith('```')) {
    body = body.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()
  }
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1))
      const terms = parsed && Array.isArray(parsed.terms) ? parsed.terms : []
      const clean = terms.filter(item => item && typeof item.term === 'string' && item.term.trim())
      if (clean.length) {
        return clean.map(item => ({
          term: item.term.trim(),
          kind: item.kind,
          explain: item.explain,
          note: item.note,
          questions: coerceQuestions(item.questions)
        }))
      }
    } catch (err) {
      // 整体解析失败：逐个词抢救
      const salvaged = salvageTerms(body.slice(start))
      if (salvaged.length) return salvaged
      return []
    }
  }
  // 顶层直接是数组
  const arrayStart = body.indexOf('[')
  const arrayEnd = body.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      const parsed = JSON.parse(body.slice(arrayStart, arrayEnd + 1))
      if (Array.isArray(parsed)) {
        return parsed
          .filter(item => item && typeof item.term === 'string' && item.term.trim())
          .map(item => ({
            term: item.term.trim(),
            kind: item.kind,
            explain: item.explain,
            note: item.note,
            questions: coerceQuestions(item.questions)
          }))
      }
    } catch (err) {
      // 继续走抢救逻辑
    }
  }
  return salvageTerms(body)
}

// 模型回的词要过三道闸：原文里真的逐字出现、不是路径/代码片段、不是无意义短串。
// 宁可漏标也不要标错位置。
// 过于常见的普通词，标了也没意义。按「只标有疑点」的口径，这些词一律不进标记。
const COMMON_WORDS = new Set([
  // 中文：日常与工程常识
  '文档', '通用', '方案', '项目', '代码', '问题', '需求', '数据', '结果', '内容',
  '系统', '功能', '版本', '用户', '时间', '方式', '方法', '过程', '状态', '效果',
  '作用', '影响', '支持', '实现', '设计', '测试', '示例', '场景', '业务', '服务',
  '流程', '标准', '工具', '文件', '目录', '记录', '说明', '建议', '结论', '重点',
  '浏览器', '下载', '上传', '缓存', '接口', '数据库', '服务器', '客户端', '前端', '后端',
  '算法', '模型', '框架', '组件', '插件', '配置', '部署', '安装', '更新', '提示词',
  '表格', '图片', '视频', '密码', '账号', '网址', '链接', '列表', '按钮', '页面',
  // 中文：常规工程词与生活词，都算基础词
  '加载', '路由', '同步', '备份', '日志', '脚本', '命令', '终端', '桌面', '窗口',
  '标签', '菜单', '图标', '主题', '字体', '快捷键', '剪贴板', '权限', '沙箱', '容器',
  '镜像', '仓库', '分支', '提交', '合并', '冲突', '回滚', '灰度', '并发', '延迟',
  '吞吐', '带宽', '流量', '鉴权', '加密', '证书', '域名', '端口', '协议', '网关',
  '中间件', '限流', '幂等', '队列', '索引', '事务', '集群', '节点', '调度', '监控',
  '告警', '报表', '统计', '筛选', '排序', '分页', '搜索', '设置', '账户', '登录',
  '注册', '订阅', '会员', '订单', '退款', '发票', '物流', '售后', '培训', '招聘',
  '工资', '会议', '报告', '计划', '预算', '目标', '任务', '进度', '风险', '质量',
  '反馈', '投诉', '广告', '营销', '运营', '客服', '公告', '通知', '消息', '提醒',
  // 英文：日常与工程常识（比较时统一小写）
  'browser', 'download', 'upload', 'cache', 'api', 'http', 'https', 'json', 'url',
  'server', 'client', 'database', 'file', 'path', 'code', 'build', 'deploy', 'test',
  'version', 'update', 'install', 'config', 'function', 'data', 'network', 'request',
  'response', 'model', 'algorithm', 'framework', 'library', 'package', 'module',
  'thread', 'process', 'memory', 'disk', 'email', 'login', 'password', 'account',
  'link', 'button', 'page', 'table', 'image', 'video', 'string', 'number', 'boolean',
  // 英文：常规工程词与生活词
  'loading', 'routing', 'sync', 'backup', 'log', 'script', 'command', 'terminal',
  'desktop', 'window', 'tab', 'menu', 'icon', 'theme', 'font', 'shortcut', 'clipboard',
  'permission', 'sandbox', 'container', 'image', 'repository', 'branch', 'commit',
  'merge', 'rollback', 'canary', 'concurrency', 'latency', 'throughput', 'bandwidth',
  'traffic', 'auth', 'encryption', 'certificate', 'domain', 'port', 'protocol',
  'middleware', 'gateway', 'queue', 'index', 'transaction', 'cluster', 'monitor',
  'alert', 'report', 'filter', 'sort', 'search', 'settings', 'signup', 'subscribe',
  'order', 'refund', 'invoice', 'shipping', 'warranty', 'meeting', 'plan', 'budget',
  'goal', 'task', 'progress', 'risk', 'quality', 'feedback', 'complaint', 'ads',
  'marketing', 'operations', 'support', 'announcement', 'notification', 'message',
  'reminder', 'migration', 'replica', 'snapshot', 'stream', 'pipeline',
  // 性能与统计指标：含义明确的标准指标，永远不标
  'p50', 'p90', 'p95', 'p99', 'ttfb', 'qps', 'rtt', 'tps', 'sla', 'slo', 'sli',
  'cdn', 'dns', 'ssl', 'tls', 'cpu', 'gpu', 'ram', 'ssd', 'rpc', 'grpc', 'ssh'
])

function isUsableTerm(term, source, kind) {
  const value = String(term || '').trim()
  if (value.length < 2 || value.length > 24) return false
  if (!source.includes(value) && !String(source).toLowerCase().includes(value.toLowerCase())) return false
  // 带空白的多半是句子里截出来的片段，不是术语
  if (/[\s\u3000]/.test(value)) return false
  // 文件路径、URL、命令与代码 token 一律不标
  if (/[\\/]/.test(value)) return false
  if (/^https?:$/i.test(value)) return false
  if (/[=;:>&|@#$%^*!~`\[\]]/.test(value)) return false
  if (/\.[A-Za-z0-9]{1,5}$/.test(value)) return false
  if (/[()（）<>《》【】"“”'‘’]/.test(value)) return false
  // 至少含一个字母：纯数字、纯符号都不进标记（任何文字系统的字母都算）
  if (!/\p{L}/u.test(value)) return false
  // 词内只允许字母、数字、组合符、连字符、撇号、中点、句点：
  // 假名、谚文、西里尔、泰文、阿拉伯文都能过；下划线与路径分隔符这类代码味道的字符进不来
  if (!/^[\p{L}\p{N}\p{M}'’·.\-]+$/u.test(value)) return false
  if (/[._-]{2,}/.test(value)) return false
  // 常见词不标：中文按原样比，英文按小写比
  if (COMMON_WORDS.has(value) || COMMON_WORDS.has(value.toLowerCase())) return false
  // 两字纯汉字词绝大多数是常用词（加载、路由、同步这类）：
  // 只有「疑似生造 / 含义不明」这种存疑档才允许标两字词，术语档一律不放行
  if (/^\p{Script=Han}{2}$/u.test(value)) {
    const doubtKind = normalizeKind(kind)
    if (doubtKind !== 'fabricated' && doubtKind !== 'unclear') return false
  }
  // 纯汉字的词再收一档长度：超过 12 字基本是句子片段
  if (/^\p{Script=Han}+$/u.test(value) && value.length > 12) return false
  return true
}

function normalizeKind(kind) {
  const value = String(kind || '').toLowerCase()
  if (value === 'abbrev' || value === 'abbreviation') return 'abbrev'
  if (value === 'fabricated' || value === 'invented' || value === 'coined') return 'fabricated'
  if (value === 'unclear' || value === 'unknown') return 'unclear'
  return 'term'
}

// 标记的显示类型：fabricated/unclear 画红波浪线（怀疑），其余画中性点线（既有词）
function markKind(item) {
  return (item.kind === 'fabricated' || item.kind === 'unclear') ? 'suspect' : 'term'
}

async function askModel(text, tier, candidates) {
  const config = TIERS[tier] || TIERS.balanced
  const result = await host.request('llm.oneshot', {
    instructions: modelInstructions(),
    input: buildUserInput(text, tier, candidates),
    task: settings.taskSlot,
    max_tokens: config.maxTokens,
    temperature: 0.2
  }, 45000)
  return parseModelJson(result && result.text)
}

// ─── 高亮 ────────────────────────────────────────────────────────────────
// 视觉口径：不用荧光笔式的黄底块，改成细下划线。
//   普通疑点（term/abbrev）—— 中性点线，颜色跟着字色走，安静、不打断阅读；
//   疑似生造 / 含义不明 —— 1px 细红波浪线，是唯一带颜色的信号。
// 两者都交给浏览器原生高亮画（::highlight），永远贴着文字，滚动不漂。
const STYLE_TEXT = `
::highlight(hg-term) { text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: color-mix(in srgb, var(--ui-text-primary) 38%, transparent); text-decoration-thickness: 1px; text-underline-offset: 2.5px; }
::highlight(hg-suspect) { text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: var(--dt-destructive); text-decoration-thickness: 1px; text-underline-offset: 3px; }
` + Array.from({ length: FADE_SLOTS }, (_, n) => `
@property --hg-fade-${n} { syntax: '<number>'; inherits: true; initial-value: 1; }
::highlight(hg-term-f${n}) { text-decoration-line: underline; text-decoration-style: dotted; text-decoration-color: color-mix(in srgb, color-mix(in srgb, var(--ui-text-primary) 38%, transparent) calc(var(--hg-fade-${n}) * 100%), transparent); text-decoration-thickness: 1px; text-underline-offset: 2.5px; }
::highlight(hg-suspect-f${n}) { text-decoration-line: underline; text-decoration-style: wavy; text-decoration-color: color-mix(in srgb, var(--dt-destructive) calc(var(--hg-fade-${n}) * 100%), transparent); text-decoration-thickness: 1px; text-underline-offset: 3px; }`).join('') + `
.hg-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 2147482500; }
.hg-hl { position: absolute; border-radius: 2px; background: color-mix(in srgb, var(--ui-text-primary) 10%, transparent); opacity: 0; transition: opacity 200ms ease; }
.hg-hl.hg-in { opacity: 1; }
.hg-mark-legend { display: flex; flex-direction: column; gap: 10px; margin-top: 6px; }
.hg-mark-legend-item { display: flex; align-items: baseline; gap: 12px; }
.hg-mark-legend-text { display: flex; flex-direction: column; gap: 2px; }
.hg-sample-term { flex: 0 0 auto; min-width: 6.5em; text-align: center; font-size: 13px; text-decoration: underline dotted color-mix(in srgb, var(--ui-text-primary) 38%, transparent); text-decoration-thickness: 1.5px; text-underline-offset: 2.5px; }
.hg-sample-suspect { flex: 0 0 auto; min-width: 6.5em; text-align: center; font-size: 13px; text-decoration: underline wavy var(--dt-destructive); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.hg-popover { position: fixed; z-index: 2147483000; max-width: 340px; box-sizing: border-box; padding: 11px 13px 12px; border-radius: 12px; border: 1px solid var(--dt-border); background: var(--dt-popover); color: var(--dt-popover-foreground); font-size: 13px; line-height: 1.55; box-shadow: 0 10px 30px color-mix(in srgb, var(--ui-text-primary) 16%, transparent); }
.hg-popover-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.hg-popover-term { font-weight: 600; letter-spacing: .01em; }
.hg-popover-badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dt-border); opacity: .85; }
.hg-popover-spacer { flex: 1 1 auto; }
.hg-popover-ignore { border: none; background: transparent; color: inherit; opacity: .5; cursor: pointer; font-size: 12px; line-height: 1; padding: 3px 5px; border-radius: 5px; }
.hg-popover-ignore:hover { opacity: 1; background: color-mix(in srgb, var(--ui-text-primary) 10%, transparent); }
.hg-popover-badge[data-kind="fabricated"], .hg-popover-badge[data-kind="unclear"] { color: var(--dt-destructive); border-color: color-mix(in srgb, var(--dt-destructive) 45%, transparent); opacity: 1; }
.hg-popover-context { margin: 0 0 6px; font-size: 12px; opacity: .72; }
.hg-popover-explain[data-weak="1"] { opacity: .8; font-style: italic; }
.hg-popover-explain { margin: 0 0 4px; }
.hg-popover-note { margin: 0 0 7px; font-size: 12px; opacity: .66; }
.hg-popover-questions { display: flex; flex-direction: column; gap: 3px; }
.hg-popover-q { display: flex; align-items: center; gap: 6px; }
.hg-popover-q-text { flex: 1; text-align: left; border: 0; background: transparent; padding: 3px 4px; margin-left: -4px; border-radius: 5px; color: inherit; font: inherit; cursor: pointer; }
.hg-popover-q-text:hover { background: color-mix(in srgb, var(--ui-text-primary) 8%, transparent); }
.hg-popover-icon { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; border: 1px solid var(--dt-border); background: transparent; color: inherit; opacity: .75; cursor: pointer; }
.hg-popover-icon:hover { opacity: 1; background: color-mix(in srgb, var(--ui-text-primary) 8%, transparent); }
.hg-settings { display: flex; flex-direction: column; gap: 14px; }
.hg-settings-row { display: flex; flex-direction: column; gap: 4px; }
.hg-settings-title { font-weight: 600; font-size: 13px; }
.hg-settings-hint { font-size: 12px; opacity: .7; }
`

function ensureStyle() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  // 每次都重写一次内容：插件热更新后旧样式不会残留在页面上
  style.textContent = STYLE_TEXT
}
// 把所有回复的高亮范围汇总起来再画一次，
// 保证页面上任意一条回复的词都还带着线。
function refreshHighlights() {
  if (disposed) return
  const termRanges = []
  const suspectRanges = []
  const slotTerm = []
  const slotSuspect = []
  for (let i = 0; i < FADE_SLOTS; i++) {
    slotTerm.push([])
    slotSuspect.push([])
  }
  const entries = []
  let sessionId = null
  for (const [element, item] of elementRanges) {
    // 只有明确脱离文档才清掉；测试替身没有 isConnected，不能当成已断开
    if (element.isConnected === false) {
      elementRanges.delete(element)
      appliedState.delete(element)
      continue
    }
    for (const holder of item.entries) {
      const suspect = holder.entry.kind === 'fabricated' || holder.entry.kind === 'unclear'
      // 死掉的 Range 不要登记进浏览器：Chrome 拿到指向已脱离文档的 Range
      // 会静默不画，登记也不会报错，只是标记凭空消失。
      const live = (holder.ranges || []).filter(range => rangeMatchesText(range, holder.entry.term))
      if (!live.length) continue
      // 正在淡入的词单独登记：颜色跟着该槽位的变量走
      const slot = fadingTerms.has(holder.key) ? fadingTerms.get(holder.key) : -1
      if (slot >= 0 && slot < FADE_SLOTS) {
        if (suspect) slotSuspect[slot].push(...live)
        else slotTerm[slot].push(...live)
      } else if (suspect) {
        suspectRanges.push(...live)
      } else {
        termRanges.push(...live)
      }
      entries.push({ ...holder, ranges: live, element, sessionId: item.sessionId })
    }
    if (!sessionId && item.sessionId) sessionId = item.sessionId
  }
  setHighlights(termRanges, suspectRanges, slotTerm, slotSuspect)
  hoverState.entries = entries
  hoverState.sessionId = sessionId
  syncOverlay()
}

// 浏览器原生高亮可用时，黄色底由浏览器自己画，
// 黄底和波浪线都交给浏览器跟随文字布局。
function supportsNativeHighlight() {
  const css = win.CSS
  if (!css || !css.highlights || typeof win.Highlight !== 'function') return false
  if (typeof css.supports === 'function') {
    try {
      return css.supports('selector(::highlight(hg-term))')
        && css.supports('selector(::highlight(hg-term-f0))')
    } catch (err) {
      return false
    }
  }
  return true
}

// 每组高亮登记前先和「浏览器里现在登记的那批范围」比签名：同样的节点、同样的偏移
// 就是同一批位置，位置没变不重新登记。每次 refreshHighlights 都换新 Highlight
// 会触发整页重绘，滚动或悬停时看起来就是标记在闪。
const nodeIds = new WeakMap()
let nodeSeq = 0

function nodeId(node) {
  if (!node || typeof node !== 'object') return '0'
  let id = nodeIds.get(node)
  if (!id) {
    nodeSeq += 1
    id = nodeSeq
    nodeIds.set(node, id)
  }
  return id
}

function rangesSignature(ranges) {
  return ranges
    .map(range => `${nodeId(range.startContainer)}:${range.startOffset}-${nodeId(range.endContainer)}:${range.endOffset}`)
    .join('|')
}

// 浏览器登记的 Highlight 里现在实际是哪些范围（真实 Highlight 可迭代，测试替身挂在 .ranges 上）
function highlightRanges(highlight) {
  if (!highlight) return []
  if (Array.isArray(highlight.ranges)) return highlight.ranges
  const out = []
  if (typeof highlight.forEach === 'function') highlight.forEach(range => out.push(range))
  return out
}

function registerHighlight(css, name, ranges) {
  const signature = ranges.length ? rangesSignature(ranges) : ''
  // 签名必须跟「浏览器里现在登记的那批范围」比，不能跟上次登记时的缓存比：
  // 原地改写文本节点会把已登记的 Range 折叠成 0 长度（浏览器行为，实测），
  // 重建出的新 Range 与当年的签名一模一样，按缓存比对会永远跳过重登记，
  // 标记就再也回不来。跟当前登记状态比，折叠过就能被发现并换掉。
  const current = css.highlights.get(name)
  if (current && rangesSignature(highlightRanges(current)) === signature) return
  if (!signature) {
    // 空组也注册一个空 Highlight：调用方总是能找到这个高亮名（排障与测试都依赖它），
    // 但只在从「有」变「空」的那一次写一次，不会每帧重建
    css.highlights.set(name, new win.Highlight())
    return
  }
  css.highlights.set(name, new win.Highlight(...ranges))
}

function setHighlights(termRanges, suspectRanges, slotTerm, slotSuspect) {
  const css = win.CSS
  if (!css || !css.highlights || typeof win.Highlight !== 'function') return
  try {
    registerHighlight(css, HIGHLIGHT_TERM, termRanges)
    // 疑似生造的词登记到另一个高亮名，样式里给它画波浪线
    registerHighlight(css, HIGHLIGHT_SUSPECT, suspectRanges)
    // 正在淡入的词按槽位登记：每个槽位一个高亮名，样式读各自的 --hg-fade-N
    for (let i = 0; i < FADE_SLOTS; i++) {
      registerHighlight(css, HIGHLIGHT_TERM + '-f' + i, slotTerm[i] || [])
      registerHighlight(css, HIGHLIGHT_SUSPECT + '-f' + i, slotSuspect[i] || [])
    }
  } catch (err) {
    // 浏览器不支持自定义高亮：只留 popover，不画线
  }
}


// 卸载时把自己写进页面的东西全部收回：根节点上的淡入系数、旧版本留下的颜色变量、
// 覆盖层与残留弹层。只留 app 自己的 DOM，插件痕迹清零。
// 从页面上摘掉自己写的节点：真实 DOM 有 parentNode，测试替身只有 parentElement
function detach(node) {
  if (!node) return
  const parent = node.parentNode || node.parentElement
  if (parent && typeof parent.removeChild === 'function') parent.removeChild(node)
}

function removeOwnDom() {
  const root = document.documentElement
  if (root && root.style && typeof root.style.removeProperty === 'function') {
    for (let i = 0; i < FADE_SLOTS; i += 1) root.style.removeProperty('--hg-fade-' + i)
    root.style.removeProperty('--hg-term-line')
    root.style.removeProperty('--hg-wave')
    root.style.removeProperty('--hg-term-line-soft')
    root.style.removeProperty('--hg-term-bg')
  }
  detach(document.getElementById(HL_ID))
  for (const node of Array.from(document.querySelectorAll('.hg-popover'))) detach(node)
}

function clearMarksState() {
  elementRanges.clear()
  appliedState.clear()
  analyses.clear()
  replyStability.clear()
  seenReplyTexts.clear()
  hoverState.entries = []
  hoverState.rects = []
}

function clearHighlights() {
  elementRanges.clear()
  appliedState.clear()
  hoverState.entries = []
  clearOverlay()
  const css = win.CSS
  if (!css || !css.highlights) return
  try {
    css.highlights.delete(HIGHLIGHT_TERM)
    css.highlights.delete(HIGHLIGHT_SUSPECT)
    for (let i = 0; i < FADE_SLOTS; i++) {
      css.highlights.delete(HIGHLIGHT_TERM + '-f' + i)
      css.highlights.delete(HIGHLIGHT_SUSPECT + '-f' + i)
    }
  } catch (err) {
    // ignore
  }
}

// 主题跟随 app 自己的深浅色（html.dark / data-theme），没有再看系统偏好
function detectTheme() {
  const root = document.documentElement
  if (root && root.classList && typeof root.classList.contains === 'function') {
    if (root.classList.contains('dark')) return 'dark'
    if (root.classList.contains('light')) return 'light'
  }
  const className = (root && root.className) || ''
  const dataTheme = (root && root.getAttribute && root.getAttribute('data-theme')) || ''
  const dataset = (root && root.dataset) || {}
  if (dataset.hermesMode === 'dark' || dataset.hermesMode === 'light') return dataset.hermesMode
  if (/\bdark\b/.test(className) || dataTheme === 'dark' || dataset.theme === 'dark') return 'dark'
  if (/\blight\b/.test(className) || dataTheme === 'light' || dataset.theme === 'light') return 'light'
  return win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// ─── popover ─────────────────────────────────────────────────────────────
const popover = { el: null, hideTimer: 0, term: null, over: false, element: null, rectTop: 0 }

function ensurePopover() {
  if (popover.el) return popover.el
  const el = document.createElement('div')
  el.className = 'hg-popover'
  el.setAttribute('role', 'dialog')
  el.style.display = 'none'
  el.addEventListener('mouseenter', () => {
    popover.over = true
    if (popover.hideTimer) {
      cancelTimer(popover.hideTimer)
      popover.hideTimer = 0
    }
  })
  el.addEventListener('mouseleave', () => {
    popover.over = false
    scheduleHide()
  })
  document.body.appendChild(el)
  popover.el = el
  return el
}

// 未命中后的隐藏时机：第一次未命中就定死截止时间。
// 早先的写法每次 mousemove 都重置定时器（debounce），
// 结果是鼠标移出去后只要还在动，隐藏就被一次次往后推，
// 看起来就是「弹窗延迟好久才消失」；鼠标完全停下后反倒立刻消失。
// 鼠标移出窗口后 mousemove 不再触发，弹窗则会一直挂着。
const POPOVER_HIDE_MS = 140

function scheduleHide() {
  // 已经有截止时间在跑，就不推后它
  if (popover.hideTimer) return
  popover.hideTimer = later(() => {
    popover.hideTimer = 0
    if (popover.el) popover.el.style.display = 'none'
  }, POPOVER_HIDE_MS)
}

function scheduleHideNow() {
  cancelTimer(popover.hideTimer)
  popover.hideTimer = 0
  if (popover.el) popover.el.style.display = 'none'
  popover.term = null
  popover.over = false
}

const hidePopoverNow = scheduleHideNow

// 图标按钮：纯 SVG，用 createElementNS 拼，不走 innerHTML
function buildFillIcon() {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('width', '13')
  svg.setAttribute('height', '13')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const down = document.createElementNS(ns, 'path')
  down.setAttribute('d', 'M8 2v8')
  const arrow = document.createElementNS(ns, 'path')
  arrow.setAttribute('d', 'M4.5 6.5 8 10l3.5-3.5')
  const base = document.createElementNS(ns, 'path')
  base.setAttribute('d', 'M2.5 12.5h11')
  svg.appendChild(down)
  svg.appendChild(arrow)
  svg.appendChild(base)
  return svg
}

function renderPopover(entry, rect, sessionId) {
  const el = ensurePopover()
  const t = ctxI18nT
  const kind = normalizeKind(entry.kind)
  const badgeLabel =
    kind === 'fabricated'
      ? t('kindFabricated')
      : kind === 'unclear'
        ? t('kindUnclear')
        : kind === 'abbrev'
          ? t('kindAbbrev')
          : t('kindTerm')
  const questions = Array.isArray(entry.questions)
    ? entry.questions.filter(q => typeof q === 'string' && q.trim()).slice(0, 2)
    : []
  el.textContent = ''
  // 先显示再量尺寸：隐藏状态下量到的高度是 0，
  // 位置会算错，弹窗直接盖住术语，高亮看起来就“消失”了。
  el.style.display = 'block'
  el.style.visibility = 'hidden'

  const head = document.createElement('div')
  head.className = 'hg-popover-head'
  const name = document.createElement('span')
  name.className = 'hg-popover-term'
  name.textContent = entry.term
  const badge = document.createElement('span')
  badge.className = 'hg-popover-badge'
  badge.setAttribute('data-kind', kind)
  badge.textContent = badgeLabel
  const spacer = document.createElement('span')
  spacer.className = 'hg-popover-spacer'
  const ignoreBtn = document.createElement('button')
  ignoreBtn.type = 'button'
  ignoreBtn.className = 'hg-popover-ignore'
  ignoreBtn.title = t('ignoreTitle')
  ignoreBtn.setAttribute('aria-label', t('ignoreTitle'))
  ignoreBtn.textContent = t('ignoreAction')
  ignoreBtn.addEventListener('click', () => {
    ignoreTerm(entry.term)
    scheduleHideNow()
  })
  head.appendChild(name)
  head.appendChild(badge)
  head.appendChild(spacer)
  head.appendChild(ignoreBtn)

  const explain = document.createElement('p')
  explain.className = 'hg-popover-explain'
  // 解释要「在这段话里指什么、是干嘛的」。空白或一句带过的解释不如不装懂：
  // 直接说没讲清，把追问留给用户
  const explainText = String(entry.explain || '').trim()
  if (explainText.length >= 6) {
    explain.textContent = explainText
  } else {
    explain.textContent = t('explainWeak')
    explain.setAttribute('data-weak', '1')
  }

  el.appendChild(head)
  el.appendChild(explain)

  if (entry.note) {
    const note = document.createElement('p')
    note.className = 'hg-popover-note'
    note.textContent = `${t('noteLabel')}: ${entry.note}`
    el.appendChild(note)
  }

  if (questions.length) {
    const wrap = document.createElement('div')
    wrap.className = 'hg-popover-questions'
    for (const question of questions) {
      const row = document.createElement('div')
      row.className = 'hg-popover-q'
      const text = document.createElement('button')
      text.type = 'button'
      text.className = 'hg-popover-q-text'
      text.textContent = question
      text.addEventListener('click', () => fillComposer(question, sessionId))
      const icon = document.createElement('button')
      icon.type = 'button'
      icon.className = 'hg-popover-icon'
      icon.title = t('fillTitle')
      icon.setAttribute('aria-label', t('fillTitle'))
      icon.appendChild(buildFillIcon())
      icon.addEventListener('click', () => fillComposer(question, sessionId))
      row.appendChild(text)
      row.appendChild(icon)
      wrap.appendChild(row)
    }
    el.appendChild(wrap)
  }

  positionPopover(el, rect)
  el.style.visibility = 'visible'
  popover.term = entry.term
}

function positionPopover(el, rect) {
  const margin = 8
  const box = el.getBoundingClientRect()
  const maxHeight = Math.max(80, win.innerHeight - margin * 2)
  let top = rect.top - box.height - margin
  // 上方放不下就放下方；下方也放不下就贴住视口底
  if (top < margin) top = rect.bottom + margin
  if (top + box.height > win.innerHeight - margin) {
    top = Math.max(margin, win.innerHeight - box.height - margin)
  }
  if (box.height > maxHeight) {
    el.style.maxHeight = `${maxHeight}px`
    el.style.overflowY = 'auto'
  }
  let left = rect.left
  if (left + box.width > win.innerWidth - margin) left = win.innerWidth - box.width - margin
  if (left < margin) left = margin
  el.style.top = `${Math.round(top)}px`
  el.style.left = `${Math.round(left)}px`
}

// 只填输入框，不发送
async function fillComposer(text, sessionId) {
  const focused = host.state.focusedSessionId && host.state.focusedSessionId.get ? host.state.focusedSessionId.get() : null
  const target = sessionId || focused || null
  try {
    const ok = await host.composer.insertText(target, text, { mode: 'block' })
    if (!ok && target) await host.composer.insertText(null, text, { mode: 'block' })
  } catch (err) {
    host.notify({ kind: 'error', message: ctxI18nT('fillFailed') })
  }
}

// ─── 悬停命中检测 ────────────────────────────────────────────────────────
const hoverState = { entries: [], rects: [], dirty: true, sessionId: null }
// 指针最后停在哪：滚动和新动态发生时靠它判断指针还在不在词上，
// 不能因为「页面动了」就把用户正看着的解释收掉
let lastPointer = null

function refreshRects() {
  hoverState.rects = []
  for (const item of hoverState.entries) {
    if (isIgnored(item.entry.term)) continue
    const fragments = []
    for (const range of item.ranges) {
      if (!rangeMatchesText(range, item.entry.term)) continue
      for (const rect of rangeRects(range)) fragments.push({ rect, range })
    }
    if (fragments.length) hoverState.rects.push({ ...item, fragments })
  }
  hoverState.dirty = false
}

// 指针下面到底是哪个字符：浏览器把坐标换算成文本偏移。
// 指针在词的字形上，偏移就落在词的范围内；落在别的字上就不是。
function caretAt(x, y) {
  if (typeof document.caretPositionFromPoint === 'function') {
    const pos = document.caretPositionFromPoint(x, y)
    if (!pos) return null
    return { node: pos.offsetNode, offset: pos.offset }
  }
  if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(x, y)
    if (!range) return null
    return { node: range.startContainer, offset: range.startOffset }
  }
  return undefined
}

// 光标偏移是否落在这个词里。落在同一个文本节点但不在词内，明确拒绝；
// 词跨了多个文本节点时无法逐字核对，放行给矩形命中兜底。
function caretInsideTerm(caret, range) {
  if (!caret || !caret.node) return true
  const start = range.startContainer
  const end = range.endContainer
  if (!start || !end) return true
  if (typeof range.isPointInRange === 'function') return range.isPointInRange(caret.node, caret.offset)
  if (start !== end) return true
  if (caret.node !== start) return false
  return caret.offset >= range.startOffset && caret.offset <= range.endOffset
}

function hitTest(x, y) {
  refreshRects()
  const caret = caretAt(x, y)
  const top = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : undefined
  for (const group of hoverState.rects) {
    for (const { rect, range } of group.fragments) {
      // 高光本身没有事件节点，逐行严格命中，不扩大两像素，也不跨行连空白。
      if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) continue
      // 指针必须落在词的字形上：光是落在词的包围盒里不算。
      if (caret === null) continue
      if (!caretInsideTerm(caret, range)) continue
      if (top !== undefined) {
        if (!top || !group.element || !group.element.contains(top)) continue
      }
      return { ...group, rect, range }
    }
  }
  return null
}

// 词现在还在屏幕上的哪一段：跨行时挑离弹层原位置最近的一段，
// 已经滚出视口的那段不算，免得弹层贴着屏幕边、词却看不见
function anchorRect(term) {
  refreshRects()
  let nearest = null
  let nearestDistance = Infinity
  let fallback = null
  let fallbackDistance = Infinity
  for (const group of hoverState.rects) {
    if (group.entry.term !== term) continue
    for (const { rect } of group.fragments) {
      if (rect.bottom <= 0 || rect.top >= win.innerHeight) continue
      if (rect.right <= 0 || rect.left >= win.innerWidth) continue
      const distance = Math.abs(rect.top - popover.rectTop)
      if (!popover.element || group.element === popover.element) {
        if (distance < nearestDistance) {
          nearest = rect
          nearestDistance = distance
        }
      } else if (distance < fallbackDistance) {
        fallback = rect
        fallbackDistance = distance
      }
    }
  }
  return nearest || fallback
}

// 滚动、重挂之后弹层该留还是该收：看指针在哪，不看「页面有没有动」。
// 早先一见 scroll / sessions.changed 就 hidePopoverNow()，下一条回复流式输出时
// 会话区一路自动滚动，用户刚悬停出来的弹层每个滚动事件都被打掉一次。
// 现在的口径：
//   指针在弹层里 → 原地不动（挪开就从光标底下跑掉了）；
//   指针还在词上 → 跟着词的新位置走；
//   指针在词和弹层之间、或者词被流式滚动带走 → 冻在原地，等用户把鼠标移上来；
//   词整段滚出视口、切会话导致词没了 → 收掉。
function resyncPopover(detachedCheck) {
  if (!popover.el || popover.el.style.display === 'none' || !popover.term) return
  if (popover.over) {
    if (detachedCheck && !anchorRect(popover.term)) hidePopoverNow()
    return
  }
  if (lastPointer) {
    const hit = hitTest(lastPointer.x, lastPointer.y)
    if (hit) {
      // 指针已经落在别的词上：这份解释过期了，收掉等下一次悬停重开
      if (hit.entry.term !== popover.term) {
        hidePopoverNow()
        return
      }
      popover.element = hit.element
      popover.rectTop = hit.rect.top
      positionPopover(popover.el, hit.rect)
      return
    }
  }
  if (!anchorRect(popover.term)) hidePopoverNow()
}

// ─── 分析与标注 ──────────────────────────────────────────────────────────
const analyses = new Map()
// 注册时已在页面上的回复：不重复花 token，只用标记表标一遍
const seenReplyTexts = new Set()
// 每条回复当前文本 + 最后一次变化时间，用来判断流式输出是否结束
const replyStability = new Map()
// 每条回复各自的高亮范围，最后汇总成一份再交给浏览器
const elementRanges = new Map()
// 每个元素已经画过哪一版：内容没变就不重画，避免闪烁
const appliedState = new Map()
// 已经见过的回复元素，避免重复读文本
const knownElements = new WeakSet()
// 已经用原始文本分析过的回复尾部，用来避免 DOM 路径重复花钱
const analyzedTails = []
const pending = []
let debounceTimer = 0
let observer = null
let domTimer = 0
let pollTimer = 0
let reanchorRetryTimer = 0
let inFlight = false

// 插件自己写进页面的节点：观察器要跳过，否则会自激。
// popover 每次换内容都会产生一批文本节点，旧写法只认元素本身，
// 文本节点被当成「页面变了」，悬停一次就触发全量重锚 + 重画，页面一直在抖。
function isOwnNode(node) {
  let cur = node
  for (let depth = 0; depth < 8 && cur; depth += 1) {
    if (cur.id === HL_ID || cur.id === STYLE_ID) return true
    if (cur.classList && typeof cur.classList.contains === 'function') {
      if (cur.classList.contains('hg-overlay')) return true
      if (cur.classList.contains('hg-popover')) return true
    }
    // 旧宿主/测试替身没有 classList.contains：直接看 className 字符串
    if (typeof cur.className === 'string' && /(^|\s)hg-(overlay|popover)(\s|$)/.test(cur.className)) return true
    cur = cur.parentElement || cur.parentNode || null
  }
  return false
}

function assistantElements() {
  return [...document.querySelectorAll('[data-role="assistant"]')]
}

function markdownRoot(element) {
  // 思考过程（thinking 折叠块）不标：推理正文虽然也走 .aui-md，
  // 但包在 data-conversation-scaffold 脚手架里，正文不带这个标记。
  // 思考块在前、正文在后是常态：跳过思考块继续找，而不是直接放弃。
  if (typeof element.querySelectorAll !== 'function') return element.querySelector('.aui-md') || element
  const blocks = element.querySelectorAll('.aui-md')
  for (const block of blocks) {
    let up = block.parentElement
    let inScaffold = false
    while (up && up !== element) {
      // 该属性在真实 DOM 里是空字符串，必须用 hasAttribute 判断存在性
      if (typeof up.hasAttribute === 'function') {
        if (up.hasAttribute('data-conversation-scaffold')) {
          inScaffold = true
          break
        }
      } else if (up.getAttribute) {
        const value = up.getAttribute('data-conversation-scaffold')
        if (value !== null && value !== undefined) {
          inScaffold = true
          break
        }
      }
      up = up.parentElement
    }
    if (!inScaffold) return block
  }
  return null
}

// 尾部锚点：原始 markdown 和渲染文本只差语法字符（**、`、#、换行）和段落处的空格，
// 比较前把这些都抹掉，网关事件和 DOM 路径才能认出同一条回复。
// 不抹的话锚点里带着 ** 或空格，渲染文本永远对不上，兜底定位整体失效。
function tailAnchor(text) {
  // 指令行（::hmw、::preview 这类）不进锚点：网关事件带原始指令行，页面上没有，
  // 不抹掉的话两边的锚永远对不上，同一条回复会被当成两条各分析一次
  return normalizeText(maskMarkDirectives(text)).replace(/[#*_`~[\]()!>]/g, '').replace(/\s+/g, '').slice(-40)
}

// 找出这段回复对应的助手消息容器：先按术语命中数打分，
// 再用回复尾部文本做加权（渲染后的文本和原始 markdown 不完全一样，尾部是最稳的锚）。
function locateAssistantElement(replyText, terms) {
  const elements = assistantElements()
  if (!elements.length) return null
  const tail = tailAnchor(replyText)
  let best = null
  let bestScore = 0
  let ties = 0
  for (const element of elements) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim()) continue
    let score = 0
    // 尾部锚点最可靠：正文里出现同一个词的多条回复会被误伤
    if (tail && tailAnchor(text).includes(tail)) score += 100
    for (const term of terms) {
      if (textHasTerm(text, term.term)) score += 2
    }
    if (score > bestScore) {
      best = element
      bestScore = score
      ties = 1
    } else if (score === bestScore && score > 0) {
      ties += 1
    }
  }
  // 多条回复并列分不清是哪一条（包括同尾的情况）：
  // 宁可返回 null 交给按词命中的兜底，也不把波浪线画到别的消息上。
  if (bestScore > 0 && ties > 1) return null
  return bestScore > 0 ? best : null
}

function ensureObserver() {
  if (observer) return
  observer = new MutationObserver(records => {
    // 插件自己往页面里写的覆盖层和 popover 也会触发观察器。
    // 不挡掉的话就是自己触发自己：高亮刚画上就被重画，页面一直在抖。
    const relevant = records.some(record => {
      if (!isOwnNode(record.target)) return true
      const added = record.addedNodes || []
      for (const node of added) {
        if (!isOwnNode(node)) return true
      }
      return false
    })
    if (!relevant) return
    // 关键：同步重锚，不等防抖。
    // React 重渲染会把旧回复的文本节点换掉，挂在旧节点上的 Range 立刻失效，
    // 浏览器当帧就不再画那段黄底。MutationObserver 回调是微任务，
    // 早于浏览器绘制：在这里把 Range 重新按文字定位好，下一帧照常画，
    // 中间不会出现「标记消失一下」的空白帧。
    reanchorRanges()
    if (domTimer) return
    // 防抖只留给「要不要重新分析这条回复」这类判断，
    // 重建高亮已经在上面同步做完了。
    domTimer = later(() => {
      domTimer = 0
      // 文本节点被换掉后，旧的命中矩形会指到别的词上
      hoverState.dirty = true
      reapplyAll()
      detectNewReplies()
    }, 60)
  })
  // characterData 也要听：React 重渲染常常原地改写文本节点内容，
  // 只听 childList 的话这类改写根本收不到，旧高亮就留在错位置。
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
  // 轮询兜底：流式输出停止后即使没有 DOM 变动，也能及时把这条回复标上
  pollTimer = every(() => {
    if (disposed || !settings.enabled) return
    detectNewReplies()
  }, POLL_MS)
}

// DOM 兜底：网页上出现了新的助手回复就分析一次。
// 网关事件不一定送到渲染进程（多窗口、事件订阅范围），DOM 是最可靠的事实来源。
function detectNewReplies() {
  if (disposed || !settings.enabled) return
  const now = Date.now()
  const elements = assistantElements()
  // 只有最后一条回复会边流边变；其余历史回复不再重复读文本，
  // 免得长会话里每 700ms 都把整段 DOM 扫一遍。
  const last = elements.length ? elements[elements.length - 1] : null
  for (const element of elements) {
    const isLast = element === last
    if (!isLast && knownElements.has(element)) continue
    if (!isLast) knownElements.add(element)
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim() || text.trim().length < MIN_REPLY_CHARS) continue
    const state = replyStability.get(element)
    if (!state || state.text !== text) {
      // 文字还在变（流式输出）：先记下来，等它安静下来再说
      replyStability.set(element, { text, changedAt: now })
      continue
    }
    if (now - state.changedAt < STREAM_SETTLE_MS) continue
    // 签名一律用「抹掉指令行」后的正文算：网关事件带原始指令行、页面上没有，
    // 两边的签名必须落在同一个口径上，否则同一条回复会被认成两条
    const sig = hashString(normalizeText(stripMarkDirectives(text)))
    if (seenReplyTexts.has(sig)) continue
    seenReplyTexts.add(sig)
    // 回复自带标记块：解析指令是纯本地计算，当场标注，一次模型调用都不发。
    // 网关事件没送到、或者送到之前 DOM 兜底先醒了，都不会再花辅助模型的钱。
    // 注意：text 是抹掉指令行的索引文本，原始指令行要从 textContent 里解析
    const inband = parseMarkDirectives(String((root && root.textContent) || ''))
    if (inband.length) {
      void applyInband(inband, stripMarkDirectives(text), null, element)
      continue
    }
    if (analyses.has(sig)) {
      const known = analyses.get(sig)
      if (!known.element) known.element = element
      void applyWithRetry(text, known.terms, known)
      continue
    }
    // 这段正文在标记表里：按记忆重标，不再问模型
    const remembered = storedMarksFor(text)
    if (remembered && remembered.length) {
      const analysis = {
        terms: remembered.map(item => ({ ...item, tier: settings.tier })),
        replyText: stripMarkDirectives(text),
        sessionId: null,
        tier: settings.tier,
        element
      }
      analyses.set(sig, analysis)
      void applyWithRetry(text, analysis.terms, analysis)
      continue
    }
    // 网关事件已经用原始文本分析过同一条回复，就不要再花钱分析一次
    if (alreadyAnalyzedByEvent(text)) continue
    diag('analyzed.dom', { chars: text.length, tier: settings.tier })
    void analyzeReply(text, null, element)
  }
}

// 网关事件（message.complete）拿到的文本和页面上渲染出来的文本不完全一样，
// 但尾部通常一致，用尾部判断「这条回复已经花过钱」。
function alreadyAnalyzedByEvent(text) {
  const tail = tailAnchor(text)
  if (!tail) return false
  return analyzedTails.some(item => item && (tail.includes(item) || item.includes(tail)))
}

// 注册时把页面上已有的回复记下来，避免一上来就把历史回复全分析一遍
function snapshotExistingReplies() {
  for (const element of assistantElements()) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim()) continue
    seenReplyTexts.add(hashString(normalizeText(stripMarkDirectives(text))))
  }
}

// 同步重锚：DOM 变动后立刻把高亮 Range 按文字重新定位。
// 只做「找回同一个词的 Range」这一件事，不动分析结果、不调模型。
function reanchorRanges() {
  if (disposed || !elementRanges.size) return
  let changed = false
  for (const [element, item] of Array.from(elementRanges)) {
    if (!item || !item.entries || !item.entries.length) continue
    if (rangesStillValid(item)) continue
    // 容器本身被 React 换掉了：按之前的分析结果重新找这条回复
    let target = element
    let recovered = null
    if (element.isConnected === false) {
      recovered = analysisForElement(element)
      // 没有进程内分析记录（例如插件刚重载、标记来自标记表）：
      // 直接从标记表按正文找回，这样旧回复的标记不会因为换了容器就永久消失
      if (!recovered) recovered = analysisFromStoredMarks(element, item.sessionId)
      if (recovered && !analysisForElement(element)) {
        analyses.set(hashString(normalizeText(recovered.replyText)), recovered)
      }
      const analysis = recovered
      if (!analysis) {
        // 找不回来：旧记录只会让 hover 命中旧坐标，直接清掉
        elementRanges.delete(element)
        appliedState.delete(element)
        changed = true
        continue
      }
      const located = locateAssistantElement(analysis.replyText, analysis.terms) || locateByTerms(analysis.terms)
      if (!located) continue
      target = located
    }
    const root = markdownRoot(target)
    if (!root) continue
    // 逐词重建：某个词在这次输出里被删掉了，只撤它自己，
    // 其他词照样要重新定位。否则一个词消失会带走整条回复的标记。
    const rebuilt = []
    const markable = markableText(root)
    let hasPending = false
    for (const holder of item.entries) {
      const found = findTermRanges(root, holder.entry.term)
      if (found.length) {
        rebuilt.push({ ...holder, ranges: found })
        continue
      }
      // 瞬态：React 正在换文本节点，这轮建不出 Range 但词还在正文里。
      // 直接丢弃的话标记会在重渲染里凭空消失，且签名没变、永远回不来
      if (textHasTerm(markable, holder.entry.term)) {
        rebuilt.push({ ...holder, ranges: [], pending: true })
        hasPending = true
        console.error('[hermes-mark-words] reanchor pending:', holder.entry.term)
      }
    }
    if (hasPending && !reanchorRetryTimer) {
      // 等文本节点换完再补一轮；只由 DOM 变动触发，不会自己转圈
      reanchorRetryTimer = later(() => {
        reanchorRetryTimer = 0
        reapplyAll()
        hoverState.dirty = true
      }, DOM_RETRY_MS)
    }
    if (!rebuilt.length) {
      // 一个词都找不回来：这条回复的正文已经整个换掉了，撤掉旧记录
      elementRanges.delete(target)
      appliedState.delete(target)
      changed = true
      continue
    }
    const mergedTermRanges = []
    const mergedSuspectRanges = []
    for (const holder of rebuilt) {
      const kind = holder.entry.kind === 'fabricated' || holder.entry.kind === 'unclear'
      if (kind) mergedSuspectRanges.push(...holder.ranges)
      else mergedTermRanges.push(...holder.ranges)
    }
    elementRanges.set(target, {
      termRanges: mergedTermRanges,
      suspectRanges: mergedSuspectRanges,
      entries: rebuilt,
      sessionId: item.sessionId,
      nodes: [...mergedTermRanges, ...mergedSuspectRanges].map(range => range.startContainer)
    })
    if (target !== element) {
      elementRanges.delete(element)
      appliedState.delete(element)
      if (recovered) recovered.element = target
    }
    changed = true
  }
  if (changed) {
    refreshHighlights()
    hoverState.dirty = true
  }
}

// 找回当初挂在某个元素上的那条分析
function analysisForElement(element) {
  for (const analysis of analyses.values()) {
    if (analysis.element === element) return analysis
  }
  return null
}

// 从每回复标记表恢复一条分析记录：元素已经脱离文档也能读出它的正文
function analysisFromStoredMarks(element, sessionId) {
  const root = markdownRoot(element) || element
  if (!root) return null
  const text = plainText(root)
  if (!text.trim()) return null
  const terms = storedMarksFor(text)
  if (!terms || !terms.length) return null
  return {
    terms: terms.map(item => ({ ...item, tier: settings.tier })),
    replyText: text,
    sessionId: sessionId || null,
    tier: settings.tier,
    element: null
  }
}

function reapplyAll() {
  if (disposed) return
  for (const analysis of analyses.values()) {
    // 旧元素还在但 Range 已经失效：重建后浏览器才画得出来
    const stale = elementRanges.get(analysis.element)
    if (stale && !rangesStillValid(stale)) appliedState.delete(analysis.element)
    // 优先用当初定位到的那个元素：页面上常有多个含相同词的回复，
    // 重新定位会标到别的消息上去，那就是「标错位置」。
    const remembered = analysis.element
    if (remembered && remembered.isConnected !== false && containsTerms(remembered, analysis.terms)) {
      applyAnalysis(remembered, analysis)
      continue
    }
    const element = locateAssistantElement(analysis.replyText, analysis.terms)
    if (element) {
      analysis.element = element
      applyAnalysis(element, analysis)
      continue
    }
    // 兜底：原文尾部锚点在 Markdown 重渲染后可能对不上，
    // 这时按「命中术语最多」重新找容器，避免高亮随重渲染一起消失。
    const fallback = locateByTerms(analysis.terms)
    if (fallback) {
      analysis.element = fallback
      applyAnalysis(fallback, analysis)
      continue
    }
    // 这条回复在页面上已经不存在了：把旧标记撤掉，
    // 不撤的话旧 Range 会留在别处，鼠标移过去就乱弹解释。
    // 判断依据是「这段文字里还有没有这个词」：
    // 词还在 → 只是 React 正在重渲染，下一轮就会原地重建，不能删；
    // 词没了 → 标记确实失效，必须撤。
    if (remembered && !containsTerms(remembered, analysis.terms)) {
      elementRanges.delete(remembered)
      appliedState.delete(remembered)
      refreshHighlights()
      hoverState.dirty = true
    }
  }
  // 同 remountAllMarks：早退路径不动 hoverState，每轮收尾统一同步一次
  refreshHighlights()
  hoverState.dirty = true
}

// 这个元素里是不是还带着这些词（重渲染后内容可能变了）
function containsTerms(element, terms) {
  const root = markdownRoot(element)
  if (!root) return false
  const text = plainText(root)
  if (!text.trim()) return false
  return terms.some(term => textHasTerm(text, term.term))
}

// 只按术语命中数找容器，用来兜底锚点失效的情况
function locateByTerms(terms) {
  const elements = assistantElements()
  let best = null
  let bestScore = 0
  for (const element of elements) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim()) continue
    let score = 0
    for (const term of terms) {
      if (textHasTerm(text, term.term)) score += 1
    }
    if (score > bestScore) {
      bestScore = score
      best = element
    }
  }
  return bestScore > 0 ? best : null
}

// 缓存的 Range 还活着吗：节点还在文档里，而且指着的文字还就是这个词。
// React 原地改写文本节点时节点仍然 connected，只有核对文字才能发现偏移漂了。
// 失效就返回 false，applyAnalysis 会丢弃重建，标记不再画在旧坐标上。
function rangesStillValid(item) {
  if (!item || !item.entries || !item.entries.length) return true
  for (const holder of item.entries) {
    const term = holder.entry && holder.entry.term
    if (!term) continue
    for (const range of holder.ranges || []) {
      if (!range) return false
      if (!rangeMatchesText(range, term)) return false
    }
  }
  return true
}

function applyAnalysis(element, analysis) {
  if (disposed) return
  const termRanges = []
  const suspectRanges = []
  const entries = []
  const root = markdownRoot(element)
  if (!root) return
  const text = plainText(root)
  const markable = markableText(root)
  const terms = analysis.terms || []
  // 页面内容没变就别重画：重画会让高亮闪一下，流式输出时尤其明显。
  // 签名带标记类型：同一词从「词」改判「生造」是结论变化，不是重复，
  // 只看词名会把这份修正当成重复丢掉，怀疑标记就永远改不过来
  const signature = `${hashString(text)}:${terms.filter(item => !isIgnored(item.term)).map(item => `${item.term}:${markKind(item)}`).join(',')}`
  const applied = appliedState.get(element)
  if (applied && applied.signature === signature) {
    // 签名没变也可能是旧 Range：React 原地改写文本节点不改文本内容，
    // 但节点换过/改写过的话 Range 早就漂了。节点身份变了就重建。
    // 还挂着「词在正文里但没有 Range」的待补条目时同样要重建，
    // 否则那几个词在签名不变期间永远回不来
    const item = elementRanges.get(element)
    const incomplete = item && (item.entries || []).some(holder => !(holder.ranges || []).length)
    if (item && (!rangesStillValid(item) || incomplete)) {
      appliedState.delete(element)
    } else {
      return
    }
  }
  const sessionId = analysis.sessionId
  const nativeHl = supportsNativeHighlight()
  // 同一段回复可能被两条路径各分析一次（网关事件一次、DOM 兜底一次），
  // 两条分析的词表不一定相同。整段覆盖会让先标上的词整批消失，
  // 表现就是「黄色标记和波浪线时有时无」。这里按词合并：本次没有的词保留旧记录。
  const incoming = new Set(terms.map(item => item.term))
  const previous = elementRanges.get(element)
  if (previous) {
    for (const holder of previous.entries || []) {
      const term = holder.entry && holder.entry.term
      if (!term || incoming.has(term)) continue
      if (isIgnored(term)) continue
      // 词确实从这段文字里消失了才撤，Range 失效但词还在的等下一轮重建
      if (!textHasTerm(text, term)) continue
      if (!rangesStillValid({ entries: [holder] })) continue
      entries.push(holder)
    }
  }
  let batchSlot = null
  for (const item of terms) {
    if (isIgnored(item.term)) continue
    const found = findTermRanges(root, item.term)
    if (!found.length) {
      // 词还在正文里但这次没找到 Range：多半是 React 正在重写文本节点，
      // 旧 Range 等下一轮重锚。这种情况不能当词删了，否则重一轮标记就丢一轮
      const prior = previous && (previous.entries || []).find(holder => holder.entry && holder.entry.term === item.term)
      if (prior && textHasTerm(markable, item.term)) entries.push(prior)
      continue
    }
    const kind = markKind(item)
    // 淡入身份只认词、不认类型：同一词从「词」改判「生造」不该再淡入一次。
    // 跟着类型走的话每次改判都重新淡入，就是「第二标记一直抖」的直接来源
    const key = termKey(sessionId, 'mark', item.term)
    entries.push({ entry: item, ranges: found, key })
    // 覆盖层兜底路径（浏览器不支持原生高亮）需要完整的范围表
    if (kind === 'suspect') suspectRanges.push(...found)
    else termRanges.push(...found)
    if (!nativeHl) continue
    // 第一次出现的词开始淡入；淡完的词以后重建 Range 不再闪一次
    if (!fadingTerms.has(key) && !settledTerms.has(key)) {
      batchSlot = startFadeFor(key, batchSlot)
    }
  }
  // 一个词都找不到：说明这条回复已经改写过了，旧标记必须撤掉，
  // 否则会留在已经不存在的文字上（漂移的波浪线就是这么来的）。
  // 但「词还在文字里、只是这次没找到 Range」是重渲染瞬态，不能撤：
  // 撤了再没有下一轮 mutation 的话，标记就整个消失了，看起来像插件时灵时不灵
  if (!entries.length && terms.length) {
    if (terms.some(item => textHasTerm(markable, item.term))) return
    elementRanges.delete(element)
    appliedState.delete(element)
    refreshHighlights()
    hoverState.dirty = true
    return
  }
  // 按元素记住各自的高亮范围。页面上常常同时有多条回复，
  // 如果每次都整体覆盖，只有最后处理的那条还留着线。
  // 汇总范围也要按合并后的词表算，否则兜底覆盖层只画本次这一批词
  const mergedTermRanges = []
  const mergedSuspectRanges = []
  for (const holder of entries) {
    const kind = holder.entry.kind === 'fabricated' || holder.entry.kind === 'unclear'
    if (kind) mergedSuspectRanges.push(...holder.ranges)
    else mergedTermRanges.push(...holder.ranges)
  }
  elementRanges.set(element, {
    termRanges: mergedTermRanges,
    suspectRanges: mergedSuspectRanges,
    entries,
    sessionId,
    // 记下当初的文本节点身份：React 重渲染后同一元素的文本节点常被换新，
    // 身份对不上就说明手里的 Range 全部过期。
    nodes: [...mergedTermRanges, ...mergedSuspectRanges].map(range => range.startContainer)
  })
  appliedState.set(element, { signature })
  refreshHighlights()
  hoverState.dirty = true
  // 新标上的词淡入，帧循环只更新系数
  ensureFadeLoop()
  // 运行痕迹：桌面端可以直接回读，确认这一轮真的标上了
  if (storage) {
    const nativeHl = supportsNativeHighlight()
    // 自检：每个登记进浏览器的 Range 现在指的还是不是这个词。
    // 全部对上才算「标记钉在词上」，对不上就是漂了。
    const registry = win.CSS && win.CSS.highlights
    const registered = registry && typeof registry.get === 'function'
      ? registry.get(HIGHLIGHT_TERM)
      : null
    let anchored = true
    for (const holder of entries) {
      const term = holder.entry.term
      for (const range of holder.ranges) {
        if (!rangeMatchesText(range, term)) anchored = false
      }
    }
    storage.set('lastRun', {
      at: Date.now(),
      tier: analysis.tier,
      matched: entries.length,
      terms: entries.map(item => item.entry.term).slice(0, 12),
      // 排障用：主题、原生高亮是否可用、浏览器里登记了几个高亮范围
      theme: detectTheme(),
      native: nativeHl,
      // 标记有没有钉在词上、浏览器里实际登记了几个范围
      anchored,
      registered: registered ? registered.size : 0
    })
    // 短探针：压缩存储里长 JSON 读不出布尔值，这里单独存一条短串方便回读
    storage.set('probe', 'anchored=' + (anchored ? 1 : 0) + ' registered=' + (registered ? registered.size : 0) + ' ig=' + ignoredTerms.length + ' mig=' + migratedKeys)
    diag('marked', {
      tier: analysis.tier,
      matched: entries.length,
      terms: entries.map(item => `${item.entry.term}:${item.entry.kind}`)
    })
  }
}

async function analyzeReply(text, sessionId, element) {
  const raw = String(text || '')
  const source = stripMarkDirectives(raw)
  if (source.trim().length < MIN_REPLY_CHARS) return
  // 任何路径拿到带标记块的回复都就地解析标注，辅助模型一次都不发
  const inband = parseMarkDirectives(raw)
  if (inband.length) {
    await applyInband(inband, source, sessionId, element)
    return
  }
  const tier = settings.tier
  const config = TIERS[tier] || TIERS.balanced
  const sig = hashString(normalizeText(source))
  // 同一段回复只分析一次：重渲染、会话重载、重复消息都不再花 token
  const previous = analyses.get(sig)
  if (previous) {
    if (element && !previous.element) previous.element = element
    await applyWithRetry(previous.replyText, previous.terms, previous)
    return
  }
  // 这段正文以前标过：直接按记忆重标，不等模型。
  // 插件重载后打开旧会话、DOM 兜底重新发现历史回复，走的都是这一条
  const remembered = storedMarksFor(source)
  if (remembered && remembered.length) {
    const analysis = {
      terms: remembered.map(item => ({ ...item, tier })),
      replyText: source,
      sessionId,
      tier,
      element: element || null
    }
    analyses.set(sig, analysis)
    await applyWithRetry(source, analysis.terms, analysis)
    return
  }

  let terms = []
  const candidates = config.scan === 'local'
    ? localCandidates(source).slice(0, config.maxTerms)
    : []

  if (config.scan === 'local' && !candidates.length) {
    // 没有本地候选：一次模型调用都不发
    return
  }

  // 模型调用失败（超时、报错）当场重试一次：一次抖动不该让这条回复没标记
  let answered = false
  for (let attempt = 0; attempt < 2 && !answered; attempt += 1) {
    try {
      const raw = await askModel(source, tier, candidates)
      answered = true
      for (const item of raw) {
        const term = item.term.trim()
        if (term.length < 2) continue
        if (!isUsableTerm(term, source, item.kind)) continue
        if (isIgnored(term)) continue
        const kind = normalizeKind(item.kind)
        const entry = {
          term,
          kind,
          explain: String(item.explain || '').trim(),
          note: String(item.note || '').trim(),
          questions: coerceQuestions(item.questions).slice(0, 2),
          tier
        }
        terms.push(entry)
      }
    } catch (err) {
      terms = []
    }
  }

  const analysis = { terms, replyText: source, sessionId, tier, element: element || null }
  // 模型没答上来（两次都失败）不入缓存、不记尾部：那不是「这段回复没有够格的词」。
  // 缓存成空结果会被后续重渲染一直回放，这条回复就永远没标记，只有手动重扫救得回来
  if (answered) {
    analyses.set(sig, analysis)
    if (terms.length) rememberMarks(source, terms)
    rememberAnalyzedTail(source)
  }
  if (terms.length) await applyWithRetry(source, terms, analysis)
}

// 记下这条回复的尾部，后面 DOM 路径碰到同一段就不用再发模型请求
function rememberAnalyzedTail(source) {
  const tail = tailAnchor(String(source || ''))
  if (!tail) return
  analyzedTails.push(tail)
  if (analyzedTails.length > 40) analyzedTails.shift()
}

// 回复自带标记关系：过术语闸门后直接标注，一次模型调用都不发
async function applyInband(entries, source, sessionId, element) {
  const tier = settings.tier
  const config = TIERS[tier] || TIERS.balanced
  // 与 DOM 兜底、标记表共用同一个签名口径：正文一律抹掉指令行再入账
  source = stripMarkDirectives(String(source || ''))
  const terms = []
  for (const item of entries) {
    const term = String(item.term || '').trim()
    if (term.length < 2) continue
    if (!isUsableTerm(term, source, item.kind)) continue
    if (isIgnored(term)) continue
    const entry = {
      term,
      kind: normalizeKind(item.kind),
      explain: String(item.explain || '').trim(),
      note: String(item.note || '').trim(),
      questions: coerceQuestions(item.questions).slice(0, 2),
      tier
    }
    terms.push(entry)
  }
  const sig = hashString(normalizeText(source))
  const analysis = { terms, replyText: source, sessionId, tier, element: element || null }
  analyses.set(sig, analysis)
  if (terms.length) rememberMarks(source, terms)
  rememberAnalyzedTail(source)
  if (terms.length) await applyWithRetry(source, terms, analysis)
}

// 页面重渲染、切换会话、重载插件之后，把还留在记忆里的标记重新钉回文字上。
// 数据来源两层：当前进程的分析记录 → 每回复标记表。
// 一个模型请求都不发，所以可以随时调用、反复调用（内容没变时签名去重，不会重画）。
function remountAllMarks() {
  if (disposed || !settings.enabled) return { elements: 0, matched: 0 }
  const elements = assistantElements()
  let matched = 0
  for (const element of elements) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim()) continue
    // 注意：不套 MIN_REPLY_CHARS。短回复只要在标记表里有过标记，就应该原样挂回来；
    // 那道闸只管「要不要花钱分析新的回复」
    const sig = hashString(normalizeText(stripMarkDirectives(text)))
    const prior = analyses.get(sig)
    if (prior) {
      prior.element = element
      applyAnalysis(element, prior)
      continue
    }
    const stored = storedMarksFor(text) || []
    const seen = new Set()
    const terms = []
    for (const item of stored) {
      const term = String(item && item.term || '').trim()
      if (!term || seen.has(term)) continue
      if (isIgnored(term)) continue
      if (!isUsableTerm(term, text, item.kind)) continue
      seen.add(term)
      terms.push({
        term,
        kind: item.kind,
        explain: item.explain,
        note: item.note,
        questions: item.questions,
        tier: settings.tier
      })
    }
    if (!terms.length) continue
    const analysis = { terms, replyText: text, sessionId: null, tier: settings.tier, element }
    // 入账：之后 DOM 重渲染时，重锚能顺着这条记录找回这条回复
    analyses.set(sig, analysis)
    applyAnalysis(element, analysis)
    matched += terms.length
  }
  // 收尾必须同步一次高亮与悬停表：hoverState.entries 只在 refreshHighlights 里重建，
  // 而 applyAnalysis 对「内容没变」的回复会早退，不补这一下的话
  // （比如 sessions.changed 先清空 hoverState 再重挂）悬停命中表会一直是空的，
  // 标记还在、鼠标移上去却再也不弹解释。
  refreshHighlights()
  hoverState.dirty = true
  return { elements: elements.length, matched }
}

// 回复渲染可能比事件晚一点：先找，找到带这些词的元素再标，找不到就重试几次
async function applyWithRetry(replyText, terms, analysis) {
  for (let attempt = 0; attempt < DOM_RETRY_LIMIT; attempt += 1) {
    const remembered = analysis && analysis.element
    const element = remembered && remembered.isConnected !== false && containsTerms(remembered, terms)
      ? remembered
      : locateAssistantElement(replyText, terms)
    if (element) {
      ensureObserver()
      if (analysis) analysis.element = element
      applyAnalysis(element, analysis)
      return
    }
    if (disposed) return
    await new Promise(resolve => setTimeout(resolve, DOM_RETRY_MS))
  }
  // 重试用尽仍找不到唯一容器（多条回复同尾、锚点对不上）：按词命中兜底，
  // 每个含词的元素只标它自己文字里真实出现的词。宁可多标词本身，也不能标错消息或不标
  for (const element of assistantElements()) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    const subset = (terms || []).filter(item => item.term && textHasTerm(text, item.term))
    if (!subset.length) continue
    ensureObserver()
    applyAnalysis(element, { ...(analysis || {}), terms: subset, element })
  }
}

function onMessageComplete(event) {
  if (disposed || !settings.enabled) return
  const payload = (event && event.payload) || event || {}
  if (payload.partial) return
  // 被打断或出错的回复不标：内容本身不完整，解释容易误导
  const status = payload.status ? String(payload.status) : ''
  if (status === 'interrupted' || status === 'error') return
  if (payload.error || payload.failure_reason) return
  const text = typeof payload.text === 'string' ? payload.text : ''
  if (!text) return
  const sessionId = (event && event.session_id) || null
  diag('message.complete', { sessionId, chars: text.length })
  // 回复自带标记块：解析指令行是纯本地计算，当场标注，
  // 不进防抖队列、也不排在别的模型请求后面（那正是「生成完要等一会」的来源之一）
  const inband = parseMarkDirectives(text)
  if (inband.length) {
    const cleaned = stripMarkDirectives(text)
    const resolved = resolveRenderedReply(cleaned)
    diag('message.complete.inband', { sessionId, entries: inband.length })
    void applyInband(inband, resolved ? resolved.text : cleaned, sessionId, resolved ? resolved.element : null)
    return
  }
  pending.push({ sessionId, text })
  cancelTimer(debounceTimer)
  debounceTimer = later(() => {
    debounceTimer = 0
    const queue = pending.splice(0, pending.length)
    void drain(queue)
  }, ANALYZE_DEBOUNCE_MS)
}

// 网关事件的文本是原始 markdown，页面上是渲染文本。两边对不上的话，
// 同一条回复会被分析两次：花两遍钱，两条结论还不一致，标记跟着乱跳。
// 先把页面上那条回复解析出来，用渲染文本入账，两条路径归一成同一份分析。
function resolveRenderedReply(rawText) {
  const element = locateAssistantElement(rawText, [])
  if (!element) return null
  const root = markdownRoot(element)
  if (!root) return null
  const text = plainText(root)
  if (!text.trim()) return null
  return { element, text }
}

// 串行处理：一轮回复一次模型调用，不并发
async function drain(queue) {
  if (inFlight) {
    pending.push(...queue)
    return
  }
  inFlight = true
  try {
    for (const item of queue) {
      const source = String('' + item.text)
      // 回复自带标记块（主模型在末尾输出的 ::hmw 指令行）优先：
      // 直接拿它标注，不发第二次模型请求
      const inband = parseMarkDirectives(source)
      const cleaned = stripMarkDirectives(source)
      const resolved = resolveRenderedReply(cleaned)
      const text = resolved ? resolved.text : cleaned
      const element = resolved ? resolved.element : null
      if (inband.length) {
        await applyInband(inband, text, item.sessionId, element)
      } else {
        await analyzeReply(text, item.sessionId, element)
      }
    }
  } finally {
    inFlight = false
    if (pending.length && !debounceTimer) {
      debounceTimer = later(() => {
        debounceTimer = 0
        const next = pending.splice(0, pending.length)
        void drain(next)
      }, ANALYZE_DEBOUNCE_MS)
    }
  }
}

// 手动重扫：当前页面上的回复重新走一遍（命中标记表就不花 token）
function rescan() {
  analyses.clear()
  const elements = assistantElements()
  for (const element of elements) {
    const root = markdownRoot(element)
    if (!root) continue
    const text = plainText(root)
    if (!text.trim()) continue
    void analyzeReply(text, null)
  }
}

// ─── 鼠标事件 ────────────────────────────────────────────────────────────
function onMouseMove(event) {
  if (disposed || !settings.enabled) return
  lastPointer = { x: event.clientX, y: event.clientY }
  // 指针落在弹窗自身上时（弹窗可能刚好出现在鼠标下方），
  // 事件目标不是术语，命中测试会失败。这不是「鼠标离开了术语」，
  // 是鼠标在弹窗里，不能把弹窗关掉。
  if (popover.el && popover.el.style.display !== 'none') {
    const target = event.target
    if (target && typeof popover.el.contains === 'function' && popover.el.contains(target)) return
    if (popover.over) return
  }
  const group = hitTest(event.clientX, event.clientY)
  if (!group) {
    scheduleHide()
    return
  }
  if (popover.hideTimer) {
    cancelTimer(popover.hideTimer)
    popover.hideTimer = 0
  }
  const rect = group.rect
  if (!rect) return
  const entry = group.entry
  popover.element = group.element
  popover.rectTop = rect.top
  if (popover.term === entry.term && popover.el && popover.el.style.display !== 'none') {
    positionPopover(popover.el, rect)
    return
  }
  renderPopover(entry, rect, group.sessionId)
}


// ─── 旧浏览器的黄色背景兜底 ──────────────────────────────────────────────
function ensureLayer(id) {
  let layer = document.getElementById(id)
  if (layer) return layer
  layer = document.createElement('div')
  layer.id = id
  layer.className = 'hg-overlay'
  document.body.appendChild(layer)
  return layer
}

function clearLayer(layer) {
  if (!layer) return
  while (layer.firstChild) layer.removeChild(layer.firstChild)
}

function clearOverlay() {
  clearLayer(document.getElementById(HL_ID))
}

// 按当前高亮范围重画：已解释的词铺一层黄底，疑似生造的词加一条红色波浪线。
// 自己画的好处：不依赖浏览器对 ::highlight(text-decoration) 的支持差异，
// 波浪线样式也能完全控制。
function syncOverlay() {
  if (disposed) return
  // 黄底与波浪线都由浏览器原生高亮画（::highlight(hg-term) / ::highlight(hg-suspect)）：
  // 浏览器自己画就永远贴着文字，滚动时不闪、不会错位。
  // 只有浏览器完全不支持原生高亮时，才用覆盖层贴一块黄底兜底。
  const native = supportsNativeHighlight()
  const hlRects = []
  if (!native) {
    for (const [, item] of elementRanges) {
      for (const range of item.termRanges) {
        for (const rect of rangeRects(range)) hlRects.push(rect)
      }
    }
  }
  syncNodes(ensureLayer(HL_ID), hlRects, buildHighlightBox, updateHighlightBox)
}

function syncNodes(layer, rects, build, update) {
  // 注意：每次都重新取 children 长度。测试替身的 removeChild 会换掉数组，
  // 缓存下来的旧数组长度不变会死循环。
  while (layer.children.length > rects.length) {
    layer.removeChild(layer.children[layer.children.length - 1])
  }
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i]
    const node = layer.children[i]
    if (!node) {
      const fresh = build(rect)
      layer.appendChild(fresh)
      // 丝滑淡入：先以透明落位，等浏览器画完这一帧再显形。
      // rAF 在后台标签页可能不触发，配一个 setTimeout 兜底。
      const reveal = () => {
        try {
          if (fresh.classList) fresh.classList.add('hg-in')
          else fresh.setAttribute('class', `${fresh.className || ''} hg-in`.trim())
        } catch (err) {}
      }
      if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => {
          reveal()
          later(reveal, 50)
        })
      } else {
        later(reveal, 30)
      }
      continue
    }
    update(node, rect)
  }
}

// 黄色底兜底：只有浏览器不支持原生高亮时才用
function buildHighlightBox(rect) {
  const box = document.createElement('div')
  box.className = 'hg-hl'
  updateHighlightBox(box, rect)
  return box
}

function updateHighlightBox(box, rect) {
  box.style.left = `${Math.round(rect.left)}px`
  box.style.top = `${Math.round(rect.top)}px`
  box.style.width = `${Math.round(rect.width)}px`
  box.style.height = `${Math.round(rect.height)}px`
}

// 跨行的词会返回多个矩形，逐行画
function rangeRects(range) {
  let rects = []
  try {
    if (range.getClientRects) rects = [...range.getClientRects()]
    else rects = [range.getBoundingClientRect()]
  } catch (err) {
    rects = []
  }
  return rects.filter(rect => rect && rect.width > 0 && rect.height > 0)
}

// 会话区是内部滚动容器，滚动事件不冒泡，用捕获阶段监听。
// 走 ctx.addEventListener：卸载时宿主自动摘掉，不在 app 上留插件监听器。
function watchScroll(ctx) {
  if (!ctx || typeof ctx.addEventListener !== 'function') return
  ctx.addEventListener(document, 'scroll', () => {
    // 滚动后词的屏幕坐标全变了：命中矩形必须重算，
    // 否则鼠标没动也会命中滚动前的旧位置，弹出别的词的解释。
    hoverState.dirty = true
    // 流式输出时会话区一路自动滚动：弹层跟着词走，指针已经离开才收
    resyncPopover()
    scheduleOverlaySync()
  }, true)
  ctx.addEventListener(win, 'resize', () => {
    hoverState.dirty = true
    scheduleOverlaySync()
  })
}

let overlayRaf = 0
function scheduleOverlaySync() {
  if (overlayRaf) return
  overlayRaf = nextFrame(() => {
    overlayRaf = 0
    syncOverlay()
  })
}

// ─── 淡入 ────────────────────────────────────────────────────────────────
// Chromium 不给 ::highlight 做动画，改 CSS transition 也没用（实测无效）。
// 能用的办法：把正在淡入的词单独登记到一组高亮里，
// 样式用 color-mix(... calc(var(--hg-fade-N) * 100%) ...)，
// 帧循环只改这个自定义属性，浏览器自己会重绘。
// 淡入结束后把这些词挪进固定颜色的高亮组，属性复位为 1。
// slot -> { start, keys:Set }  keys 是这一槽正在淡入的词
const fadeSlots = new Map()
// key -> slot，正在淡入的词查它在哪个槽
const fadingTerms = new Map()
// key，已经淡入结束的词：之后重建 Range 不再淡一次
const settledTerms = new Set()

function nowMs() {
  return typeof Date !== 'undefined' && Date.now ? Date.now() : 0
}

function termKey(sessionId, kind, term) {
  // 只按词本身记：同一条回复换会话后重新标注，不该再淡入一次
  return `${kind}|${term}`
}

function setFadeVar(n, value) {
  const root = document.documentElement
  if (!root || !root.style || typeof root.style.setProperty !== 'function') return
  root.style.setProperty('--hg-fade-' + n, String(value))
}

// 分配一个淡入槽：这个词接下来 FADE_MS 毫秒内从透明走到不透明
function startFadeFor(key, batchSlot) {
  if (batchSlot !== null && fadeSlots.has(batchSlot)) {
    fadeSlots.get(batchSlot).keys.add(key)
    fadingTerms.set(key, batchSlot)
    return batchSlot
  }
  let slot = -1
  for (let i = 0; i < FADE_SLOTS; i++) {
    if (!fadeSlots.has(i)) {
      slot = i
      break
    }
  }
  if (slot < 0) {
    // 全忙：复用最老的那槽，它里面的词直接算淡入结束
    let oldest = -1
    let oldestStart = Infinity
    for (const [i, info] of fadeSlots) {
      if (info.start < oldestStart) {
        oldestStart = info.start
        oldest = i
      }
    }
    settleSlot(oldest)
    slot = oldest
  }
  fadeSlots.set(slot, { start: nowMs(), keys: new Set([key]) })
  fadingTerms.set(key, slot)
  setFadeVar(slot, 0)
  ensureFadeLoop()
  return slot
}

// 一个槽位淡入结束：里面的词改成固定颜色
function settleSlot(n) {
  const slot = fadeSlots.get(n)
  if (!slot) return
  for (const key of slot.keys) {
    fadingTerms.delete(key)
    settledTerms.add(key)
  }
  fadeSlots.delete(n)
  setFadeVar(n, 1)
}

let fadeRaf = 0
let disposed = false

function ensureFadeLoop() {
  if (fadeRaf) return
  const tick = () => {
    fadeRaf = 0
    const now = nowMs()
    let settled = false
    for (const [n, slot] of Array.from(fadeSlots)) {
      const p = FADE_MS > 0 ? Math.min(1, (now - slot.start) / FADE_MS) : 1
      setFadeVar(n, p)
      if (p >= 1) {
        settleSlot(n)
        settled = true
      }
    }
    if (settled) {
      // 有词从淡入组挪到固定组，高亮要重新登记
      refreshHighlights()
    }
    if (fadeSlots.size && !disposed) {
      fadeRaf = nextFrame(tick)
    }
  }
  fadeRaf = nextFrame(tick)
}

// ─── 设置页 ──────────────────────────────────────────────────────────────
function SettingsPage() {
  const t = usePluginI18n(ID)
  const [enabled, setEnabled] = useState(settings.enabled)
  const [tier, setTier] = useState(settings.tier)
  const [ignored, setIgnored] = useState(() => [...ignoredTerms])

  const update = patch => {
    settings = { ...settings, ...patch }
    if (storage) storage.set('settings', settings)
  }

  return jsxs('div', {
    className: 'hg-settings',
    children: [
      jsx(ToggleRow, {
        key: 'enabled',
        label: t('enabledLabel'),
        hint: t('enabledHint'),
        checked: enabled,
        onChange: value => {
          setEnabled(value)
          update({ enabled: value })
          if (!value) {
            clearHighlights()
            hoverState.entries = []
          }
        }
      }),
      jsxs('div', {
        key: 'tier',
        className: 'hg-settings-row',
        children: [
          jsx('div', { className: 'hg-settings-title', children: t('tierLabel') }),
          jsx('div', { className: 'hg-settings-hint', children: t('tierHint') }),
          jsx(SegmentedControl, {
            value: tier,
            onChange: value => {
              setTier(value)
              update({ tier: value })
            },
            options: TIER_IDS.map(id => ({ id, label: t(TIERS[id].labelKey) }))
          })
        ]
      }),
      jsxs('div', {
        key: 'marks',
        className: 'hg-settings-row',
        children: [
          jsx('div', { className: 'hg-settings-title', children: t('markStatesTitle') }),
          jsxs('div', {
            className: 'hg-mark-legend',
            children: [
              jsxs('div', {
                className: 'hg-mark-legend-item',
                children: [
                  jsx('span', { className: 'hg-sample-term', children: t('markSampleTerm') }),
                  jsxs('div', {
                    className: 'hg-mark-legend-text',
                    children: [
                      jsx('div', { className: 'hg-settings-title', children: t('markStateTerm') }),
                      jsx('div', { className: 'hg-settings-hint', children: t('markStateTermHint') })
                    ]
                  })
                ]
              }),
              jsxs('div', {
                className: 'hg-mark-legend-item',
                children: [
                  jsx('span', { className: 'hg-sample-suspect', children: t('markSampleSuspect') }),
                  jsxs('div', {
                    className: 'hg-mark-legend-text',
                    children: [
                      jsx('div', { className: 'hg-settings-title', children: t('markStateSuspect') }),
                      jsx('div', { className: 'hg-settings-hint', children: t('markStateSuspectHint') })
                    ]
                  })
                ]
              })
            ]
          })
        ]
      }),
      jsxs('div', {
        key: 'ignored',
        className: 'hg-settings-row',
        children: [
          jsx('div', { className: 'hg-settings-title', children: `${t('ignoredLabel')} (${ignored.length})` }),
          jsx('div', { className: 'hg-settings-hint', children: t('ignoredHint') }),
          ignored.length
            ? jsx('div', { className: 'hg-ignored-list', children: ignored.map(word => jsx(Button, {
                key: word,
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                  unignoreTerm(word)
                  setIgnored(current => current.filter(item => item !== word))
                },
                children: `${word} · ${t('unignore')}`
              })) })
            : jsx('div', { className: 'hg-settings-hint', children: t('ignoredEmpty') })
        ]
      })
    ]
  })
}

// ─── 插件入口 ────────────────────────────────────────────────────────────
const plugin = {
  id: ID,
  name: '标词助手 Mark Words',
  description:
    'Marks the words in assistant replies that are worth doubting and explains them on hover: a neutral dotted underline for debatable usage, a thin red wavy line for suspected inventions or unclear wording, in any language. Replies carrying ::hmw mark blocks are marked immediately with zero model calls; the rest get one batched auxiliary analysis per reply (never per streaming chunk). Every reply\'s marks are stored by its text and pinned back after re-renders, session switches and reloads. Offers ready-to-ask follow-up questions whose icon button fills the composer without sending.',
  register(ctx) {
    hostCtx = ctx
    disposed = false
    storage = ctx.storage
    if (ctx.i18n && typeof ctx.i18n.register === 'function') {
      ctx.i18n.register(LOCALES)
      ctxI18nT = (key, ...args) => ctx.i18n.t(key, ...args)
    }

    // 先搬旧 ID 的数据，再读设置和忽略词，否则旧值会被默认值盖掉
    migrateLegacyStorage()
    const stored = storage.get('settings', null)
    settings = { ...SETTINGS_DEFAULT, ...(stored && typeof stored === 'object' ? stored : {}) }
    if (!TIERS[settings.tier]) settings.tier = SETTINGS_DEFAULT.tier
    if (!TASK_SLOTS.includes(settings.taskSlot)) settings.taskSlot = SETTINGS_DEFAULT.taskSlot
    const storedIgnored = storage.get('ignoredTerms', null)
    ignoredTerms = Array.isArray(storedIgnored) ? storedIgnored.filter(item => typeof item === 'string' && item.trim()) : []
    // 解释缓存机制已下线：清掉旧版本攒下的缓存数据
    storage.remove('cache')
    loadMarkStore()
    ensureStyle()

    // 装载心跳：写在插件自己的存储里，方便核对「这份代码真的被桌面端加载过」
    storage.set('heartbeat', { at: Date.now(), version: PLUGIN_VERSION })
    diag('register', { version: PLUGIN_VERSION, tier: settings.tier })

    // 认领 ::hmw 标记指令：主模型在回复末尾输出的指令行渲染成空组件，
    // 标记关系不进正文显示；插件从 message.complete 的原始文本里解析
    let disposeDirective = null
    try {
      disposeDirective = ctx.register({
        id: 'mark-directive',
        area: TRANSCRIPT_DIRECTIVE_AREA,
        data: {
          name: MARK_DIRECTIVE,
          render: () => null
        }
      })
    } catch (err) {
      // 旧 SDK 没有指令区：回退成纯辅助分析，功能不崩
    }

    // 事件订阅走 ctx.onEvent：插件停用或卸载时自动断开
    ctx.onEvent('message.complete', onMessageComplete)
    // 切换会话：不清空任何已有标记，立刻按标记表把新会话里已经标过的回复重挂一遍。
    // 旧写法先 clear 再等 800ms 补标，中间那段时间标记是空的，看起来就是「闪一下」。
    // 标记表照留，切回来不用再花 token。
    let remountTimer = 0
    const remountSoon = (delay) => {
      cancelTimer(remountTimer)
      remountTimer = later(() => {
        remountTimer = 0
        if (disposed) return
        remountAllMarks()
      }, delay)
    }
    ctx.onEvent('sessions.changed', () => {
      hoverState.dirty = true
      hoverState.entries = []
      replyStability.clear()
      seenReplyTexts.clear()
      snapshotExistingReplies()
      remountAllMarks()
      // 桌面端有新动态就发这个事件（下一条回复开始输出也算）：
      // 不能见事件就收弹层，词还在就让它跟着词，词没了才收
      resyncPopover(true)
      // 新会话的 DOM 可能比事件晚一拍，补一轮
      remountSoon(400)
    })
    snapshotExistingReplies()
    ensureObserver()
    watchScroll(ctx)
    // 插件刚加载：先同步把标记表里的标记挂上，再补两轮兜住迟渲染
    remountAllMarks()
    later(() => { if (!disposed) diag('cachedMarks', remountAllMarks()) }, 500)
    later(() => { if (!disposed) remountAllMarks() }, 1500)
    ctx.addEventListener(document, 'mousemove', onMouseMove, { passive: true })
    // 鼠标移出窗口后不再有 mousemove，未命中的收尾逻辑也就不会跑，
    // 弹窗会一直留在屏幕上。离开窗口时直接收掉。
    ctx.addEventListener(document, 'mouseleave', () => {
      scheduleHideNow()
    }, { passive: true })
    ctx.addEventListener(win, 'scroll', () => {
      hoverState.dirty = true
    }, { passive: true })
    ctx.addEventListener(win, 'resize', () => {
      hoverState.dirty = true
    }, { passive: true })

    // 静态标签（palette 命令、设置页标题）在注册那一刻就定死了文字。
    // 应用语言切换后要重新注册一遍，否则界面还是旧语言。
    let disposeCommand = null
    let disposeSettings = null
    const registerLabels = () => {
      if (typeof disposeCommand === 'function') disposeCommand()
      if (typeof disposeSettings === 'function') disposeSettings()
      disposeCommand = null
      disposeSettings = null
      disposeCommand = ctx.register({
        id: 'glossary-rescan',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-mark-words.rescan',
          label: ctxI18nT('rescan'),
          keywords: ['mark', 'words', '术语', '标注', 'scan', 'rescan'],
          run: () => rescan()
        }
      })
      if (typeof ctx.registerSettingsPage === 'function') {
        disposeSettings = ctx.registerSettingsPage({
          id: 'mark-words',
          title: ctxI18nT('title'),
          icon: 'book',
          render: () => jsx(SettingsPage, {})
        })
      }
    }
    registerLabels()

    // 语言变了：标记关系与语言无关，交给标记表重新挂上，不闪、不空窗。
    // 设置页标题也在这里换成新语言。
    let disposeLocale = null
    if (ctx.i18n && typeof ctx.i18n.onLocaleChange === 'function') {
      disposeLocale = ctx.i18n.onLocaleChange(() => {
        registerLabels()
        hidePopoverNow()
        seenReplyTexts.clear()
        snapshotExistingReplies()
        remountAllMarks()
        remountSoon(400)
      })
    }

    // 卸载：计时器、监听器、观察器、页面上的一切痕迹都要收回。
    // 目标是「停用即恢复原样」，而不是留一半代码还在跑。
    ctx.onDispose(() => {
      disposed = true
      if (typeof disposeDirective === 'function') { try { disposeDirective() } catch (err) {} }
      if (typeof disposeLocale === 'function') { try { disposeLocale() } catch (err) {} }
      for (const cancel of Array.from(nativeTimers)) cancel()
      nativeTimers.clear()
      cancelTimer(popover.hideTimer)
      popover.hideTimer = 0
      cancelTimer(domTimer)
      domTimer = 0
      cancelTimer(debounceTimer)
      debounceTimer = 0
      cancelTimer(reanchorRetryTimer)
      reanchorRetryTimer = 0
      cancelTimer(pollTimer)
      pollTimer = 0
      cancelTimer(overlayRaf)
      overlayRaf = 0
      cancelTimer(fadeRaf)
      fadeRaf = 0
      pending.length = 0
      fadeSlots.clear()
      fadingTerms.clear()
      settledTerms.clear()
      if (observer) observer.disconnect()
      observer = null
      clearHighlights()
      clearMarksState()
      hoverState.dirty = true
      detach(popover.el)
      popover.el = null
      detach(document.getElementById(STYLE_ID))
      removeOwnDom()
      hostCtx = null
    })

    console.log(`[hermes-mark-words] register ok v${PLUGIN_VERSION}`)
  }
}

// 测试用内部件（不导出到运行时契约：测试 harness 用 replace 取出）
const internals = {
  TIERS,
  TIER_IDS,
  markdownRoot,
  ignoreTerm,
  unignoreTerm,
  isIgnored,
  TASK_SLOTS,
  isUsableTerm,
  rangeMatchesText,
  localCandidates,
  parseModelJson,
  coerceQuestions,
  buildUserInput,
  fillComposer,
  analyzeReply,
  parseMarkDirectives,
  maskMarkDirectives,
  stripMarkDirectives,
  detectNewReplies,
  modelInstructions,
  isOwnNode,
  locateAssistantElement,
  applyAnalysis,
  supportsNativeHighlight,
  reapplyAll,
  remountAllMarks,
  storedMarksFor,
  MARKS_LIMIT
}

export default plugin
