import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FleetManager } from "../fleet-manager.js";
import {
  captureFrame,
  extractHostFromRtspUrl,
  resolveCameraProtocol,
} from "../camera-client.js";
import { getCamera, setCamera, decodeIp } from "../camera-store.js";
import { LIVEVIEW_CAMERAS } from "../h2d.js";

export function registerCameraTools(
  server: McpServer,
  fleet: FleetManager,
  options: { readOnly?: boolean } = {},
): void {
  server.tool(
    "get_camera_frame",
    "Capture a live JPEG snapshot from a printer's chamber camera over the LAN and return it as an image. Supports both A1/P1 series (TLS port 6000) and X1/H2/P2 series including H2D (RTSPS port 322 via ffmpeg) with 'LAN Mode Liveview' enabled (keeps Cloud Mode / Bambu Handy working). The printer's IP is auto-detected; set the 8-digit LAN access code once via set_camera_access for cloud printers.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID (e.g. 'cloud-01S00A1234567890') or omit if only one printer"),
      ip: z
        .string()
        .optional()
        .describe("Override LAN IP (normally auto-detected from printer status)"),
      access_code: z
        .string()
        .optional()
        .describe("Override LAN access code (normally read from stored config)"),
      protocol: z
        .enum(["auto", "rtsp", "chamber"])
        .optional()
        .describe(
          "Force camera protocol ('rtsp' for X1/H2/P2 port 322, 'chamber' for A1/P1 port 6000). Default: 'auto'.",
        ),
    },
    async ({ printer, ip, access_code, protocol }) => {
      const conn = fleet.resolvePrinters(printer)[0];
      const serial = conn.config.serialNumber;

      // Inspect cached status first; pull fresh status if IP or RTSP URL isn't populated yet.
      let st = conn.mqtt.getCachedStatus();
      if (!st.net?.info?.[0]?.ip && !st.ipcam?.rtsp_url) {
        try {
          st = await conn.mqtt.requestStatus();
        } catch {}
      }

      const rtspUrl = st.ipcam?.rtsp_url;

      // Resolve LAN IP: explicit arg → MQTT net.info → ipcam.rtsp_url host → stored override → LAN config host.
      let host =
        ip ||
        decodeIp(st.net?.info?.[0]?.ip) ||
        extractHostFromRtspUrl(rtspUrl) ||
        getCamera(serial)?.ip ||
        (conn.config.mode !== "cloud" ? conn.config.host : undefined);

      const resolvedProto = resolveCameraProtocol({
        protocol,
        model: conn.config.model,
        rtspUrl,
      });

      if (resolvedProto === "rtsp" && rtspUrl === "disable") {
        return {
          content: [
            {
              type: "text" as const,
              text: `LAN Mode Liveview is disabled on ${conn.config.name} (ipcam.rtsp_url = "disable"). Enable "LAN Mode Liveview" on the printer touchscreen (Settings → Network) — this keeps Cloud Mode and Bambu Handy working.`,
            },
          ],
        };
      }

      if (!host) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Could not determine ${conn.config.name}'s LAN IP. Pass ip=..., save it via set_camera_access, or ensure the printer is online.`,
            },
          ],
        };
      }

      // Resolve access code: explicit arg → stored camera code → LAN config code.
      const code =
        access_code || getCamera(serial)?.accessCode || conn.config.accessCode;
      if (!code) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No LAN access code for ${conn.config.name}. Run set_camera_access with the 8-digit code from the printer's WLAN settings.`,
            },
          ],
        };
      }

      try {
        const jpg = await captureFrame(host, code, {
          protocol: resolvedProto,
          model: conn.config.model,
          rtspUrl,
          timeoutMs: resolvedProto === "rtsp" ? 12000 : 9000,
        });
        const viewName =
          st.ipcam?.current_liveview !== undefined
            ? LIVEVIEW_CAMERAS[st.ipcam.current_liveview]
            : undefined;
        const viewNote = viewName ? `, ${viewName} view` : "";
        return {
          content: [
            {
              type: "image" as const,
              data: jpg.toString("base64"),
              mimeType: "image/jpeg",
            },
            {
              type: "text" as const,
              text: `${conn.config.name} — live frame (${host}, ${resolvedProto.toUpperCase()}${viewNote}, ${(jpg.length / 1024).toFixed(0)} KB).`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Camera capture failed for ${conn.config.name} at ${host} (${resolvedProto.toUpperCase()}): ${err.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "set_camera_access",
    "Store the LAN access code (and optional IP) for a printer's chamber camera, so get_camera_frame can authenticate. The access code is the 8-digit code in the printer's WLAN settings.",
    {
      printer: z.string().describe("Printer ID (e.g. 'cloud-01S00A1234567890')"),
      access_code: z.string().describe("8-digit LAN access code from printer WLAN settings"),
      ip: z.string().optional().describe("Optional static LAN IP (normally auto-detected)"),
    },
    async ({ printer, access_code, ip }) => {
      const conn = fleet.resolvePrinters(printer)[0];
      setCamera(conn.config.serialNumber, { accessCode: access_code, ip });
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved camera access for ${conn.config.name} (serial ${conn.config.serialNumber}).`,
          },
        ],
      };
    },
  );

  if (!options.readOnly) {
    server.tool(
      "set_liveview_camera",
      "Switch the active liveview camera feed on multi-camera printers (e.g. H2D: 'main' chamber camera vs 'birdseye' camera).",
      {
        printer: z
          .string()
          .optional()
          .describe("Printer ID, 'all', or omit for single printer"),
        camera: z
          .enum(["main", "birdseye"])
          .describe("Which camera feed to select ('main' = 4, 'birdseye' = 5)"),
      },
      async ({ printer, camera }) => {
        const cameraId = camera === "birdseye" ? 5 : 4;
        return fleet.executeOnPrinters(printer, async (conn) => {
          await conn.mqtt.setLiveviewCamera(cameraId);
          return `Liveview camera switched to ${camera} (id ${cameraId}).`;
        });
      },
    );

    server.tool(
      "set_recording",
      "Enable or disable camera recording on a printer (or all printers).",
      {
        printer: z
          .string()
          .optional()
          .describe("Printer ID, 'all', or omit for single printer"),
        enabled: z.boolean().describe("true to enable recording, false to disable"),
      },
      async ({ printer, enabled }) => {
        return fleet.executeOnPrinters(printer, async (conn) => {
          await conn.mqtt.setCameraRecording(enabled);
          return `Camera recording ${enabled ? "enabled" : "disabled"}.`;
        });
      },
    );

    server.tool(
      "set_timelapse",
      "Enable or disable timelapse recording on a printer (or all printers).",
      {
        printer: z
          .string()
          .optional()
          .describe("Printer ID, 'all', or omit for single printer"),
        enabled: z
          .boolean()
          .describe("true to enable timelapse, false to disable"),
      },
      async ({ printer, enabled }) => {
        return fleet.executeOnPrinters(printer, async (conn) => {
          await conn.mqtt.setTimelapse(enabled);
          return `Timelapse recording ${enabled ? "enabled" : "disabled"}.`;
        });
      },
    );
  }
}
