# Hermes Mark Words

A Hermes Desktop plugin that underlines the words in assistant replies worth
doubting, then explains them when you hover. Suspected inventions get a thin
red wavy line; debatable usage of an existing word gets a neutral dotted line.
Everyday words and settled technical terms stay clean.

[中文说明](README.zh-CN.md)

## What gets marked

Only words a reader might stop at: a term that may not exist, a phrase whose
meaning is unclear here, an existing word used in a way worth questioning. It
works in any language, and never marks code blocks, inline code, thinking
blocks, interrupted replies or failed runs. An empty result is normal: a reply
with nothing doubtful gets no marks at all.

## How a reply gets marked

When the reply ends with `::hmw{term="…" kind="…" explain="…"}` directives, the
plugin reads them from the finished text, renders the directive lines invisible
and marks the words immediately. No second request. This is the path the
`reply-word-marks` skill asks the model to take.

Replies without those directives get one batched auxiliary analysis through
`llm.oneshot`: never one call per streaming chunk, never a second call for a
reply it has already seen.

| Tier | What is scanned | What reaches the model | Follow-ups per word |
| --- | --- | --- | --- |
| Light | high-confidence candidates only | the candidate snippets | up to 1 |
| Balanced | the whole reply | the reply text | up to 2 |
| Detailed | the whole reply | the reply text | up to 2 |

No tier sends the conversation history. Deeper tiers cost more tokens.

## Hover

Hovering a marked word opens a small popover with what the word means in this
sentence, how sure that explanation is, and zero to two follow-up questions.
Each question has an icon button that drops it into the composer without
sending it. Words you dismiss can be restored from settings.

## Marks that stay put

Each reply's marks are stored keyed by its text, so a re-render, a session
switch or a plugin reload pins them back onto the same words without asking the
model again. When two replies cannot be told apart, it marks nothing rather
than marking the wrong message.

## Settings

Settings → Plugins → Mark Words holds the on/off switch, the scan depth, the
legend for both mark styles and the list of ignored words. `⌘K` has
"Mark Words: rescan the last reply".

## Install

From the catalog, once listed:

```bash
hermes plugins install hermes-mark-words
```

Then turn on its Desktop switch in Settings → Plugins. A package installed this
way ships its desktop half switched off until you enable it.

From a checkout, without the catalog:

```bash
mkdir -p ~/.hermes/desktop-plugins/hermes-mark-words
cp desktop/plugin.js plugin.yaml ~/.hermes/desktop-plugins/hermes-mark-words/
```

The desktop app picks the folder up by itself. `⌘K` → "Reload desktop plugins"
forces it if the watcher misses a change.

## Privacy and network

Disclosure: the plugin sends one auxiliary model request per reply that has no
`::hmw` block, through Hermes's own `llm.oneshot` path and the configured
auxiliary model. It reads the text of assistant replies from the transcript to
find and position the marks. It makes no other network calls, contacts no
third-party service, sends no telemetry, reads no files and never touches
credentials. Ignored words, settings and the mark store stay in the plugin's own
storage. Disable or remove it and the page returns to how it looked before:
marks, overlay, injected style and listeners are all removed.

## Compatibility

Hermes Agent 0.22.0 or newer, Desktop app. No build step, no dependencies.

## Development

```bash
node --test tests/plugin.test.mjs      # 94 offline tests
hermes plugins validate .              # manifest, capability and desktop-surface lint
```

The plugin is one runtime ES module. The tests evaluate that same file against a
stub SDK and a stub DOM.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
