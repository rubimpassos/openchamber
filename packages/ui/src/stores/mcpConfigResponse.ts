import { z } from 'zod';

export const MCP_SCOPES = ['user', 'project', 'local'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const MCP_PROTOCOLS = ['legacy', 'auto', '2026-07-28'] as const;
export type McpProtocol = (typeof MCP_PROTOCOLS)[number];

const mcpTimeoutSchema = z.object({
  startup: z.number().optional(),
  catalog: z.number().optional(),
  execution: z.number().optional(),
});
export type McpTimeout = z.infer<typeof mcpTimeoutSchema>;

const mcpOAuthSchema = z.object({
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  callback_port: z.number().optional(),
  redirect_uri: z.string().optional(),
  auth_server_metadata_url: z.string().optional(),
});
export type McpOAuthConfig = z.infer<typeof mcpOAuthSchema>;

const mcpConfigBaseSchema = z.object({
  name: z.string(),
  scope: z.enum(MCP_SCOPES).nullish(),
  path: z.string().nullish(),
  legacy: z.boolean().optional(),
  environment: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional(),
  codemode: z.boolean().optional(),
  timeout: mcpTimeoutSchema.optional(),
  protocol: z.enum(MCP_PROTOCOLS).optional(),
});

const mcpServerSchema = z.discriminatedUnion('type', [
  mcpConfigBaseSchema.extend({
    type: z.literal('local'),
    command: z.array(z.string()),
    cwd: z.string().optional(),
  }),
  mcpConfigBaseSchema.extend({
    type: z.literal('remote'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.union([mcpOAuthSchema, z.literal(false)]).optional(),
  }),
]);

/** Missing legacy scope is preserved; an unrecognized owner cannot become Global. */
export const mcpServerListSchema = z.array(mcpServerSchema);
export type McpServerWithScope = z.infer<typeof mcpServerSchema>;

/** Only a confirmed boolean grants permission to offer project-local creation. */
export const mcpCapabilitiesSchema = z.object({ projectLocal: z.boolean() });
