export async function runAgentRelayLifecycle({
  daemon,
  controlPlane,
  workerKind,
  writeRecord,
  subscribeSignal,
  setExitCode,
}) {
  if (
    !controlPlane || typeof controlPlane !== 'object' || Array.isArray(controlPlane) ||
    typeof controlPlane.projectionId !== 'string' ||
    typeof controlPlane.projectionDigest !== 'string'
  ) throw new TypeError('agent relay lifecycle requires a validated control-plane projection');
  const startPromise = daemon.start();
  let stopping = false;
  let stopPromise = null;
  let daemonStopPromise = null;

  const closeDaemon = () => {
    daemonStopPromise ??= daemon.stop();
    return daemonStopPromise;
  };

  const stop = (signal) => {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      await startPromise;
      await closeDaemon();
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
  try {
    await writeRecord({ state: 'READY', transport: 'unix', workerKind, controlPlane });
  } catch (error) {
    stopping = true;
    await closeDaemon();
    throw error;
  }
}
