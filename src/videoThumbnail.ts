import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ApiError } from "./errors.js";
import { MAX_DIMENSION } from "./validation.js";

export const FFMPEG_TIMEOUT_MS = 15_000;

// ffmpeg demuxer names: "mov" covers mp4 and mov, "matroska" and "webm" cover mkv and webm.
// Anything else, notably HLS playlists that can reference other URLs or local files, is refused.
const ALLOWED_CONTAINERS = "mov,matroska,webm";

const MAX_FRAME_BYTES = 100 * 1024 * 1024;

const execFileAsync = promisify(execFile);

// ffmpeg-static is CommonJS (module.exports = path) but its types declare an ES default export.
const ffmpegPath: string | null = createRequire(import.meta.url)("ffmpeg-static");

export async function extractFrame(video: Buffer, timeSeconds: number): Promise<Buffer> {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");

  const directory = await mkdtemp(path.join(os.tmpdir(), "video-thumbnail-"));
  // No file extension, so ffmpeg identifies the container from its content alone.
  const input = path.join(directory, "source");
  try {
    await writeFile(input, video);
    const { stdout, stderr } = await runFfmpeg(ffmpegPath, input, timeSeconds);
    if (stdout.length === 0) throw timePastEnd(stderr);
    return stdout;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runFfmpeg(binary: string, input: string, timeSeconds: number) {
  const args = [
    ...["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info"],
    ...["-protocol_whitelist", "file", "-format_whitelist", ALLOWED_CONTAINERS],
    ...["-ss", String(timeSeconds), "-i", input],
    ...["-frames:v", "1", "-an"],
    // Frames never need to exceed the largest output size, which bounds memory for 8K video.
    "-vf",
    `scale=w='min(iw,${MAX_DIMENSION})':h='min(ih,${MAX_DIMENSION})':force_original_aspect_ratio=decrease`,
    ...["-f", "image2pipe", "-c:v", "png", "pipe:1"],
  ];

  try {
    return await execFileAsync(binary, args, {
      encoding: "buffer",
      maxBuffer: MAX_FRAME_BYTES,
      timeout: FFMPEG_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error instanceof Error && "killed" in error && error.killed) {
      throw new ApiError(
        "UNSUPPORTED_SOURCE",
        `Video could not be processed within ${FFMPEG_TIMEOUT_MS / 1000} seconds`,
      );
    }
    console.error("ffmpeg failed:", error);
    throw new ApiError(
      "UNSUPPORTED_SOURCE",
      "Source could not be read as a video; expected mp4, mov, webm or mkv",
    );
  }
}

// ffmpeg exits successfully with no frame when seeking past the end, so explain why.
function timePastEnd(stderr: Buffer): ApiError {
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr.toString());
  const lengthNote = duration
    ? ` (the video is ${(Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])).toFixed(1)} seconds long)`
    : "";
  return new ApiError("INVALID_PARAMETERS", "Invalid query parameters", [
    { param: "time", message: `time is past the end of the video${lengthNote}` },
  ]);
}
