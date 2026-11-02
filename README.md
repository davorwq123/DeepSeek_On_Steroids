# DeepSeek On Steroids

An independent Electron coding workspace for [DeepSeek Web](https://chat.deepseek.com/), adapted from [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids). MIT licensed; upstream authors and contributors retain their credit in [CONTRIBUTORS.md](CONTRIBUTORS.md).

Choose a project folder, send a task, follow local tool results, and steer work while it runs. The app records durable local history, supports reusable workers, and offers planning, Goal/Loop and Compact & Resume.

This is a **beta release candidate**. Build and test the candidate before distributing it. The app is independent of DeepSeek and is not endorsed by the provider.

[Releases](https://github.com/davorwq123/DeepSeek_On_Steroids/releases) · [Report a bug](https://github.com/davorwq123/DeepSeek_On_Steroids/issues) · [Security reports](https://github.com/davorwq123/DeepSeek_On_Steroids/security)

## Get started

1. Open **Settings → Setup**, open the built-in browser, and sign in to DeepSeek.
2. Approve a project folder and choose the capabilities you want to allow.
3. Choose DeepThink off/on, write a task, and send it.

**No tunnel, provider connector, browser extension or API key is needed for the DeepSeek Web coding path.** External Chrome/Edge/Brave extensions belong to the inherited ChatGPT integration and do not drive DeepSeek.

The DeepSeek tool catalog currently offers `read`, `view_image`, `find`, `apply_patch`, `save_image`, `exec_command`, `write_stdin`, `update_plan` and `agents`. Native Desktop and external plugin connectors from the upstream app are outside this catalog. Tool-result images are recorded locally; the text continuation does not attach their pixels to DeepSeek.

**Create plan** uses a separate DeepSeek helper chat in the same signed-in browser. It returns a workflow for review before execution. Goal/Loop can also use that helper. Choosing an API backend instead requires its configured endpoint and any credentials that service needs.

**Usage** shows recorded activity and an editable cached-input API cost comparison. Token totals are local estimates. The app does not read your DeepSeek Web charges or API bill, and the comparison does not separately price output tokens or cache misses.

## Build from source

Use Node 22.12 or newer on Windows 10/11, macOS 13 Ventura or newer, or a current desktop Linux:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

`npm run verify` also checks source privacy and third-party notices. It requires a real Git checkout and downloads pinned ripgrep resources. On Linux, a Secret Service keyring is required for secure credential storage. The AppImage launcher may add `--no-sandbox` when unprivileged user namespaces are disabled; prefer the DEB on those systems.

Native packaging commands are `npm run dist:win`, `npm run dist:mac` and `npm run dist:linux`. Packaging downloads verified native resources. Validate each platform and architecture on its matching release runner. macOS and Windows releases remain publisher-unsigned; macOS releases are unnotarized. See [setup](docs/setup.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

## Responsible use and provider rules

Use the app with your own account, authorized files and services, and within the provider's applicable rules. Workers and automation do not grant extra quota, model access or permission to bypass restrictions. Browser automation and local recording are not an official DeepSeek automation API.

Review actions and tool outputs. Approved folders constrain the filesystem tools; enabled shell commands run with your OS account's privileges. Conversation history remains on disk until you delete the chat. [Read the security model](SECURITY.md).

## Release validation

Before publishing a version, run the [release checklist](.github/release-checklist.md), including packaged startup and signed-in DeepSeek tests. The live smokes use an isolated copy of a signed-in browser profile and spend real account usage:

```sh
COS_DEEPSEEK_LIVE=1 npm run smoke:deepseek:chat
COS_DEEPSEEK_LIVE=1 npm run smoke:deepseek
COS_DEEPSEEK_LIVE=1 npm run smoke:deepseek:outbox
```

The ordinary-chat smoke also exercises the production planning helper. Mock tests and a successful build do not prove that the current DeepSeek website accepts a request.
