import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const ffmpegPath: string = createRequire(import.meta.url)("ffmpeg-static");

// Builds a video from solid-color segments, e.g. one second of red then one of blue,
// so a test can tell which moment a frame came from by its color.
export async function colorVideo(
  colors: string[],
  { width = 160, height = 120, container = "mp4" }: { width?: number; height?: number; container?: "mp4" | "webm" } = {},
): Promise<Buffer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "test-video-"));
  const output = path.join(directory, `video.${container}`);
  const inputs = colors.flatMap((color) => ["-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:d=1`]);
  const concat = `${colors.map((_, index) => `[${index}]`).join("")}concat=n=${colors.length}:v=1`;
  try {
    await promisify(execFile)(ffmpegPath, [
      ...["-hide_banner", "-loglevel", "error", ...inputs],
      ...["-filter_complex", concat, "-pix_fmt", "yuv420p", output],
    ]);
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
