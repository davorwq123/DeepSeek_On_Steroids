import { describe, expect, it } from 'vitest';
import { brandCopy } from '../src/shared/brand.js';

describe('product copy', () => {
  it('names this app DeepSeek wherever the original named itself', () => {
    expect(brandCopy('DeepSeek On Steroids wants to use your mouse and keyboard'))
      .toBe('DeepSeek On Steroids wants to use your mouse and keyboard');
    expect(brandCopy('Sign in to ChatGPT')).toBe('Sign in to DeepSeek');
    expect(brandCopy('Refresh DeepSeek On Steroids Plugins in ChatGPT'))
      .toBe('Refresh DeepSeek On Steroids Plugins in DeepSeek');
  });

  it('is idempotent, so a language repaint cannot stack names', () => {
    const once = brandCopy('DeepSeek On Steroids in ChatGPT');
    expect(brandCopy(once)).toBe(once);
  });

  it('leaves data alone: ids, hosts and file names are not copy', () => {
    const data = 'gpt-5.6-sol and gpt-6-astra at https://chatgpt.com/plugins';
    expect(brandCopy(data)).toBe(data);
  });

  it('names DeepSeek generations where copy names the original ones', () => {
    expect(brandCopy('Pick GPT-6, GPT-5.6 or GPT-5.5 with Instant, Medium or High.'))
      .toBe('Pick DeepSeek-V4.1, DeepSeek-V4.1-Flash or DeepSeek-V4.1-Flash with Instant, Medium or High.');
    expect(brandCopy('Goal and Loop use it with GPT-6 Pro')).toBe('Goal and Loop use it with DeepSeek-V4.1-Flash');
  });
});
