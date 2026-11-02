# DeepSeek setup and reference

[Back to the overview](../README.md)

## Quick start

1. Open **Settings → Setup** and use the built-in browser to sign in to DeepSeek.
2. Approve the folder the assistant may work in. Adding a project organizes chats; it grants no additional permission.
3. Choose access and start a task. DeepThink off/on is the web model's reasoning choice.

DeepSeek runs in the built-in browser. **No tunnel, external browser extension, OpenAI connector or API key is required.** The inherited ChatGPT extension and tunnel code are not the DeepSeek delivery path.

## Tools and access

The web adapter offers the Core coding tools: files, search, patches, shell processes, the displayed plan, and reusable workers. Actual execution goes through the same permission and recording kernel as other app-owned calls.

The DeepSeek catalog does not currently expose native Desktop or external plugin tools. Their inherited connector settings do not establish a DeepSeek connection. Images returned by local tools are recorded in the app; a text result alone does not give the model those image pixels.

Filesystem tools enforce approved roots. `exec_command` starts in an approved working folder but runs with your account's normal privileges; approved roots are not a process sandbox. Read-only mode disables mutation. See [SECURITY.md](../SECURITY.md).

## Planning and continuation

For **Create plan**, choose DeepSeek to use a separate helper chat in the built-in browser. The helper waits for the page's composer, generates a bounded workflow, and does not execute the reference task. The app attempts to delete that helper chat after the request settles. Planning uses the same DeepSeek sign-in and account limits as ordinary messages.

An API planning or Goal/Loop source is optional and separate: configure that service's endpoint, model and required credentials. Such requests may incur provider charges. The local Usage comparison does not read those charges.

If planning fails, read the specific error and check the built-in browser. A signed-out page requires sign-in. An unconfirmed send requires checking the browser before retrying so it is not sent twice. A tunnel cannot repair a DeepSeek helper-page failure.

## Activity and updates

Activity reports the app's update state and the built-in browser's sign-in state. Missing MCP connectors or external extensions do not make DeepSeek disconnected. Update checks never initiate tunnel connections or plugin refreshes.

App updates use this edition's [GitHub releases](https://github.com/davorwq123/DeepSeek_On_Steroids/releases). The configured channel needs a published stable release and matching packages before it can offer an update. Windows and Linux AppImage installs support automatic installation; macOS and DEB installs use the manual download path. Update status is separate from DeepSeek sign-in. Preserve the app's user-data folder when replacing its package.

## Usage and cost comparisons

Messages sent are recorded sends with model proof, not remaining quota. Provider limits appear only when actually observed. Other apps' usage is read separately from their own local logs when enabled.

The token activity estimate uses capped recorded context per unique tool call, with an editable divisor. The monetary comparison applies a cached-input rate and multiplier. It does not measure actual input/output tokens, cache hits, reasoning usage, subscriptions, Web charges or API invoices. Retired DeepSeek web model aliases share the Flash comparison baseline unless an explicit saved rate overrides it. Small positive estimates retain decimal precision. Missing model proof remains unpriced instead of borrowing a GPT comparison rate.

## Troubleshooting and reports

- **Cannot send:** open the built-in browser and confirm DeepSeek is signed in and its composer is usable. Check the outbox receipt before retrying an uncertain delivery.
- **Tool refused:** check approved folders, capability switches, read-only mode, and exact-chat Block/Trust policy.
- **Planning failed:** check its helper-stage error and the built-in browser. Do not configure a tunnel for this.
- **Update check failed:** check the release page and network connection. A configured repository without a stable release cannot supply an update; local coding remains usable.
- **Bug report:** save a diagnostics report from Activity, review it, and use the [issue tracker](https://github.com/davorwq123/DeepSeek_On_Steroids/issues). Report vulnerabilities privately through the [Security page](https://github.com/davorwq123/DeepSeek_On_Steroids/security).
