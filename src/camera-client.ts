import * as tls from "tls";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { isRtspCameraModel } from "./h2d.js";

/**
 * Grab a single JPEG snapshot from a Bambu Lab printer's chamber camera over the LAN.
 *
 * Supports both Bambu LAN camera protocols:
 *   1. **RTSPS (TCP port 322)** — used by X1 / X1C / X1E / H2D / H2S / H2C / P2S.
 *      Captures a single MJPEG frame via `ffmpeg` from
 *      `rtsps://bblp:<access_code>@<ip>:322/streaming/live/1` (or `status.ipcam.rtsp_url`).
 *   2. **Chamber-image over TLS (TCP port 6000)** — used by A1 / A1 Mini / P1P / P1S.
 *      Sends the 80-byte binary auth packet and parses the 16-byte header + JPEG frame.
 *
 * Both protocols require "LAN Mode Liveview" enabled on the printer (Settings),
 * which is independent of full LAN-Only mode — Bambu Handy keeps working.
 */

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

export type CameraProtocol = "auto" | "rtsp" | "chamber";

export interface CaptureOptions {
  /** Override protocol selection. Default: "auto" (uses RTSPS for X1/H2/P2 or when rtspUrl is reported). */
  protocol?: CameraProtocol;
  /** Printer model name (e.g. "H2D", "X1C", "A1") for auto-selecting RTSPS vs port-6000. */
  model?: string;
  /** Reported `status.ipcam.rtsp_url` from MQTT status, if available. */
  rtspUrl?: string;
  /** Override TCP port (default: 322 for RTSPS, 6000 for chamber-image). */
  port?: number;
  /** Capture timeout in milliseconds (default: 8000 for port-6000, 12000 for RTSPS). */
  timeoutMs?: number;
  /** Override path to `ffmpeg` executable (defaults to BAMBU_FFMPEG_PATH or PATH). */
  ffmpegPath?: string;
}

function buildAuthPacket(username: string, accessCode: string): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x40, 0); // payload length that follows (64 bytes)
  header.writeUInt32LE(0x3000, 4);
  header.writeUInt32LE(0x0, 8);
  header.writeUInt32LE(0x0, 12);
  const user = Buffer.alloc(32);
  Buffer.from(username, "ascii").copy(user);
  const code = Buffer.alloc(32);
  Buffer.from(accessCode, "ascii").copy(code);
  return Buffer.concat([header, user, code]);
}

function redactCredentials(text: string): string {
  return text.replace(/bblp:[^@\s]+@/gi, "bblp:***@");
}

/** Extract the LAN IP/hostname from a printer's reported `ipcam.rtsp_url`, if usable. */
export function extractHostFromRtspUrl(reportedUrl?: string): string | undefined {
  if (!reportedUrl || reportedUrl === "disable") return undefined;
  try {
    const parsed = new URL(reportedUrl);
    if (parsed.protocol !== "rtsp:" && parsed.protocol !== "rtsps:") {
      return undefined;
    }
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build an authenticated RTSP/RTSPS URL for X1/H2-series printers.
 * Throws a descriptive error if `reportedUrl === "disable"`.
 */
export function buildAuthenticatedRtspUrl(
  host: string,
  accessCode: string,
  reportedUrl?: string,
  defaultPort = 322,
  defaultPath = "/streaming/live/1",
): string {
  if (reportedUrl === "disable") {
    throw new Error(
      'LAN Mode Liveview is disabled on this printer (ipcam.rtsp_url = "disable"). Enable "LAN Mode Liveview" on the printer touchscreen (Settings → Network) — this keeps Cloud Mode and Bambu Handy working.',
    );
  }

  let protocol = "rtsps:";
  let resolvedHost = host;
  let port = String(defaultPort);
  let pathname = defaultPath;
  let search = "";

  if (reportedUrl && /^rtsps?:\/\//i.test(reportedUrl)) {
    try {
      const parsed = new URL(reportedUrl);
      protocol = parsed.protocol;
      resolvedHost = host || parsed.hostname;
      port = parsed.port || String(defaultPort);
      pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : defaultPath;
      search = parsed.search || "";
    } catch {
      // Fall back to constructing the default URL from host/port/path
    }
  }

  const hostPart =
    resolvedHost.includes(":") && !resolvedHost.startsWith("[")
      ? `[${resolvedHost}]`
      : resolvedHost;

  return `${protocol}//bblp:${encodeURIComponent(accessCode)}@${hostPart}:${port}${pathname}${search}`;
}

/** Resolve which protocol to use for a given capture request. */
export function resolveCameraProtocol(opts: CaptureOptions): "rtsp" | "chamber" {
  if (opts.protocol === "rtsp") return "rtsp";
  if (opts.protocol === "chamber") return "chamber";
  if (
    opts.rtspUrl === "disable" ||
    (opts.rtspUrl && /^rtsps?:\/\//i.test(opts.rtspUrl)) ||
    isRtspCameraModel(opts.model)
  ) {
    return "rtsp";
  }
  return "chamber";
}

function findFallbackFfmpeg(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const localAppData =
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(localAppData, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
    "C:\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

function runFfmpegSnapshot(
  ffmpegBin: string,
  rtspUrl: string,
  timeoutMs: number,
): Promise<Buffer> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-tls_verify",
    "0",
    "-i",
    rtspUrl,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "3",
    "pipe:1",
  ];

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegBin,
      args,
      {
        encoding: "buffer",
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            const installHint =
              process.platform === "win32"
                ? "Install it via `winget install Gyan.FFmpeg` (then restart your client), or set BAMBU_FFMPEG_PATH."
                : process.platform === "darwin"
                  ? "Install it via `brew install ffmpeg`, or set BAMBU_FFMPEG_PATH."
                  : "Install `ffmpeg` via your package manager, or set BAMBU_FFMPEG_PATH.";
            const notFound = new Error(
              `RTSPS camera capture requires \`ffmpeg\`, but '${ffmpegBin}' was not found. ${installHint}`,
            ) as NodeJS.ErrnoException;
            notFound.code = "ENOENT";
            reject(notFound);
            return;
          }
          if ((err as any).killed) {
            reject(
              new Error(
                `RTSPS camera timeout after ${timeoutMs}ms (verify "LAN Mode Liveview" is enabled on the printer, the 8-char LAN access code is right, and this machine is on the same network).`,
              ),
            );
            return;
          }
          const detail = redactCredentials(
            (stderr ? stderr.toString("utf-8").trim() : "") || err.message,
          );
          reject(new Error(`ffmpeg RTSPS capture failed: ${detail}`));
          return;
        }

        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        const start = buf.indexOf(JPEG_START);
        if (start < 0) {
          const detail = redactCredentials(
            stderr ? stderr.toString("utf-8").trim() : "",
          );
          reject(
            new Error(
              `RTSPS stream returned no JPEG frame${detail ? `: ${detail}` : ""}.`,
            ),
          );
          return;
        }
        const end = buf.lastIndexOf(JPEG_END);
        resolve(end > start ? buf.subarray(start, end + 2) : buf.subarray(start));
      },
    );
  });
}

