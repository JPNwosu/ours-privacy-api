import express from "express";

// The server is started in index.ts so tests can use the app without binding a port.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  return app;
}
