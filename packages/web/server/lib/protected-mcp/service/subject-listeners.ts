import fs from 'node:fs/promises';
import path from 'node:path';
import { createEngineSocketServer } from './engine-socket.js';
import type { EngineSocketLog, EngineSocketServer, EngineSocketSessions, EngineSocketStore } from './engine-socket.js';
import type { ConnectionId } from './contract.js';
import { ensurePrivateDirectory, StateDurabilityError } from './state-files.js';
import { parseSubject } from './subject-contract.js';
import type { Subject } from './subject-contract.js';

export type SubjectGrant = {
  readonly subject: Subject;
  readonly connections: readonly ConnectionId[];
};
export type SubjectListenerStore = EngineSocketStore & {
  readonly subjects: () => readonly SubjectGrant[];
  readonly setSubject: (subject: Subject, connections: readonly ConnectionId[]) => Promise<SubjectGrant>;
  readonly removeSubject: (subject: Subject) => Promise<void>;
};
type SubjectListenerOptions = {
  readonly subjectsDir: string;
  readonly store: SubjectListenerStore;
  readonly sessions: EngineSocketSessions;
  readonly log?: EngineSocketLog;
};

export function createSubjectListeners({ subjectsDir, store, sessions, log }: SubjectListenerOptions) {
  const listeners = new Map<Subject, Promise<EngineSocketServer>>();
  let pending: Promise<void> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const ensure = (subject: Subject): Promise<EngineSocketServer> => {
    parseSubject(subject);
    const existing = listeners.get(subject);
    if (existing) return existing;
    const starting = (async () => {
      await ensurePrivateDirectory(subjectsDir);
      const directory = path.join(subjectsDir, subject);
      try { await fs.mkdir(directory, { mode: 0o711 }); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
      await fs.chmod(directory, 0o711);
      const listener = createEngineSocketServer({ path: path.join(directory, 'engine.sock'), subject, store, sessions, log });
      try { await listener.listen(); }
      catch (error) { await listener.close(); throw error; }
      return listener;
    })();
    listeners.set(subject, starting);
    starting.catch(() => listeners.delete(subject));
    return starting;
  };
  const drop = async (subject: Subject): Promise<void> => {
    const listener = listeners.get(subject);
    if (listener) await (await listener).close();
    listeners.delete(subject);
  };
  return {
    set: (subject: Subject, connections: readonly ConnectionId[]) => serialized(async () => {
      const existed = listeners.has(subject);
      await ensure(subject);
      try { return await store.setSubject(subject, connections); }
      catch (error) { if (!existed && !(error instanceof StateDurabilityError)) await drop(subject); throw error; }
    }),
    remove: (subject: Subject) => serialized(async () => {
      try { await store.removeSubject(subject); }
      catch (error) { if (error instanceof StateDurabilityError) await drop(subject); throw error; }
      await drop(subject);
    }),
    async start() {
      await ensurePrivateDirectory(subjectsDir);
      for (const { subject } of store.subjects()) await ensure(subject);
    },
    async close() {
      await pending;
      const closing = [...listeners.values()];
      listeners.clear();
      await Promise.all(closing.map(async (listener) => (await listener.catch(() => null))?.close()));
    },
  };
}
