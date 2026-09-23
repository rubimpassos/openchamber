import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ACTIONS, ERROR_DEFINITIONS, SCHEMA_VERSION } from './contract.js';

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const unique = (values) => new Set(values).size === values.length;
const credentialSchema = z.object({
  id: identifier,
  domain: identifier,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectIds: z.array(identifier).refine(unique),
  actions: z.array(z.enum(ACTIONS)).refine(unique),
  expiresAt: z.string().datetime({ offset: true }),
  enabled: z.boolean(),
}).strict();

const policySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  domainId: identifier,
  credentials: z.array(credentialSchema),
}).strict().refine((policy) => unique(policy.credentials.map((entry) => entry.id))
  && policy.credentials.every((entry) => entry.domain === policy.domainId));

const unavailable = () => ({
  success: false,
  error: { code: 'POLICY_UNAVAILABLE', ...ERROR_DEFINITIONS.POLICY_UNAVAILABLE },
});

// Administrative validation preserves inactive entries; runtime loading filters
// them only AFTER validating the entire document (including inactive records).
export const validateIntegrationPolicy = (value) => {
  try {
    const parsed = policySchema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : unavailable();
  } catch {
    return unavailable();
  }
};

export const isCredentialActive = (credential) => credential.enabled === true
  && Date.parse(credential.expiresAt) > Date.now();

// Call once per request. Never retain the returned snapshot across requests.
// Provisioning owns file ownership/mode/mounts; the runtime is strictly read-only.
export const loadIntegrationPolicy = async () => {
  try {
    const raw = await readFile(process.env.OPENCHAMBER_INTEGRATION_POLICY_FILE, 'utf8');
    const result = validateIntegrationPolicy(JSON.parse(raw));
    if (!result.success) return result;
    return {
      success: true,
      data: { ...result.data, credentials: result.data.credentials.filter(isCredentialActive) },
    };
  } catch {
    return unavailable();
  }
};
