import type { AppState } from '../shared/types.js';
import { t } from './i18n.js';
import { updateErrorText } from './update-error.js';

interface ReadinessRow {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'not-run' | 'skipped';
  detail: string;
  reason?: string;
  nextStep?: string;
}

/** App updates and the built-in browser own these facts; MCP connectors are not used by DeepSeek. */
export function updateReadiness(next: AppState): ReadinessRow[] {
  const { update } = next;
  const appReady = !update.unavailable && update.stage === 'idle' && !update.latest && update.checkedAt != null;
  const appDetail = update.stage === 'failed' ? t('Update check failed')
    : update.stage === 'checking' ? t('Checking for a newer version…')
    : update.stage === 'downloading' ? t('Downloading {0}', [update.latest])
    : update.latest ? (update.stage === 'ready' ? t('Ready to install {0}', [update.latest]) : t('Install {0} manually', [update.latest]))
    : update.unavailable ? t('Updates are not available for this edition')
    : appReady ? t('Up to date') : t('Not checked yet');
  const rows: ReadinessRow[] = [
    { id: 'app', label: 'DeepSeek On Steroids', status: update.stage === 'failed' ? 'fail' : update.unavailable ? 'skipped' : appReady ? 'pass' : 'not-run',
      detail: t('Version {0}', [update.current]) + ' · ' + appDetail,
      reason: update.stage === 'failed' && update.error ? updateErrorText(update.error) : undefined,
      nextStep: update.stage === 'failed' ? t('Choose Update all to retry. You can keep using the current app.')
        : next.platform?.family === 'macos' && update.stage === 'idle' && update.latest
          ? t('Finish active work and fully quit DeepSeek On Steroids. Replace the app in /Applications, then open the updated app from there.') : undefined },
    { id: 'browser', label: t('DeepSeek browser'),
      status: next.cosBrowserSignedIn === true ? 'pass' : 'not-run',
      detail: next.cosBrowserSignedIn === true ? t('Signed in to DeepSeek')
        : next.cosBrowserSignedIn === false ? t('Sign in to DeepSeek') : t('Checking…'),
      nextStep: next.cosBrowserSignedIn === true ? undefined : t('Review setup') },
  ];
  return rows;
}
