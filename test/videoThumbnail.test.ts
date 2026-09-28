import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_DIMENSION } from "../src/validation.js";
import { extractFrame } from "../src/videoThumbnail.js";
import { colorVideo } from "./helpers/video.js";

let redThenBlue: Buffer;

beforeAll(async () => {
  redThenBlue = await colorVideo(["red", "blue"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function dominantColor(frame: Buffer): Promise<"red" | "green" | "blue" | "other"> {
  const [red = 0, green = 0, blue = 0] = await sharp(frame).removeAlpha().raw().toBuffer();
  if (red > 200 && green < 80 && blue < 80) return "red";
  if (green > 100 && red < 80 && blue < 80) return "green";
  if (blue > 200 && red < 80 && green < 80) return "blue";
  return "other";
}

function silenceFfmpegLogs() {
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("extractFrame", () => {
  it.each([
    [0, "red"],
    [0.5, "red"],
    [1.5, "blue"],
  ] as const)("returns the frame at %s seconds as a png", async (time, color) => {
    const frame = await extractFrame(redThenBlue, time);

    expect((await sharp(frame).metadata()).format).toBe("png");
    expect(await dominantColor(frame)).toBe(color);
  });

  it("reads webm as well as mp4", async () => {
    const webm = await colorVideo(["green"], { container: "webm" });

    expect(await dominantColor(await extractFrame(webm, 0.2))).toBe("green");
  });

  it("caps frames at the largest output size, keeping the aspect ratio", async () => {
    const wide = await colorVideo(["red"], { width: 6000, height: 60 });

    const { width, height } = await sharp(await extractFrame(wide, 0)).metadata();

    expect({ width, height }).toEqual({ width: MAX_DIMENSION, height: 50 });
  });

  it("rejects a time past the end with 400, telling the client the video's length", async () => {
    await expect(extractFrame(redThenBlue, 5)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PARAMETERS",
      details: [{ param: "time", message: "time is past the end of the video (the video is 2.0 seconds long)" }],
    });
  });

  it("rejects bytes that are not a video with 415", async () => {
    silenceFfmpegLogs();

    await expect(
      extractFrame(Buffer.from("<!doctype html><p>Please log in</p>"), 0),
    ).rejects.toMatchObject({ status: 415, code: "UNSUPPORTED_SOURCE" });
  });

  it("refuses HLS playlists, which could make ffmpeg read files on the server", async () => {
    silenceFfmpegLogs();
    // A real, playable file on "the server". If ffmpeg followed the playlist, we would get its frame back.
    const directory = await mkdtemp(path.join(os.tmpdir(), "private-"));
    const privateVideo = path.join(directory, "private.mp4");
    await writeFile(privateVideo, redThenBlue);
    const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nfile://${privateVideo}\n#EXT-X-ENDLIST\n`;

    try {
      await expect(extractFrame(Buffer.from(playlist), 0)).rejects.toMatchObject({ status: 415 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects container formats outside the allowlist, such as an image", async () => {
    silenceFfmpegLogs();
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "red" } })
      .png()
      .toBuffer();

    await expect(extractFrame(png, 0)).rejects.toMatchObject({ status: 415 });
  });
});
