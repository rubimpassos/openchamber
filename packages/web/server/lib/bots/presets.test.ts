import { expect, it } from 'vitest';
import { botPresets } from './presets.js';

it('returns detached editable definitions when a preset is selected repeatedly', () => {
  // Given the built-in definitions and an independent selection.
  const original = botPresets();
  const edited = botPresets();

  // When a caller edits each selected preset and its nested defaults.
  for (const preset of edited) {
    preset.name = 'Edited';
    preset.schedule.weekdays.push(6);
    preset.models.fixing.useDefaults = false;
    preset.mcp.push({ server: 'local', tools: { read: 'deny' } });
  }

  // Then later selections retain the original definitions without shared state.
  expect(botPresets()).toEqual(original);
  expect(edited).not.toEqual(original);
});
