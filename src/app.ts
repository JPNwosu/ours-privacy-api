import express from "express";
import { errorHandler, notFoundHandler } from "./errors.js";
import { fetchImage, fetchVideo } from "./fetchSource.js";
import { transformImage } from "./transform.js";
import { parseProcessQuery, parseVideoThumbnailQuery } from "./validation.js";
import { extractFrame } from "./videoThumbnail.js";

export type AppDependencies = {
  fetchImage: (url: string) => Promise<Buffer>;
  fetchVideo: (url: string) => Promise<Buffer>;
};

const defaultDependencies: AppDependencies = { fetchImage, fetchVideo };

// The server is started in index.ts so tests can use the app without binding a port.
// Tests inject the fetchers because their SSRF guard rightly blocks a local test server.
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

  app.get("/video/thumbnail", async (req, res) => {
    const { url, time = 0, ...options } = parseVideoThumbnailQuery(req.query);
    const video = await dependencies.fetchVideo(url);
    const frame = await extractFrame(video, time);
    // Video frames are photographic, so jpeg is a far smaller default than the frame's png.
    const { data, format } = await transformImage(frame, {
      ...options,
      format: options.format ?? "jpeg",
    });
    res.type(format).send(data);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
