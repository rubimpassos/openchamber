import { z } from 'zod';

import gatekeeperRules from './gatekeeper-program.cjs';
import { SpaceError } from './errors.js';

export const approvalPolicy = gatekeeperRules.approvalPolicy;
export const spacePurposeSchema = z.enum(['general', approvalPolicy.purpose]);
export const approvalModelSchema = z.object({ providerID: z.string().min(1).max(64), modelID: z.string().min(1).max(128) }).strict();

export function requireApprovalModel(purpose, model) {
  if (purpose !== approvalPolicy.purpose) return null;
  const parsed = approvalModelSchema.safeParse(model);
  if (!parsed.success || !approvalPolicy.reviewedModel(parsed.data)) {
    throw new SpaceError('space_approval_model_unreviewed', 'This approval worker needs an explicitly reviewed inference-only provider/model pair. Choose a reviewed model or add a reviewed capability rule before creating the worker.');
  }
  return parsed.data;
}

export function requireSpacePurpose(purpose = 'general') {
  const parsed = spacePurposeSchema.safeParse(purpose);
  if (!parsed.success) throw new SpaceError('invalid_space_purpose', 'Choose general or pr-fix-loop-approval when creating a new space.');
  return parsed.data;
}

export function requireProfileNetwork(purpose, network) {
  if (purpose === approvalPolicy.purpose && !approvalPolicy.networkAllowed(network)) {
    throw new SpaceError('space_approval_network_locked', 'An approval worker requires an empty allowlist permanently. Create it without open network or domain access.');
  }
}

export function requireProfileGrants(record) {
  requireProfileNetwork(record.purpose, record.network);
  const model = requireApprovalModel(record.purpose, record.approvalModel);
  if (model && !record.grants.every((grant) => grant.provider === model.providerID && approvalPolicy.grantAllowed(grant))) {
    throw new SpaceError('space_approval_grant_denied', 'Approval workers accept only supported model keys or host logins. Domain, custom and handed-over grants are unavailable.');
  }
}

export function requireApprovalModelWindow(window) {
  const protocol = approvalPolicy.protocolOf(window);
  if (!protocol || !window.secret || Object.keys(window.headers ?? {}).length > 0 || window.model?.providerID !== window.id || !approvalPolicy.supportsProtocol(protocol, window.model)) {
    throw new SpaceError('space_approval_model_unsupported', 'Grant the worker\'s selected reviewed model through a supported OpenAI, Anthropic or Copilot endpoint. Other providers, protocols, custom endpoints and extra headers are unavailable.');
  }
}
