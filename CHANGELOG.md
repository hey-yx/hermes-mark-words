# Changelog

Newest first. Versions are 0.x; the plugin is pre-1.0 on purpose.

## v0.24.2

- Disabling the plugin now restores the page completely. Marks, the overlay
  layer, the injected style, the fade variables on the document root and the
  global listeners are all removed, and late timers can no longer re-mark a
  reply after unload.
- Colors come from the app's theme tokens instead of hardcoded white, black and
  red, so the popover and both underline styles follow the active theme without
  a separate dark-mode branch.
- Three regression tests cover the unload path: page cleanup, no marking after
  dispose, and no bare document or window listeners in the source.

## v0.24.1

- Fixed "while the next reply streams, moving the pointer onto a marked word's
  popover always closes it": the transcript auto-scrolls with the output, and
  every scroll event closed the popover. The session activity event
  (`sessions.changed`) closed it the same way.
- Scroll no longer closes the popover unconditionally: on the word it follows
  the word, once the pointer is inside the popover it stays put, and in between
  it freezes until the pointer arrives. It closes when the word leaves the
  viewport or the session switch removes it.

## v0.24.0

- Fixed "after a new response the marks stay but hover stops opening the
  popover": the remount pass early-returns on unchanged replies and never
  refilled the hover hit table. Every remount pass now refills it.
- Fixed "marks vanish permanently after the text is rewritten in place":
  the browser collapses live ranges in a rewritten text node to zero length,
  and the registration dedup kept blocking the rebuilt ranges. Registration
  now compares against what the browser actually holds, so collapsed ranges
  get replaced.
- The popover no longer shows the surrounding quote; it keeps the explanation,
  the uncertainty note and the follow-ups.
- Follow-up counts are no longer fixed at two: zero to two per word (Light at
  most one), none when nothing is worth asking.

## v0.23.1

- Dead surface cleanup: unused settings strings and test-only exports removed,
  comments updated to match the no-cache design. No behaviour change.

## v0.23.0

- The explanation cache is removed. Mark blocks travel with the reply and every
  reply's marks (with their explanations) live in the mark store, so nothing
  needed caching: the settings section (list, search, clear) is gone, and old
  cached data is cleaned up when the plugin loads. Replies without a mark block
  still get one batched auxiliary analysis; those marks are stored the same way.

## v0.22.0

- The cached-explanations list gets a search box: filter by word or explanation,
  case-insensitive. Total count stays in the title; no match says so.

## v0.21.0

- The "mark preference" (All / Daily life / Tech) is removed together with the
  whole theme-classification chain: the prompt no longer asks for a theme, mark
  blocks no longer carry one, and nothing filters marks by topic. Every
  doubtful word is marked again, and config switching no longer triggers any
  repaint work (the old preference switch re-scanned every reply).
- Settings show what the explanation cache actually holds: every cached word
  with its explanation and tier, newest first, instead of just a count. An
  empty cache says so.
- Old data cleans itself: cached explanations and stored marks drop their stale
  theme field when loading.

## v0.20.0

- Switching the mark preference is instant now: existing marks are simply
  re-filtered and repainted, instead of rescanning the mark store and the whole
  cache index on long sessions.
- The "auxiliary model slot" row is gone from settings; the fallback behaviour is
  unchanged (blockless replies use the default slot).
- Dark mode gets a stronger dotted line (alpha 0.42 to 0.62) and the mark-states
  legend samples are thicker, so the states stay readable on dark backgrounds.

## v0.19.0

- The popover shows the surrounding quote: see the word in its own sentence
  before reading the explanation.
- Explanations must answer what the word means and does here. The prompt bans
  dictionary definitions, and when the meaning genuinely cannot be determined
  it must say exactly what is unclear instead of inventing an answer.
- No fake confidence: an empty or hand-wavy explanation shows an honest note
  pointing at the quote and the follow-up questions.
- Loading the plugin prunes cached explanations that are too thin to be useful;
  the word is re-learned with a proper explanation next time.

## v0.18.0

- A "mark preference" appears in settings: All / Daily life / Tech. Daily life
  covers policy, medical, social security, finance, law, education and housing;
  tech covers computing, software, engineering, networking and hardware.
- The preference is a view filter, not deletion: stored marks stay complete and
  switching back to All pins them again at once, with zero model calls.
- The preference is written into the auxiliary model's instructions (only pick
  words of that theme), and mark blocks may carry `theme="life|tech|other"`;
  words without a theme are classified by keyword.
- (The mark preference and theme classification above were removed in
  v0.21.0.)

