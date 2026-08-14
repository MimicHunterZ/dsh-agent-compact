# @mimichunterz/agent-compact

Context compression for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): three agent tools plus an optimized compaction engine.

- **`context_surface`** — read-only view of the conversation surface (every node the model sees, with its `seq` coordinate). Zero LLM cost.
- **`context_archive`** — backup the full raw text of a span to a session-scoped spill artifact without compressing.
- **`context_compact`** — one step: auto-archive the raw span, then replace it with a single summary checkpoint node.

The compaction engine is upgraded to feed the summarizer the **full context up to the region end** (a genuine prefix of the last routed request) plus a **scoped instruction that compresses only messages #k..#m**. Measured effect (deepseek-v4-flash, real usage accounting):

| | stock engine | this plugin |
|---|---|---|
| input cache-hit | 88.4% | **99.0%** |
| input miss | grows with region size | constant ≈ instruction (~470 tokens) |
| input cost | ¥0.0073 / compaction | **¥0.0014** (~80% cheaper) |

Full A/B methodology and raw data: [`docs/verification.md`](docs/verification.md) and [`docs/ab-data.json`](docs/ab-data.json).

## Install

```sh
# from a published registry package
dsh plugin --profile web add @mimichunterz/agent-compact

# or from a local checkout
dsh plugin --profile web add ./agent-compact
```

`dsh plugin` forwards to pnpm in the profile directory and appends the bundle to `dsh.profile.bundles` (see the official [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)). Restart the profile. All sessions then see the three `context_*` tools.

### Optional: optimize the engine at mount time for a preset

Out of the box the engine is upgraded lazily on the first `context_compact` call of a session (which also covers the automatic pressure/overflow path and the `compact` command from then on). To optimize from mount time — before any tool use — replace `compaction-basic` inside a preset copy's `compaction` isolate realm:

```yaml
- id: compaction-basic
  name: '@mimichunterz/agent-compact/engine'
```

(`OptimizedCompactionEngine extends BasicCompactionEngine`; the durable transaction, thresholds, and retention stay stock. Requires the package installed in the profile, from which preset rows resolve.)

## Publish

```sh
npm publish   # requires an npm account; the package name must be unique
```

## Configuration

| field | default | meaning |
|---|---|---|
| `autoArchive` | `true` | `context_compact` saves the raw span to a spill artifact before replacing it |
| `maxTokens` | `16384` | summarization output budget; floored at 16384 because thinking-mode models truncate at the stock 8192 cap |

Pass through the inserted row in the profile's `cordis.patch.yml` or a bundle patch.

## Compatibility & known constraints

- Built and verified against DeepSeek Harness `0.1.0-rc.6` (`@deepseek-ai/dsh-compaction-basic@0.1.0-rc.6`).
- `deepseek-v4-flash` runs thinking mode by default; `reasoningTokens` consume the output budget stochastically (observed 0–8K). The summarizer raises `maxTokens` to compensate.
- **Same-turn caveat**: consecutive compactions within one model turn replace spans with checkpoints, so the surface diverges from the last routed request and later compactions in that turn temporarily lose cache reuse; the next request re-anchors and it recovers. Compress once per turn for best results.
- **Do not** insert `<compaction-region-start/end>` markers into the message stream: any in-stream token breaks prefix matching and costs *more* than stock. Boundary info must live in the trailing instruction as message indices.

## License

MIT. The optimizer derives from `@deepseek-ai/dsh-compaction-basic` and related DeepSeek Harness packages (MIT, Copyright DeepSeek) — see [`LICENSE`](LICENSE).
