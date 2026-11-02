/**
 * Live DeepSeek worker smoke: real spawn, report, finish and wake on the app-owned page.
 *
 * This needs a signed-in DeepSeek account in the built-in browser, so it is opt-in and never
 * part of `npm test` or CI. Run `npm run build` first (the browser loads the packaged
 * preload/renderer from `out/`), quit the app, then:
 *
 *   COS_DEEPSEEK_LIVE=1 npm run smoke:deepseek
 *
 * The app's user-data folder is found from the platform default, or named explicitly with
 * `COS_DEEPSEEK_PROFILE`. Its built-in browser partition is copied into a throwaway runtime, so
 * the smoke can use the real DeepSeek sign-in without touching the app's history, settings or
 * live profile. Nothing else about the page, bridge, tool protocol, kernel or worker broker is
 * substituted.
 */
import { runDeepSeekLive } from './deepseek-live-runtime.mjs';

process.exitCode = await runDeepSeekLive({
  fixtureEntry: 'scripts/fixtures/deepseek-agents-live.ts',
  outputDir: 'outputs/deepseek-agents-live'
});
