/**
 * The fork's product identity, applied to app-authored copy only.
 *
 * This is a DeepSeek app built on Chat On Steroids' structure, so every string the app writes
 * names DeepSeek. Page content — answers, conversation titles, file names, model ids the
 * account reports — is data, never rewritten here.
 */
export function brandCopy(text: string): string {
  return text
    .replace(/\bChat On Steroids\b/g, 'DeepSeek On Steroids')
    .replace(/\bChatGPT\b/g, 'DeepSeek')
    // Copy that names the original provider's generations names DeepSeek's instead. The ids
    // and labels a provider reports as data are never passed through here.
    .replace(/\bGPT-6 Pro\b/g, 'DeepSeek-V4.1-Flash')
    .replace(/\bGPT-6 Astra\b/g, 'DeepSeek-V4.1-Flash')
    .replace(/\bGPT-6 Sol\b/g, 'DeepSeek-V4.1-Flash')
    .replace(/\bGPT-6 Luna\b/g, 'DeepSeek-V4.1-Flash')
    .replace(/\bGPT-6\b/g, 'DeepSeek-V4.1')
    .replace(/\bGPT-5\.6(?: Sol| Terra| Luna)?\b/g, 'DeepSeek-V4.1-Flash')
    .replace(/\bGPT-5\.5\b/g, 'DeepSeek-V4.1-Flash');
}

/**
 * This build drives chat.deepseek.com, not chatgpt.com. A function rather than a constant so
 * branches it guards are still type-checked as live code on both sides.
 */
export function targetsDeepSeek(): boolean {
  return true;
}
