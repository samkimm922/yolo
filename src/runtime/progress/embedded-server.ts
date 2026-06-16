let progressApiServer = null;

export function startEmbeddedProgressServer(port, { log = console.log, error = console.error } = Object()) {
  if (progressApiServer) return progressApiServer;

  let server = null;
  let closeResources = null;
  let closed = false;
  let closePromise = null;

  const startup = (async () => {
    const ps = await import("./server.js");
    server = ps.server;
    closeResources = ps.closeProgressServerResources;
    if (closed) {
      if (closeResources) closeResources();
      return;
    }

    await new Promise<void>((resolve) => {
      const onListening = () => {
        cleanupListeners();
        const address = server.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        log(`[yolo-runner] 内嵌看板已启动: http://localhost:${actualPort}`);
        if (ps.startFileWatchers) ps.startFileWatchers();
        resolve();
      };
      const onError = (err) => {
        cleanupListeners();
        const dynamicError = Object.assign(Object(), err);
        if (dynamicError.code === "EADDRINUSE") {
          log(`[yolo-runner] port ${port} 已被占用，跳过内嵌看板`);
        } else {
          error(`[yolo-runner] 内嵌看板启动失败: ${dynamicError.message}`);
        }
        resolve();
      };
      const cleanupListeners = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };

      server.once("listening", onListening);
      server.once("error", onError);
      try {
        server.listen(port);
      } catch (err) {
        onError(err);
      }
    });
  })().catch((err) => {
    error(`[yolo-runner] 内嵌看板导入失败: ${err.message}`);
  });

  async function close() {
    closed = true;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await startup.catch(() => {});
      if (closeResources) {
        try { closeResources(); } catch (_) {}
      }
      if (server?.listening) {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
      if (progressApiServer === handle) progressApiServer = null;
    })();
    return closePromise;
  }

  const handle = {
    pid: process.pid,
    close,
    kill() {
      void close();
      return true;
    },
  };
  progressApiServer = handle;
  return handle;
}
