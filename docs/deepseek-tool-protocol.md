# DeepSeek tool calls over the bridge

DeepSeek Web has no connector protocol, so the app is not an MCP server to it. Instead the
conversation carries a text envelope, and the app owns validation, execution, history and the
result message. The protocol itself lives in `src/main/deepseek/tool-protocol.ts`; the turn
runner is `src/main/deepseek/turn.ts`; the tool host is `src/main/deepseek/tool-host.ts`; the
page that carries it is `src/main/deepseek/page-driver.ts`.

## What the model is told

The adapter asks the bridge for the current catalog when a conversation opens:

```
GET /deepseek/tools        (paired extension only)
{ "tools": [...], "instructions": "…" }
```

`instructions` must be part of the conversation before the model's first answer — inject it as
the opening system/user text of a new DeepSeek chat. It names the only accepted reply shape:

```json
{"type":"tool_calls","calls":[{"id":"unique-id","name":"tool_name","arguments":{}}]}
```

The whole reply must be that JSON object. Prose, an example, or a partial envelope is ordinary
text and runs nothing. `tools` is the Core coding loop (`read`, `view_image`, `find`,
`apply_patch`, `save_image`, `exec_command`, `write_stdin`, `update_plan`) plus `agents`, filtered
to what the user has actually enabled. `session_finish`, `usage` and code-mode `exec` are not
offered: they only make sense for a chat the app brokers over MCP. `agents` is how a DeepSeek
prime starts workers and how a worker reports (`action=message`) and finishes (`action=finish`).

## What the page reports back

For every **final** assistant message:

```
POST /deepseek/reply
{ "conversationId": "…", "messageId": "…", "turnId": "…", "text": "…", "final": true }
```

`messageId` is DeepSeek's stable id for that answer (or a stable hash of the turn if the page
has none); a retry with the same id is idempotent. The user's own message is still reported the
ordinary way, through `/events` with `kind: "user_message"`, so the chat gets its turn, title
and attachment record before its first answer arrives.

The page driver also records each changed streaming revision locally as an
`assistant_message` observation with `state: "streaming"`, keyed by the row's absolute
virtual-list item key, then records the same id as `final` when the answer settles. A streaming
revision never calls `/deepseek/reply`; only the final does. A page without that key records
only the settled answer, because a content hash of a growing answer would mint a new message on
every revision. The bridge then:

1. records the answer as an `assistant_message` observation in the same durable session history
   every page observation uses, deduplicated by `messageId`;
2. refuses a blocked or superseded chat before any tool runs;
3. parses and validates the envelope against the catalog — an unknown tool, repeated call id,
   malformed arguments or an empty batch rejects the whole reply and runs nothing;
4. runs accepted calls sequentially through the registered Core handlers, as the app's own
   caller, with the exact conversation and session. Permissions, approved roots, blocked chats,
   recording and secret shielding are the same guards a connector call gets;
5. queues one continuation message in the outbox containing the exact results, and returns
   `{ status, calls, queued }`.

