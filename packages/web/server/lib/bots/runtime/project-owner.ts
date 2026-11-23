import { withSourceControlFileLock } from '../../source-control/file-lock.js';
import type { SourceControlFileLockOptions } from '../../source-control/file-lock.js';

export const createRuntimeProjectOwner = (store: { filePathFor(projectId: string): string }) => {
  const ownerTails = new Map<string, Promise<void>>();
  return <Result>(projectId: string, operation: () => Result | Promise<Result>, options?: SourceControlFileLockOptions): Promise<Result> => {
    const previous = ownerTails.get(projectId) ?? Promise.resolve();
    const result = previous.then(() => withSourceControlFileLock(`${store.filePathFor(projectId)}.owner.lock`, operation, options));
    const settle = () => { if (ownerTails.get(projectId) === tail) ownerTails.delete(projectId); };
    const tail = result.then(settle, settle);
    ownerTails.set(projectId, tail);
    return result;
  };
};
