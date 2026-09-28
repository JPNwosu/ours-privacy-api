import express from "express";
import { errorHandler, notFoundHandler } from "./errors.js";
import { fetchImage } from "./fetchImage.js";
import { transformImage } from "./transform.js";
import { parseProcessQuery } from "./validation.js";

export type AppDependencies = {
  fetchImage: (url: string) => Promise<Buffer>;
};

const defaultDependencies: AppDependencies = { fetchImage };

// The server is started in index.ts so tests can use the app without binding a port.
// Tests inject fetchImage because its SSRF guard rightly blocks a local image server.
export function createApp(dependencies: AppDependencies = defaultDependencies) {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/process", async (req, res) => {
    const { url, ...options } = parseProcessQuery(req.query);
    const source = await dependencies.fetchImage(url);
    const { data, format } = await transformImage(source, options);
    res.type(format).send(data);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
