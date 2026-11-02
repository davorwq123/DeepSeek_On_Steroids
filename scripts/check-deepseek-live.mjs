/**
 * Preflight for the opt-in DeepSeek live smokes.
 *
 * The smokes need a user-data folder with the built-in browser partition; the smoke itself proves
 * the account is still signed in. Checking that the folder exists before a build keeps a
 * mislabelled CI runner from spending time and usage only to fail at the first page. The folder
 * is found the same way the smokes find it: `COS_DEEPSEEK_PROFILE`, then the platform default.
 */
import { resolveDeepSeekProfile } from './deepseek-live-runtime.mjs';

try {
  await resolveDeepSeekProfile();
  console.log('DeepSeek live profile found.');
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
