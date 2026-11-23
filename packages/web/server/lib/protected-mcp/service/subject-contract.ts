import { isPlainObject, isString } from '../../shared/guards.js';
import { isConnectionId, ProtectedMcpError } from './contract.js';
import type { ConnectionId } from './contract.js';
import type { StoredDefinition } from './definition-types.js';
import type { JsonValue } from '../../shared/json-values.js';

declare const subjectBrand: unique symbol;
export type Subject = string & { readonly [subjectBrand]: true };
type Subjects = ReadonlyMap<Subject, readonly ConnectionId[]>;
const isSubject = (value: unknown): value is Subject => isString(value) && /^(?:agent|space-[0-9a-f]{12})$/.test(value);

export function parseSubject(subject: JsonValue | undefined): Subject {
  if (!isSubject(subject)) throw new ProtectedMcpError('invalid_subject');
  return subject;
}

export function parseSubjectConnections(connections: JsonValue | readonly ConnectionId[] | undefined): ConnectionId[] {
  if (!Array.isArray(connections) || !connections.every(isConnectionId)) throw new ProtectedMcpError('invalid_request');
  return [...new Set(connections)].sort();
}

export function parseStoredSubjects(value: JsonValue | undefined, definitions: ReadonlyMap<ConnectionId, StoredDefinition>): Map<Subject, ConnectionId[]> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) throw new ProtectedMcpError('state_unreadable');
  const subjects = new Map<Subject, ConnectionId[]>();
  for (const candidate of value) {
    const entry: JsonValue = candidate;
    if (!isPlainObject(entry) || !isSubject(entry.subject) || subjects.has(entry.subject)) throw new ProtectedMcpError('state_unreadable');
    const connections = parseSubjectConnections(entry.connections);
    if (connections.some((id) => !definitions.has(id))) throw new ProtectedMcpError('state_unreadable');
    subjects.set(entry.subject, connections);
  }
  return subjects;
}

export const subjectViews = (subjects: Subjects) => [...subjects].map(([subject, connections]) => ({ subject, connections: [...connections] }));
