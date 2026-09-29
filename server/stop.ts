// Stopping the server on a signal, so the scenes changed in the last second are written (plan 8.6).
// Ctrl+C is SIGINT everywhere; a service manager sends SIGTERM. On Windows closing the console window comes as
// SIGHUP (Windows ends the process some seconds later whatever it does) and Ctrl+Break as SIGBREAK; on Linux
// SIGHUP is a closed terminal and SIGBREAK never comes. The write itself is synchronous (node:sqlite).

export const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

export interface SignalSource {
  on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): unknown;
}

/**
 * Calls `close` on the first stop signal, then `exit` with 0, or with 1 after `report` when closing failed.
 * Later signals while closing do nothing: the listeners stay, so a second Ctrl+C does not kill the process
 * before the scenes are written.
 */
export function stopOnSignals(source: SignalSource, close: () => Promise<void>, exit: (code: number) => void, report: (error: unknown) => void): void {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    close().then(
      () => exit(0),
      (error: unknown) => {
        report(error);
        exit(1);
      },
    );
  };
  for (const signal of STOP_SIGNALS) source.on(signal, stop);
}
