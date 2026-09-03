export async function runAgentRelayLifecycle({
  daemon,
  workerKind,
  writeRecord,
  subscribeSignal,
  setExitCode,
}) {
  const startPromise = daemon.start();
  let stopping = false;
  let stopPromise = null;

  const stop = (signal) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      await startPromise;
      await daemon.stop();
      await writeRecord({ state: 'STOPPED', signal, workerKind });
    })();
    void stopPromise.then(() => setExitCode(0), () => setExitCode(1));
    return stopPromise;
  };

  subscribeSignal('SIGTERM', () => { void stop('SIGTERM'); });
  subscribeSignal('SIGINT', () => { void stop('SIGINT'); });

  await startPromise;
  if (stopping) {
    await stopPromise;
    return;
  }
  await writeRecord({ state: 'READY', transport: 'unix', workerKind });
}
