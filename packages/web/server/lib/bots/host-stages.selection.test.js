import { expect, it } from 'vitest';
import { botDefinitionSchema } from './config.js';
import { createHostStages } from './host-stages.js';

const separatedStages = (defaults) => createHostStages({
  execution: { stages: {} }, isolated: {}, readSessionDefaults: async () => defaults,
});

it('retains the separated explicit selection object and its omitted fields', async () => {
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix',
    models: { investigation: { useDefaults: false, providerID: 'selected', modelID: 'model' } },
  });
  const stages = separatedStages({ providerID: 'fallback', modelID: 'other-model' });

  const selected = await stages.select('project', bot, 'investigation');

  expect(selected).toStrictEqual({ useDefaults: false, providerID: 'selected', modelID: 'model' });
  expect(Object.hasOwn(selected, 'variant')).toBe(false);
});

it('retains separated raw defaults without decoding or inserting optional fields', async () => {
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix' });
  const defaults = { providerID: 'selected', modelID: 'model', useDefaults: true, variant: undefined };
  const stages = separatedStages(defaults);

  const selected = await stages.select('project', bot, 'investigation');

  expect(selected).toStrictEqual(defaults);
  expect(Object.hasOwn(selected, 'variant')).toBe(true);
  expect(selected.variant).toBeUndefined();
  expect(Object.hasOwn(selected, 'agent')).toBe(false);
});

it('preserves an absent separated default selection', async () => {
  const bot = botDefinitionSchema.parse({ id: 'bot', name: 'Bot', mission: 'Fix' });
  const stages = separatedStages(undefined);

  const selected = await stages.select('project', bot, 'investigation');

  expect(selected).toBeUndefined();
});
