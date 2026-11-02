import type { AppState } from '../shared/types.js';
import { $ } from './dom.js';
import { t, ui } from './i18n.js';

/**
 * Setup's first step: sign in to DeepSeek in the app's own browser.
 *
 * This fork has no companion extension and no second browser to choose, so the step is one
 * button and one status. The click itself is wired in main.ts, where the app's other browser
 * actions live; this module only keeps the step's labels and readiness in step with the account.
 */
export function initBrowserSetup(): { render(state: AppState): { ready: boolean; choosingLocation: boolean } } {
  const button = $<HTMLButtonElement>('showCosBrowser');
  const pill = $('cosBrowserState');
  return {
    render(state: AppState): { ready: boolean; choosingLocation: boolean } {
      // Unknown is not signed out: the app asks DeepSeek for its sign-in state on start.
      const signedIn = state.cosBrowserSignedIn ?? null;
      ui(pill, 'textContent', () => signedIn === null
        ? t('Checking the DeepSeek sign-in…')
        : signedIn ? t('Signed in.') : t('Not signed in yet.'));
      pill.dataset.tone = signedIn ? 'ok' : 'wait';
      button.dataset.signedIn = String(signedIn === true);
      button.querySelector('i')!.className = signedIn ? 'ico ph ph-sign-out' : 'ico ph ph-sign-in';
      ui(button.querySelector('span')!, 'textContent', () => signedIn
        ? t('Sign out of DeepSeek') : t('Sign in to DeepSeek'));
      return { ready: signedIn === true, choosingLocation: false };
    }
  };
}
