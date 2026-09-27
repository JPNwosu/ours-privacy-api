import express from "express";
import { errorHandler, notFoundHandler } from "./errors.js";
import { parseProcessQuery } from "./validation.js";

// The server is started in index.ts so tests can use the app without binding a port.
export function createApp() {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/process", (req, res) => {
    const query = parseProcessQuery(req.query);
    res.json(query);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
