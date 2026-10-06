# dsh-request-context

> A local plugin for **DeepSeek Harness** that shows the exact request payload of every model call — messages and instructions in order, tool definitions, token breakdown, and how many calls each conversation turn actually made.
>
> It does not patch the Harness core, does not change model input, adds no tools, and never reads your API keys or OAuth credentials.

[中文说明](README.md) · [Companion article (Chinese)](docs/token-lessons.md) · [MIT](LICENSE)

## What it is for

- **The context is a black box.** Every model call re-sends the whole history; this plugin snapshots what was actually assembled.
- **Token accounting is guesswork.** See how much comes from the system prompt, tool schemas, chat history, tool results, and sub-agent payloads.
- **Turn accounting is guesswork.** Compression and title-generation requests are separated from the main loop, so per-turn call counts are real counts.

It observes `llm/stream` **synchronously**, before any provider adapter conversion, stores snapshots content-addressably (deduplicated), and renders a panel next to the session title.

## What it looks like

![Request context panel](docs/images/overview.jpg)

Left: message-count trend. Right: context-token estimate. Below: per-call category breakdown and per-turn call statistics.

## Features

- Panel entry **Request context** next to the session title; live list updates every 2s while open, polling stops when closed.
- Overview: message-count trend, per-call and cumulative input-token estimates, mutually exclusive category breakdown (system, developer, tool definitions, tool calls, tool results, sub-agent, user, assistant history, auto-injected context, other).
- Filter by call type: main conversation / compression / title / all; show last 30, 100, or all captured calls.
- Real turn association from `turn/start`, `turn/end`, `step/start`, `step/end`; per-turn statistics (average calls in completed turns, calls in the current unfinished turn, unassociated calls).
- Four views per call: ordered messages and instructions / model and parameters / tool definitions and history / full JSON. Export to JSON after confirmation.
- No npm dependencies, no install scripts, no telemetry, no outbound network requests.

## Install (DSH local plugin)

1. Clone:

   ```powershell
   git clone https://github.com/classicer/dsh-request-context.git C:\path\to\dsh-request-context
   ```

2. Register it in your DSH profile (`~/.dsh/profiles/<profile>/package.json`):

   ```json
   {
     "dependencies": { "@local/dsh-request-context": "link:C:/path/to/dsh-request-context" },
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-request-context"] } }
   }
   ```

3. Make the link appear in the profile's `node_modules` (`pnpm install`, or create a junction/symlink manually).

4. Restart DSH and refresh the page. Data is written to `<plugin>/.state/default` by default; override `dataDir` via `- id: local-request-context` in the profile's `cordis.patch.yml`.

Existing local users: the repository uses the DSH local-plugin name `@local/dsh-request-context`. To rename it, update three places — `package.json` `name`, `cordis.patch.yml` `name`, and the profile dependency key plus bundle entry.

## Scope and accuracy (short version)

- Snapshots the arguments of the synchronous `llm/stream` hook: **before** provider protocol conversion. It is *not* a final HTTP capture; downstream middleware may still modify the request.
- Token numbers are **estimates** (ASCII ≈ 4 chars/token, non-ASCII ≈ 1 char/token, +4 framing tokens per message), not a real tokenizer and not provider billing.
- Cumulative token values sum every captured request, so re-sent history is counted repeatedly — they are not the current context size.
- Turn statistics use real session events, but only cover **captured** calls: snapshots from before the plugin was enabled, or from a disabled/crashed period, are missing.
- Only calls that carry a `sessionId` and pass through `llm/stream` are covered.

## Privacy

- Uses the existing authenticated Connection fetch registry (no bare HTTP route), responses are `Cache-Control: no-store`.
- Never reads credential services, auth headers, or OAuth tokens.
- Best-effort masking of `Bearer`, `sk-`, JWT, and structured secret keys. **Not a general DLP guarantee** — snapshots contain private conversation content; do not commit them, screenshot them, or share exports.
- Rendering uses React text nodes only; no HTML injection.

## Development

```powershell
npm test     # node --test --test-isolation=none test.mjs review-tests.mjs analytics-tests.mjs turns-tests.mjs client-tests.mjs
npm run check
```

Plain JavaScript, no build step, no dependencies. Host-side changes require reloading the plugin's Host module and refreshing the page. Automated tests are not a substitute for visual verification in a real theme/layout.

## License

[MIT](LICENSE) © 2026 classicer