## v0.17.0

- Replies carrying a `::hmw` block now cost zero model calls on every path. The
  DOM fallback used to miss the block and re-analyse the same reply through the
  auxiliary model, marking the same words twice; directives are now parsed from
  the raw text in place, and all signatures use the directive-masked body.
- Basic words stay unmarked: the common-word list grows to about 300 everyday
  and engineering words in Chinese and English (loading, routing, sync, p90 and
  friends), and a two-character pure-Han term is only allowed under the
  suspected-invented / unclear kinds. The prompt says the same.
- Old data cleans itself: loading the plugin prunes cached explanations and
  stored marks that carry basic words, filenames or code fragments from the old
  selection bar.
- The settings page gains a "mark states" legend with samples: dotted underline
  (term / abbreviation) and red wavy line (suspected invented / unclear).
- Languages: settings and prompt text follow the app language (Chinese and
  English); older hosts without i18n follow the system language instead.

## v0.16.0

- Marks land at once. Replies carrying a `::hmw` block skip the 300 ms debounce
  and never queue behind a model call; the auxiliary path marks already-known
  words before the model answers; the DOM fallback's settle window drops from
  1.2 s to 0.7 s.
- No more flicker. Session and locale switches no longer blank the marks and
  repaint them later, popover re-renders no longer trip the mutation observer,
  and unchanged text positions reuse the registered browser highlight instead of
  forcing a full repaint.
- Old replies keep their marks. Each reply's marks are stored by its text, so a
  re-render, a session switch or a plugin reload pins them back on without
  re-running the model or needing an exact cache hit.
- Selection tightened: only words with genuine doubt are marked. Everyday words
  and well-established terms stay clean, and any language qualifies (kana,
  hangul, Cyrillic and others used to be rejected by the gate).
- The highlighter-yellow block is gone: a neutral dotted underline for ordinary
  doubt, a 1 px soft-red wavy line for suspected inventions, and a slimmer
  popover to match.

## v0.14.0

- One analysis per reply. The gateway event carries raw markdown while the page
  shows rendered text; the plugin now resolves the event text to the rendered
  reply before analysing, so the same reply is no longer paid for twice and two
  answers can no longer fight over the same words.
- Word matching respects ASCII word boundaries and ignores case: `p90` is no
  longer found inside `exp90`, and `P90` matches `p90`.
- A re-judged word updates its mark. When the model changes a word from term to
  fabricated, the yellow underline turns into the red wavy line; before this the
  second answer was dropped as a duplicate.
- Marks no longer vanish on re-render. A failed range lookup for one word no
  longer wipes every mark on the message, and when the target message cannot be
  told apart the words are marked where they actually appear.

## v0.13.0

- Performance and statistics terms (`p50`/`p90`/`p95`/`p99`, `TTFB`, `QPS`, `RTT`,
  首字延迟、中位数、尾延迟、分位值 …) are marked in every tier: the model is told
  about them explicitly, and Light picks them up from candidates first, so they
  are never crowded out inside its short candidate list. (Superseded in 0.16.0:
  marks are now reserved for words with genuine doubt, so settled metrics like
  these are no longer marked.)
- Candidates no longer swallow version numbers, URLs or bare numbers: `v1.2.3`,
  `ex.com/p90`, `3.0s`, `16GB` and the Chinese duration `30 次` all stay
  unmarked.
- Marks survive streaming updates: an incoming chunk can no longer blank every
  highlight and repaint it later.

## v0.11.0

- Renamed to `hermes-mark-words`. The name was generated with the NameYouLike
  naming prompt (two generation rounds, three independent reviews) and checked
  against npm, GitHub and RDAP; `hermes-response-mark` was rejected in review
  because it reads like the whole reply is being marked, not the words in it.
- Data under the older ids `hermes-term-helper` and `hermes-glossary` moves
  into the new keys automatically, then the old keys are cleared.

## v0.10.0

- The wave line uses the browser's native highlight, so it sits on the text
  instead of drifting.
- Hover hits only when the pointer is really on the word, using the browser's
  text-offset lookup.
- Words inside code blocks and inline code are left alone.
- When two replies contain the same word and nothing tells them apart, nothing
  is marked rather than marking the wrong message.
- A reply analysed twice by different paths merges per word instead of
  replacing the whole set.
- Fade-in runs on per-slot numeric coefficients and settles into a fixed group.
- Ignore is permanent: re-renders, session switches and reloads all keep the
  word unmarked, and the settings page lists them with a restore action.
- Renamed to `hermes-term-helper`; the old id's data migrates automatically.
