let progressApiServer = null;

export async function startEmbeddedProgressServer(port, { log = console.log, error = console.error } = Object()) {
  if (progressApiServer) return;
  try {
    const ps = await import("./server.js");
    const server = ps.server;
    const startWatchers = ps.startFileWatchers;
    server.listen(port, () => {
      log(`[yolo-runner] 内嵌看板已启动: http://localhost:${port}`);
      if (startWatchers) startWatchers();
    }).on("error", (err) => {
      const dynamicError = Object.assign(Object(), err);
      if (dynamicError.code === "EADDRINUSE") {
        log(`[yolo-runner] port ${port} 已被占用，跳过内嵌看板`);
      } else {
        error(`[yolo-runner] 内嵌看板启动失败: ${dynamicError.message}`);
      }
    });
    progressApiServer = server;
  } catch (err) {
    error(`[yolo-runner] 内嵌看板导入失败: ${err.message}`);
  }
}
