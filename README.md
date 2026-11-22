# Classify extension

Adds the `classify` tool to Pi. It sends batched questions to an OpenRouter classifier model.

The extension embeds no API key. It resolves the model through `ctx.modelRegistry.findOfType("classifier", "openrouter", <id>)` and calls `ctx.modelRegistry.classify()`, so the session's `/login openrouter` credential is used.

## Requirements

- Linux. The tool does not register on other operating systems.
- Pi 1.6.0 (verified).
- An OpenRouter credential: run `/login openrouter` in Pi.

## Install

```sh
pi install git:github.com/Wattam/pi-classify
```

Pi supplies the host dependencies.

## Configuration

Set `decisionModel` in `~/.pi/agent/settings.json` or a trusted project's `.pi/settings.json` to an OpenRouter classifier model ID. There is no default.

Pi warns on session startup if `decisionModel` is missing, blank, or not a string. The extension does not register the tool or add its documentation to the model context in that case. Run `/reload` after editing `settings.json`.

## Tool contract

`classify` takes `{ requests }`, with 1 to 20 independent requests. Each request is `{ state, questions }`:

- `state`: a plain-data object holding every piece of context and evidence. The classifier sees only `state` and `questions`; nothing from the conversation reaches it.
- `questions`: a nonempty map from question ID to `{ type, instructions, criteria }`.

| `type`   | `criteria`                                 | Answer fields                                                      |
|----------|--------------------------------------------|--------------------------------------------------------------------|
| `choice` | nonempty map of label to its meaning       | `choice`, optional `probabilities`, optional `confidence`          |
| `bool`   | `{ "true": string, "false": string }`      | `probability` (probability of `true`)                              |
| `score`  | nonempty lowest-first array of level names | `score` (fractional zero-based level index), optional `confidence` |

The structured output is also mirrored in `details.results`: the TUI passes only `content` and `details` to `renderResult`, so the renderer cannot read the structured content. Structured output is `{ results }`, aligned by index with `requests`. A success entry is `{ ok: true, answers: { <question ID>: <answer> } }`. A failure entry is `{ ok: false, stopReason: "error", errorMessage }`.

### Behavior

- Validation runs before any provider call: the batch budget, nonempty question maps, and the per-type `criteria` shape. A single invalid request makes the whole call throw and reaches no provider.
- Requests run through a pool of at most 4 concurrent `classify()` calls; input order is preserved.
- The abort signal is the `execute()` signal, falling back to `ctx.signal`.
- The tool row is rendered like codemode's: the call lists one line per question with its type and labels (a `bool` question lists its `true` and `false` meanings, in that order), the result lists one line per answer, and the footer names the model, the failure count when any request failed, and the timing in the host's format (`4.2s`, `1m 35s`, `2h 3m 4s`). The row starts its own clock when execution starts, so a running batch shows a ticking `Elapsed 4.2s` and a final one shows `Took 4.2s`, from the recorded duration when the host has one and from that clock otherwise. Collapsed rows cap the content at 8 wrapped lines and add a ninth line naming the expand key; expanded rows add instructions, the state keys of each request, and per-label probabilities.
- Any non-`stop` stop reason becomes a failure entry carrying the provider message, or `Classify error (<stopReason>)` when the provider sent none.
- A partially failed batch is not an error result; the text content is prefixed with `<n> of <m> requests failed`. A batch where every request failed sets `isError`.
- An unresolvable model ID or a missing OpenRouter credential throws with a message naming the `decisionModel` setting and `/login openrouter`.

The tool also registers a prompt snippet and prompt guidelines, so the system prompt tells the agent to prefer classifier judgments for choices, keep all evidence in `state`, and report failed entries instead of inventing answers.

## Layout

| Path                       | Contents                                                                                        |
|----------------------------|-------------------------------------------------------------------------------------------------|
| `index.ts`                 | Linux-only extension entry point                                                                |
| `tool.ts`                  | Schemas, result and details types, validation, model resolution, concurrency pool, registration |
| `renderer.ts`              | `renderCall`/`renderResult` for the TUI tool row and HTML exports                               |
| `scripts/link-host.mjs`    | Symlinks the host peer packages from the installed Pi release                                   |
| `test/fixtures/harness.ts` | Stubbed `ExtensionAPI` and model registry, request builders, result helpers                     |
| `test/unit/*.test.ts`      | Registration, configuration, validation, execution, and rendering tests                         |

## Development

Run from the repository root:

```sh
npm run link:host
npm test
```

For a checkout outside the managed Pi extensions directory, set `PI_HOST_NODE_MODULES` to your Pi release's `node_modules` directory before linking. Refresh the links after updating Pi.

The tests stub the model registry and make no network calls.
