<div align="center">

<img src="assets/cover-en.png" alt="Mark Words: underlines the words in an assistant reply worth doubting, and explains them on hover" width="820">

</div>

English | [简体中文](README.zh-CN.md)

<div align="center">

# Mark Words

*A desktop plugin for Hermes Agent that underlines the words in an assistant reply worth doubting, then explains them on hover*<br>
*给 Hermes 桌面端里值得怀疑的词加下划线并在悬停时解释*

[![tests](https://img.shields.io/badge/tests-95%20passing-brightgreen?style=flat-square)](#development)
[![Hermes Desktop](https://img.shields.io/badge/Hermes%20Desktop-%3E%3D0.22.0-5b5bd6?style=flat-square)](https://github.com/NousResearch/hermes-agent)
[![dependencies](https://img.shields.io/badge/dependencies-none-3c873a?style=flat-square)](#development)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[Install](#install) • [What gets marked](#what-gets-marked) • [How marks are decided](#how-marks-are-decided) • [Settings](#settings) • [Privacy](#privacy-and-network) • [Development](#development)

</div>

Every reply arrives with a few words that deserve a second look: a phrase that may not exist, a word whose meaning is unclear in this sentence, an existing term used in a way worth questioning. Mark Words underlines those words in place and explains them the moment you hover. Everyday words and settled technical terms stay clean.

A reply with nothing doubtful gets no marks at all, and that is the normal outcome.

> [!NOTE]
> The plugin reads the text of finished assistant replies in the transcript, which is what it needs to place marks on the right words. A reply that carries its own mark directives costs no extra model call; a reply without them costs one batched auxiliary request through Hermes's own `llm.oneshot`, and that request also carries your last message so the auxiliary model can judge which words are new to you. No third-party service, no telemetry, no file reads, no credentials.

<p align="center">
<img src="assets/chat-marks.png" alt="A reply with a red wavy mark on a suspected invented word and a dotted mark on a debatable one" width="49%"><img src="assets/chat-popover.png" alt="The popover opened on a marked word, with an explanation and follow-up questions" width="49%">
</p>

## Install

Requirements: Hermes Agent with the Desktop app, version 0.22.0 or newer. There is no build step and no dependency to install.

```bash
hermes plugins install hey-yx/hermes-mark-words
```

Then open Settings → Plugins, find Mark Words and switch its Desktop half on. A package installed this way ships that half off until you enable it.

To check it works: send yourself a reply that uses a made-up term, for example "the queue hit zeroframe between two deploy frames". A thin red wavy line appears under the invented word within a second of the reply finishing, and hovering it opens the explanation.

Installing from a checkout instead of the catalog:

```bash
mkdir -p ~/.hermes/desktop-plugins/hermes-mark-words
cp desktop/plugin.js plugin.yaml ~/.hermes/desktop-plugins/hermes-mark-words/
```

The app picks the folder up on its own. If the file watcher misses the change, run `⌘K` → "Reload desktop plugins".

## What gets marked

Only words a reader might stop at:

- a term that may not exist, or that nothing in common usage defines;
- a phrase whose meaning is unclear in this sentence;
- an existing word used in a way worth questioning.

The reply can be in any language; the plugin looks in whatever language the reply is written in. It never marks inside code blocks, inline code or thinking blocks, and it skips interrupted or failed replies.

## How marks are decided

Two paths, and the first one costs nothing extra.

**Mark directives in the reply.** When a reply ends with `::hmw{term="…" kind="…" explain="…"}` lines, the plugin reads them from the finished text, keeps the directive lines out of the visible transcript and marks the words immediately. No second request. This is the path the [`reply-word-marks`](skills/reply-word-marks/SKILL.md) skill asks the model to take (copy the folder into `~/.hermes/skills/` to install it).

**One auxiliary analysis.** A reply without directives gets a single batched request through `llm.oneshot`. Never one call per streaming chunk, never a second call for a reply it has already seen.

| Tier | What is scanned | What reaches the model | Words | Follow-ups per word |
| --- | --- | --- | --- | --- |
| Light | high-confidence candidates only | the candidate snippets with their surroundings, plus your last message | up to 3 | 1 |
| Balanced | the whole reply | the reply text, plus your last message | up to 5 | 2 |
| Detailed | the whole reply | the reply text, plus your last message | up to 10 | 2 |

No earlier turns are sent. The last message rides along only so the auxiliary model can judge which words are new to you. Deeper tiers cost more tokens, which is the only difference between them.

## Hover

A marked word opens a small popover with three things: what the word means in this sentence, how confident that explanation is, and zero to two follow-up questions you could actually ask. Each question has an icon button that drops it into the composer without sending it.

A word you never want marked again can be ignored from the popover. Ignored words are listed in Settings and can be restored from there.

## Marks that stay put

Each reply's marks are stored under its own text. A re-render, a session switch or a plugin reload pins them back onto the same words without asking the model again. When two replies cannot be told apart, it marks nothing rather than marking the wrong message.

## Settings

Settings → Plugins → Mark Words holds the on/off switch, the scan depth, a legend for both mark styles and the list of ignored words. `⌘K` has "Mark Words: rescan the last reply" for the reply already on screen.

## Privacy and network

- **Network:** one auxiliary model request per reply that carries no mark directives, through Hermes's own `llm.oneshot` and the auxiliary model you have configured. Nothing else leaves the machine.
- **Reads:** the text of assistant replies in the transcript (what the marks are placed on) and your last message (context for the auxiliary request only).
- **Writes:** marks, ignored words and settings in the plugin's own storage. No files, no database, no credentials.
- **No telemetry** and no self-updater. Updates arrive only through the plugin's repository or the catalog.

Disable or remove the plugin and the page returns to how it looked before: marks, overlay, injected styles and listeners are all removed.

## Compatibility

Hermes Agent 0.22.0 or newer, Desktop app. The plugin is a single runtime ES module with no build step and no dependencies.

## Development

```bash
node --test tests/plugin.test.mjs   # 95 offline tests
hermes plugins validate .           # manifest, capability and desktop-surface checks
```

The tests load that same runtime module against a stub plugin SDK and a stub DOM, so they need no Hermes install. Coverage is not instrumented: the module is evaluated at test time rather than imported, so a coverage badge here would measure nothing.
