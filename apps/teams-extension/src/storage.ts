import { DEFAULT_CONFIG, type ExtensionConfig } from './types';

const KEY = 'nexus.teams.config';

export async function loadConfig(): Promise<ExtensionConfig> {
  const data = await chrome.storage.sync.get(KEY);
  return { ...DEFAULT_CONFIG, ...((data[KEY] as Partial<ExtensionConfig>) ?? {}) };
}

export async function saveConfig(cfg: ExtensionConfig): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: cfg });
}