The page adapter delivers that queued message the same way it delivers any app-authored input
(`/input/claim` → type → `/input/answer`). A reply whose answer needs no tools returns
`{ status: 'answer' }` and queues nothing. Other answers are `tools`, `invalid` (nothing ran; a
correction was queued), `duplicate` (this reply's turn already ran and its row exists), or
`running` with HTTP 202 (the same reply is still executing — wait, do not repost). A blocked or
superseded chat answers 409 and no tool runs; 503 means retry, and is only returned before a row
was filed.

## Authority and limits

- A text envelope is never authority by itself; only `/deepseek/reply` from the paired extension
  starts a turn, and only for a chat that already has a recorded session.
- A rejected envelope executes nothing; the bridge queues a correction telling the model the
  reason and the allowed names.
- One model reply owns one tool turn. The outbox id is derived from `conversationId` +
  `messageId`, so a re-reported answer returns `status: 'duplicate'` without running tools again
  or typing the results twice.
- Tool results are bounded (80,000 characters for the whole continuation, 40,000 per result) and
  truncated text says so. Images are recorded in the app but cannot travel through a text
  envelope, so the model is told they exist rather than given base64.
- The app runs these calls with `dispatch(..., appCaller)` — a root call that claims no page
  request id and writes no connector-usage evidence. It is recorded at full weight, so the
  chat's context meter and tool history include it.

## Worker chats on app-owned pages

`agents action=spawn` still publishes a broker bootstrap, and the bridge still owns its command
id, lease, deadline, send check, worktree and binding. The difference is who carries it: the
bridge opens the marked DeepSeek home page itself, and `page-driver.ts` redeems that exact
`clf` marker in process through `claimWorkerCommandForApp`, types the prepared prompt, waits for
DeepSeek's conversation id and question row, then calls `ackWorkerCommandForApp`. That
acknowledgement is the same worker-start transition the extension reports over HTTP: it records
the chat's origin, binds the exact slot and retires the command durably.

A worker's opening prompt also carries this text protocol (through
`prepareSessionPrompt(..., extraInstructions)`), so the worker can call `agents` to report and
finish. Its final answer travels through the same `/deepseek/reply` path as any other chat;
history, permission checks and tool recording are shared, not forked.

A sleeping worker's wake (`agents action=message` after it finished) never needs the extension
either. `queueWorkerRevival` opens (or reuses) the worker's own DeepSeek chat page; the page
driver's own conversation id is the address, and `claimPendingWorkerRevivalForApp` leases only a
wake whose spec names that exact conversation. The prime's words are typed into the same chat,
and the bridge's durable receipt — not the page's rendering — retires the command. While an
app-owned page consumer exists, `/status` and `/events` do not hand that wake to a companion, so
two transports cannot type it.

Worker bootstraps never use the extension's placement path, whichever browser is selected:
`offerPlacement` refuses a `worker` command outright and the app opener carries the marked
DeepSeek page. A `resume` placement is the only one a companion may still collect.

## Live smoke

Two opt-in smokes (both need `COS_DEEPSEEK_LIVE=1` and a prior `npm run build`) run against the
real page and share the same throwaway signed-in runtime:

- `npm run smoke:deepseek` runs `scripts/fixtures/deepseek-agents-live.ts`: one worker spawn, its
  `agents action=message` report, its `agents action=finish`, then a wake with a second report and
  finish.
- `npm run smoke:deepseek:chat` runs `scripts/fixtures/deepseek-chat-live.ts`: an ordinary new
  chat's first send, a live streaming answer revision, a real `update_plan` call, its tool-result
  continuation and the settled answer, asserting that the streamed revision and the final answer
  kept one message id.

Both sign in through the app's own built-in browser profile: quit the app so its files are not
locked, and the runner finds the platform user-data folder (or uses `COS_DEEPSEEK_PROFILE`) and
copies only that browser partition into a throwaway runtime outside the workspace, then removes
it after the run. App settings, chat history and the live profile are not written. Both smokes
send real messages and spend real account usage, so they are deliberately outside `npm test`
and the ordinary CI matrix.

`.github/workflows/deepseek-live.yml` runs both on a dedicated self-hosted runner labelled
`deepseek-live`: daily, and by `workflow_dispatch`. The runner needs Node 22, a graphical session
(or `xvfb-run` on headless Linux), and a DeepSeek sign-in in the app's built-in browser profile;
quit the app before the job runs. The workflow builds once, runs the worker smoke and then the
ordinary-chat smoke even when the first fails, uploads both `outputs/deepseek-*-live/` trees as
one artifact, and fails the run if either smoke failed. It never runs for pull requests or
ordinary pushes. `node scripts/check-deepseek-live.mjs` fails the job before the build when the
profile is missing, and `COS_DEEPSEEK_PROFILE` as a repository variable points the runner at a
non-default user-data folder; an explicit path must contain the browser partition, so a typo
fails instead of using another account on the runner.

## Not in this piece

Stop and Compact & Resume are still extension-only. Native file uploads are refused visibly on
a DeepSeek page rather than sent without their files. The startup, send, answer, tool,
worker-spawn and worker-wake paths do not depend on the extension.