/**
 * Capture one JPEG frame from an X1 / H2 / P2 printer over RTSPS (port 322) using ffmpeg.
 */
export async function captureRtspFrame(
  host: string,
  accessCode: string,
  opts: CaptureOptions = {},
): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const rtspUrl = buildAuthenticatedRtspUrl(
    host,
    accessCode,
    opts.rtspUrl,
    opts.port ?? 322,
  );
  const primaryBin = opts.ffmpegPath || process.env.BAMBU_FFMPEG_PATH || "ffmpeg";

  try {
    return await runFfmpegSnapshot(primaryBin, rtspUrl, timeoutMs);
  } catch (err: any) {
    if (err?.code === "ENOENT" && primaryBin === "ffmpeg") {
      const fallback = findFallbackFfmpeg();
      if (fallback) {
        return runFfmpegSnapshot(fallback, rtspUrl, timeoutMs);
      }
    }
    throw err;
  }
}

/**
 * Capture one JPEG frame from an A1 / A1 Mini / P1P / P1S printer over TLS port 6000.
 */
export function captureChamberImageFrame(
  host: string,
  accessCode: string,
  opts: CaptureOptions = {},
): Promise<Buffer> {
  const port = opts.port ?? 6000;
  const timeoutMs = opts.timeoutMs ?? 8000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    let expected = -1; // expected JPEG length once header is parsed

    const socket = tls.connect(
      { host, port, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        socket.write(buildAuthPacket("bblp", accessCode));
      },
    );

    const done = (err: Error | null, data?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {}
      if (err) reject(err);
      else resolve(data!);
    };

    const timer = setTimeout(
      () =>
        done(
          new Error(
            `Camera timeout after ${timeoutMs}ms (is "LAN Mode Liveview" enabled on the printer, and is this machine on the same network as ${host}?)`,
          ),
        ),
      timeoutMs,
    );

    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);

      // Parse the 16-byte frame header to learn the JPEG length.
      if (expected < 0 && buf.length >= 16) {
        const len = buf.readUInt32LE(0);
        if (len > 0 && len < 8_000_000) {
          expected = len;
          buf = buf.subarray(16);
        } else {
          // Header didn't look sane — fall back to JPEG marker scanning.
          const start = buf.indexOf(JPEG_START);
          if (start >= 0) buf = buf.subarray(start);
        }
      }

      if (expected > 0 && buf.length >= expected) {
        const frame = buf.subarray(0, expected);
        if (frame.subarray(0, 3).equals(JPEG_START)) return done(null, frame);
        // Length-based framing was off; try marker-based extraction instead.
      }

      // Marker-based fallback: complete JPEG between SOI and EOI.
      const s = buf.indexOf(JPEG_START);
      if (s >= 0) {
        const e = buf.indexOf(JPEG_END, s + 3);
        if (e >= 0) return done(null, buf.subarray(s, e + 2));
      }
    });

    socket.on("timeout", () => done(new Error("Camera socket timed out.")));
    socket.on("error", (err) => done(err));
    socket.on("close", () => {
      if (!settled) done(new Error("Camera connection closed before a full frame arrived."));
    });
  });
}

/** Capture one JPEG frame using the appropriate protocol for the printer model. */
export function captureFrame(
  host: string,
  accessCode: string,
  opts: CaptureOptions = {},
): Promise<Buffer> {
  const protocol = resolveCameraProtocol(opts);
  if (protocol === "rtsp") {
    return captureRtspFrame(host, accessCode, opts);
  }
  return captureChamberImageFrame(host, accessCode, opts);
}
