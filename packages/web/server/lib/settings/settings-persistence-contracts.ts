import type { SettingsSurface } from './settings-files.js';

export interface SettingsReadOptions {
  surface?: SettingsSurface | null;
  readonly seedPreferences?: boolean;
}

export interface SettingsPersistOptions extends SettingsReadOptions {
  readonly replaceKeys?: readonly string[];
}

export interface SettingsWriteOptions extends SettingsReadOptions {
  changedKeys?: Iterable<string> | null;
}
