import { z } from 'zod';

export const serverBrowserOriginsSchema = z.array(z.string().refine((value) => {
  try {
    const url = new URL(value);
    return value.trim() === value && ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) origin')).max(256);

type ServerBrowserOriginsOptions = {
  readonly settingsOrigins?: unknown;
  readonly port: number;
  readonly host?: string | undefined;
  readonly addresses?: readonly string[];
};

export const serverBrowserOrigins = ({ settingsOrigins = [], port, host, addresses = [] }: ServerBrowserOriginsOptions): string[] => {
  const origins = serverBrowserOriginsSchema.parse(settingsOrigins);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OpenChamber listening port is unavailable');
  const hosts = ['localhost', '127.0.0.1', '::1', host, ...addresses].filter((address): address is string => Boolean(address));
  const listening = hosts.map((address) => {
    const hostname = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
    return new URL(`http://${hostname}:${port}`).origin;
  });
  return [...new Set([...origins.map((origin) => new URL(origin).origin), ...listening])];
};
