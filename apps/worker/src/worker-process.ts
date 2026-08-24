import type { PersistentQueueWorker } from './queue-worker.js';

export interface TerminationSignalSource {
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export async function runUntilTermination(
  worker: PersistentQueueWorker,
  signalSource: TerminationSignalSource = process,
): Promise<void> {
  const stop = (): void => worker.requestStop();
  signalSource.once('SIGTERM', stop);
  signalSource.once('SIGINT', stop);

  try {
    await worker.run();
  } finally {
    signalSource.off('SIGTERM', stop);
    signalSource.off('SIGINT', stop);
  }
}
