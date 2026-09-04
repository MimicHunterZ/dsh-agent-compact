# agent-compact

English · [简体中文](README.zh-CN.md)

Context compression for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): lets the **agent autonomously call** `context_compact` to compress a span of the conversation it chooses — the finished, no-longer-needed middle — and replace it with a checkpoint the agent writes itself. A companion `context_compact_auto` compacts the engine's own auto-selected range without naming a span, and `context_ask_precompact` consults the pre-compaction context via a fork-style child.

## Why

Compaction is normally a full-context sweep: the official engine only ever compresses from the start of the conversation, so the opening's task plan and direction are **partially lost along with the compressed information**. `context_compact` compresses **only the span the agent selects** — a finished step, a debugged log exchange, an off-track discussion — while the important opening and the recent context stay intact. Span compaction keeps **information loss from compaction as small as possible** — like human memory, the middle is not compressed indiscriminately: what can be summarized is consolidated into a checkpoint, and important details stay word-for-word — the agent decides what is truly dead, and only that gets condensed.

Typical moments to use it:

- a task step is done — compress it, keep the remaining steps and the active instruction live;
- a bug hunt or a wrong research direction is over — compress that exchange into a short "what went wrong / root cause / fix" note;
- the opening requirements are stale — compress the start and restate the current intent.

## What it does

- The agent picks the span via `startAnchor` / `endAnchor` (unique-prefix matching, CJK punctuation-width tolerant) and passes a **required** `summary` — the Markdown checkpoint it wrote itself.
- The raw span is archived to the spill store first (`~/.dsh/spill/session-<hash>/<hex>-<seq>.txt`, sequential naming, restart-safe); the path is echoed in the shadow message so the model can read the raw text back.
- The host engine runs the stock transaction — boundary validation, tool-pair balance, surface replacement — with **no separate LLM summarizer request**.

The tool call itself happens inside the agent's normal turn and is billed like any other turn; what is avoided is only the *extra* summarizer request the official engine would make for the same span.

### Auto range selection

`context_compact_auto` compacts without naming a span: the engine's own pressure trigger auto-selects the oldest compactable range and replaces it with the engine's summarizer checkpoint. It reports what was compacted, or that nothing qualified (the context was below the pressure threshold). Because the auto path provides no agent-written checkpoint, it uses the engine's summarizer (an LLM call).

### Consulting the pre-compaction context (fork of the pre-compaction state)

`context_ask_precompact(question)` lets the agent ask a question against the context that stood **before** the most recent `context_compact`. It creates a fork-style child through the agent registry, seeded with the parent's log up to the last completed turn **before** the compaction — so the span that was compacted away is still original, not folded into a checkpoint. The child joins the same composition (`composeFrom`): same preset, system prompt, and tools. Its context therefore matches the main agent's pre-compaction state and is eligible for the same warm-prefix KV cache. The main session's surface and cache are untouched; the answer is returned here.

The tool needs no extra dependency: it uses the agent registry (`ctx.agents.create`) for the seeded child and composes it via `composeFrom` from `agentPresets`.

## Install

```sh
# from a published registry package
dsh plugin --profile web add @mimichunterz/agent-compact

# or from a local checkout
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` forwards to pnpm in the profile directory and appends the bundle to `dsh.profile.bundles` (see the official [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)). **Restart the profile** — every session then sees the `context_compact` tool.

The bundle's own `cordis.patch.yml` pins the spill archive root to `~/.dsh/spill` (deployments can override it again through the profile's `cordis.patch.yml`).

## Uninstall

```sh
dsh plugin --profile web remove @mimichunterz/agent-compact
```

`dsh plugin remove` forwards to `pnpm remove` in the profile directory: it uninstalls the package and reconciles the bundle out of `dsh.profile.bundles`. **Restart the profile** — every session then stops seeing the `context_compact` tool. The same package name works whether you installed from the registry or from a local checkout.

If the plugin was additionally mounted through a row in the profile's `cordis.patch.yml` (dev mode), remove that row too, otherwise the patch re-mounts it on the next boot.

## Configuration

| field | default | meaning |
|---|---|---|
| `autoArchive` | `true` | `context_compact` saves the full raw span to a spill artifact before replacing it |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## How it works

- **Agent-written checkpoint**: `summary` is mandatory, so the tool path always uses the checkpoint the agent wrote. `patchEngine()` (see `src/optimizer.ts`) wraps the engine's `summarize()`: when an `_externalSummary` is present (one-shot, keyed per session id), it returns that text directly; only when none is present does it forward to the stock implementation — a branch that serves the automatic compaction path and keeps official behavior intact.
- **Anchor matching** (`src/normalize.ts`): `normText` collapses whitespace and maps CJK full-width punctuation to half-width (，→, etc.), applied to both anchors and node text. Matching keeps **unique-prefix** semantics: zero hits → "not found" with closest-node hints; more than one hit → "AMBIGUOUS".
- **Restart-safe sequential archives**: the next number is derived by scanning the session's spill directory (`max+1`) — gap-free; the backend's random hex prefix makes filename collisions impossible.
- **Paired cleanup**: the tool-call message (carrying the full `summary` argument) and its tool/result are each replaced by one tiny shadow message, so the checkpoint text never appears twice on the surface (skipped when the message holds more than one tool call).

## Compatibility

- Built and verified against DeepSeek Harness `0.1.0-rc.6` (`@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6`).
- Only **one compaction per session at a time** (the engine transaction is serialized); anchors re-resolve on every call, so later compactions never go stale after earlier checkpoints replaced old nodes.
- With a local spill backend the root is fixed; other backends degrade gracefully (no `root` field → in-memory counter), and compaction itself is unaffected.

## License

MIT. The patch derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
