import type { ConnectionId, ConnectionName } from './contract.js';

export type PackageCommand = {
  readonly package: string;
  readonly version: string;
  readonly bin: string;
};
export type StateReference = { readonly state: string };
export type SecretReference = { readonly secret: string };
export type EnvironmentValue = string | StateReference | SecretReference | { readonly secretFile: string };
export type HeaderValue = string | (SecretReference & { readonly prefix?: string });
export type StdioDefinition = {
  readonly command: string | PackageCommand;
  readonly args: readonly (string | StateReference)[];
  readonly env: Readonly<Record<string, EnvironmentValue>>;
};
export type OAuthDefinition = {
  readonly scopes: readonly string[];
  readonly clientId?: string;
  readonly clientSecret?: SecretReference;
  readonly issuer?: string;
  readonly redirectUri?: string;
};
export type HttpDefinition = {
  readonly url: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly oauth?: OAuthDefinition;
};
export type ToolPolicy = {
  readonly allowTools?: readonly string[];
  readonly denyTools?: readonly string[];
  readonly defaultArguments?: Readonly<Record<string, string>>;
};
type DefinitionBase = {
  readonly name: ConnectionName;
  readonly enabled: boolean;
  readonly policy: ToolPolicy;
};
export type ConnectionDefinition = DefinitionBase & (
  | { readonly transport: 'stdio'; readonly stdio: StdioDefinition }
  | { readonly transport: 'http'; readonly http: HttpDefinition }
);
export type StoredDefinition = ConnectionDefinition & {
  readonly id: ConnectionId;
  readonly revision: number;
};
