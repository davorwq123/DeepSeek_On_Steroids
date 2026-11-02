import { onLanguageChange, t } from './i18n.js';
import type { MainText } from '../shared/main-texts.js';

/**
 * The tray menu, Session finish notice, tunnel-loss notices and CoS browser tray notice in the
 * selected language, including native update restart confirmation. The main process has no
 * catalogs, so this document translates the exact source texts and hands them over.
 * Literal `t()` calls keep the catalog audit able to see each key.
 */
export function mainTexts(): Record<MainText, string> {
  return {
    "DeepSeek could not confirm {0}. The message was sent with the page's current setting.":
      t("DeepSeek could not confirm {0}. The message was sent with the page's current setting."),
    "This reply was cut off before it finished, so its tool requests were not run.":
      t("This reply was cut off before it finished, so its tool requests were not run."),
    "DeepSeek's Stop button did not respond; the rest of this reply is ignored.":
      t("DeepSeek's Stop button did not respond; the rest of this reply is ignored."),
    "This reply's results could not be saved after several tries. Send a message to continue.":
      t("This reply's results could not be saved after several tries. Send a message to continue."),
    'Open': t('Open'),
    'Show browser': t('Show browser'),
    'Hide browser': t('Hide browser'),
    'Connect': t('Connect'),
    'Disconnect': t('Disconnect'),
    'Quit': t('Quit'),
    'Updating DeepSeek On Steroids': t('Updating DeepSeek On Steroids'),
    'Saving your work…': t('Saving your work…'),
    'Waiting for your permission in Windows…': t('Waiting for your permission in Windows…'),
    'Starting the installer. DeepSeek On Steroids opens again by itself.':
      t('Starting the installer. DeepSeek On Steroids opens again by itself.'),
    'Connected': t('Connected'),
    'No internet': t('No internet'),
    'Tunnel service outage': t('Tunnel service outage'),
    'Diagnostics report': t('Diagnostics report'),
    'DeepSeek sign-in': t('DeepSeek sign-in'),
    'Google sign-in is blocked in this browser': t('Google sign-in is blocked in this browser'),
    'Google does not allow signing in inside an app’s built-in browser. Use the phone number or email and password fields on DeepSeek’s sign-in page.':
      t('Google does not allow signing in inside an app’s built-in browser. Use the phone number or email and password fields on DeepSeek’s sign-in page.'),
    'If you created the account with Google, choose “Forgot password?” to set a password first.':
      t('If you created the account with Google, choose “Forgot password?” to set a password first.'),
    'OK': t('OK'),
    'Not connected': t('Not connected'),
    'Core connection lost': t('Core connection lost'),
    'Desktop connection lost': t('Desktop connection lost'),
    'Plugins connection lost': t('Plugins connection lost'),
    'The tunnel disconnected unexpectedly. Open DeepSeek On Steroids to check the connection.':
      t('The tunnel disconnected unexpectedly. Open DeepSeek On Steroids to check the connection.'),
    'Astra is wrapping up': t('Astra is wrapping up'),
    'Send an automatic Goal or write your next instruction.': t('Send an automatic Goal or write your next instruction.'),
    'Send Automatic Goal': t('Send Automatic Goal'),
    'Write Directly': t('Write Directly'),
    'The DeepSeek On Steroids browser is still running': t('The DeepSeek On Steroids browser is still running'),
    'Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.':
      t('Your chats keep going. Choose Show browser in the tray icon’s menu to bring it back.'),
    'Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.':
      t('Your chats keep going. Choose Show browser in the menu bar icon’s menu to bring it back.'),
    'Restore files from this checkpoint?': t('Restore files from this checkpoint?'),
    'Files return to their checkpoint version; files added since are removed. Current files are saved first, so you can undo this in Review.':
      t('Files return to their checkpoint version; files added since are removed. Current files are saved first, so you can undo this in Review.'),
    'More files are not shown.': t('More files are not shown.'),
    'Keep current files': t('Keep current files'),
    'Restore files': t('Restore files'),
    'Export as Markdown': t('Export as Markdown'),
    'You': t('You'),
    'Export as HTML': t('Export as HTML'),
    'Export usage as CSV': t('Export usage as CSV'),
    'A chat is waiting for you.': t('A chat is waiting for you.'),
    'Something failed in DeepSeek On Steroids.': t('Something failed in DeepSeek On Steroids.'),
    'A chat finished.': t('A chat finished.'),
    'Finished after {0} min.': t('Finished after {0} min.'),
    'This is a test from DeepSeek On Steroids. Phone notifications work.': t('This is a test from DeepSeek On Steroids. Phone notifications work.'),
    'Import CoS Pet folder': t('Import CoS Pet folder'),
    'Export settings': t('Export settings'),
    'Import settings': t('Import settings'),
    'Settings backups': t('Settings backups'),
    'Import SKILL.md': t('Import SKILL.md'),
    'Markdown files': t('Markdown files'),
    'HTML files': t('HTML files'),
    'Text files': t('Text files'),
    'CSV files': t('CSV files'),
    'Save code': t('Save code'),
    'Approve a folder for DeepSeek': t('Approve a folder for DeepSeek'),
    'Import Skill folder': t('Import Skill folder'),
    'Markdown skills': t('Markdown skills'),
    'Choose a project folder for DeepSeek': t('Choose a project folder for DeepSeek'),
    'Select the tunnel executable': t('Select the tunnel executable'),
    'Programs': t('Programs'),
    'Attach files': t('Attach files'),
    'Import MCP bundle': t('Import MCP bundle'),
    'MCP bundles': t('MCP bundles'),
    'Remove worker Git checkout?': t('Remove worker Git checkout?'),
    'Review the worker checkout before removing it': t('Review the worker checkout before removing it'),
    'Checkout: {0}': t('Checkout: {0}'),
    'Uncommitted or ignored paths that would be discarded ({0}):': t('Uncommitted or ignored paths that would be discarded ({0}):'),
    'No uncommitted or ignored paths were detected.': t('No uncommitted or ignored paths were detected.'),
    'Additional paths are not shown; review the checkout before confirming.': t('Additional paths are not shown; review the checkout before confirming.'),
    'Ignored files are included in the removal.': t('Ignored files are included in the removal.'),
    'Commits made only on this branch will remain in Git.': t('Commits made only on this branch will remain in Git.'),
    'This removes the entire checkout folder, including tracked working files, ignored files and uncommitted changes.': t('This removes the entire checkout folder, including tracked working files, ignored files and uncommitted changes.'),
    'The Git branch and its commits are kept. Uncommitted files cannot be recovered from Git.': t('The Git branch and its commits are kept. Uncommitted files cannot be recovered from Git.'),
    'Keep checkout': t('Keep checkout'),
    'Remove checkout; preserve Git branch': t('Remove checkout; preserve Git branch'),
    'DeepSeek finished.': t('DeepSeek finished.'),
    'Goal result needs review': t('Goal result needs review'),
    'The Goal helper thinks the work is complete, but this has not been checked. Review the chat or send another instruction.':
      t('The Goal helper thinks the work is complete, but this has not been checked. Review the chat or send another instruction.'),
    'DeepSeek On Steroids wants to use your mouse and keyboard': t('DeepSeek On Steroids wants to use your mouse and keyboard'),
    'Click': t('Click'),
    'Double-click': t('Double-click'),
    'Type': t('Type'),
    'Press keys': t('Press keys'),
    'Scroll': t('Scroll'),
    'Drag': t('Drag'),
    'Move the pointer': t('Move the pointer'),
    'Switch windows': t('Switch windows'),
    'Open an app': t('Open an app'),
    'Use the mouse and keyboard': t('Use the mouse and keyboard'),
    '{0} in {1}': t('{0} in {1}'),
    'Go ahead': t('Go ahead'),
    'Not now': t('Not now'),
    'Open {0}': t('Open {0}'),
    'New chat': t('New chat'),
    'hidden': t('hidden'),
    'Shared from DeepSeek On Steroids': t('Shared from DeepSeek On Steroids'),
  };
}

/** Publishes now and after every language change; a failed hand-over leaves English texts. */
export function publishMainTexts(send: (texts: Record<string, string>) => unknown): void {
  const publish = () => { try { void Promise.resolve(send(mainTexts())).catch(() => undefined); } catch { /* English stays. */ } };
  publish();
  onLanguageChange(publish);
}
