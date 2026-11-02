/**
 * Live DeepSeek ordinary-chat smoke: real first send, streaming answer, tool call and
 * continuation on the app-owned page, plus a real planning-helper request.
 *
 * This needs a signed-in DeepSeek account in the built-in browser, so it is opt-in and never
 * part of `npm test` or ordinary CI. Run `npm run build` first, quit the app, then:
 *
 *   COS_DEEPSEEK_LIVE=1 npm run smoke:deepseek:chat
 *
 * The app's user-data folder is found from the platform default, or named explicitly with
 * `COS_DEEPSEEK_PROFILE`. Its built-in browser partition is copied into a throwaway runtime, so
 * the smoke can use the real DeepSeek sign-in without touching the app's history, settings or
 * live profile.
 */
import { runDeepSeekLive } from './deepseek-live-runtime.mjs';

process.exitCode = await runDeepSeekLive({
  fixtureEntry: 'scripts/fixtures/deepseek-chat-live.ts',
  outputDir: 'outputs/deepseek-chat-live'
});
