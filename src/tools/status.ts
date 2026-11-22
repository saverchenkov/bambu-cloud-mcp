import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FleetManager } from "../fleet-manager.js";
import type { PrinterStatus } from "../types.js";
import {
  formatAmsUnitLabel,
  LIVEVIEW_CAMERAS,
  parseThermalAndNozzleStatus,
} from "../h2d.js";

function formatGcodeState(state: string): string {
  const states: Record<string, string> = {
    IDLE: "Idle",
    PREPARE: "Preparing",
    RUNNING: "Running",
    PAUSE: "Paused",
    FINISH: "Finished",
    FAILED: "Failed",
  };
  return states[state] || state;
}

function formatPrintStage(stage: number | string): string {
  const stages: Record<string, string> = {
    "-1": "Idle",
    "0": "Printing",
    "1": "Auto bed leveling",
    "2": "Heatbed preheating",
    "3": "Sweeping XY mech mode",
    "4": "Changing filament",
    "5": "M400 pause",
    "6": "Paused due to filament runout",
    "7": "Heating hotend",
    "8": "Calibrating extrusion",
    "9": "Scanning bed surface",
    "10": "Inspecting first layer",
    "11": "Identifying build plate type",
    "12": "Calibrating micro lidar",
    "13": "Homing toolhead",
    "14": "Cleaning nozzle tip",
    "15": "Checking extruder temperature",
    "16": "Paused by user",
    "17": "Pause - front cover falling",
    "18": "Calibrating micro lidar",
    "19": "Calibrating extrusion flow",
    "20": "Paused - nozzle temp malfunction",
    "21": "Paused - heat bed temp malfunction",
  };
  return stages[String(stage)] || `Unknown stage: ${stage}`;
}

export function formatStatusMarkdown(
  name: string,
  status: PrinterStatus,
  model?: string,
): string {
  if (!status || Object.keys(status).length === 0) {
    return `## ${name}\nNo status data available. Printer may be offline or not yet reporting.`;
  }

  const lines = [`## ${name}\n`];

  const gcodeState = status.gcode_state || "UNKNOWN";
  lines.push(`**Status:** ${formatGcodeState(gcodeState)}`);

  if (gcodeState === "RUNNING" || gcodeState === "PAUSE" || gcodeState === "PREPARE") {
    const percent = status.mc_percent ?? 0;
    lines.push(`**Progress:** ${percent}%`);

    const remaining = status.mc_remaining_time ?? 0;
    if (remaining > 0) {
      const hours = Math.floor(remaining / 60);
      const mins = remaining % 60;
      lines.push(`**Time Remaining:** ${hours}h ${mins}m`);
    }

    if (status.subtask_name) {
      lines.push(`**File:** ${status.subtask_name}`);
    }

    if (status.stg_cur !== undefined) {
      lines.push(`**Stage:** ${formatPrintStage(status.stg_cur)}`);
    }

    if (
      status.layer_num !== undefined &&
      status.total_layer_num !== undefined
    ) {
      lines.push(`**Layer:** ${status.layer_num}/${status.total_layer_num}`);
    }
  }

  const thermal = parseThermalAndNozzleStatus(status, model);

  if (thermal.isDualNozzle && thermal.activeNozzle) {
    const activeLabel =
      thermal.activeNozzle === "switching"
        ? "Switching"
        : thermal.activeNozzle === "left"
          ? "Left (T1)"
          : "Right (T0)";
    lines.push(`**Active Nozzle:** ${activeLabel}`);
  }

  lines.push("\n**Temperatures:**");
  if (thermal.isDualNozzle && thermal.nozzles.length > 0) {
    for (const n of thermal.nozzles) {
      const sideLabel = n.side === "left" ? "Left Nozzle (T1)" : "Right Nozzle (T0)";
      const activeTag =
        thermal.activeNozzle === n.side ? " [ACTIVE]" : "";
      const extras: string[] = [];
      if (n.diameter) extras.push(`${n.diameter}mm`);
      if (n.type) extras.push(n.type);
      if (n.loadedSource) extras.push(`Loaded: ${n.loadedSource}`);
      else if (n.filamentLoaded !== undefined) {
        extras.push(n.filamentLoaded ? "Filament present" : "Empty");
      }
      const suffix = extras.length ? ` · ${extras.join(" · ")}` : "";
      lines.push(
        `- ${sideLabel}${activeTag}: ${n.current ?? "N/A"}°C (Target: ${n.target ?? "N/A"}°C)${suffix}`,
      );
    }
  } else {
    const single = thermal.nozzles[0];
    const nozzle = single?.current ?? status.nozzle_temper;
    const nozzleTarget = single?.target ?? status.nozzle_target_temper;
    const extras: string[] = [];
    if (single?.diameter) extras.push(`${single.diameter}mm`);
    if (single?.type) extras.push(single.type);
    const suffix = extras.length ? ` · ${extras.join(" · ")}` : "";
    lines.push(
      `- Nozzle: ${nozzle ?? "N/A"}°C (Target: ${nozzleTarget ?? "N/A"}°C)${suffix}`,
    );
  }

  lines.push(
    `- Bed: ${thermal.bed.current ?? "N/A"}°C (Target: ${thermal.bed.target ?? "N/A"}°C)`,
  );
  if (thermal.chamber.current !== undefined) {
    const chamberTarget =
      thermal.chamber.target !== undefined
        ? ` (Target: ${thermal.chamber.target}°C)`
        : "";
    lines.push(`- Chamber: ${thermal.chamber.current}°C${chamberTarget}`);
  }

  const spdLvl = status.spd_lvl;
  if (spdLvl !== undefined) {
    const speedNames: Record<number, string> = {
      1: "Silent",
      2: "Standard",
      3: "Sport",
      4: "Ludicrous",
    };
    lines.push(`**Speed:** ${speedNames[spdLvl] || `Level ${spdLvl}`}`);
  }

  if (status.wifi_signal) {
    lines.push(`**WiFi Signal:** ${status.wifi_signal}`);
  }

  if (status.lights_report?.length) {
    const lights = status.lights_report
      .map((l: any) => `${l.node}: ${l.mode}`)
      .join(", ");
    lines.push(`**Lights:** ${lights}`);
  }

  if (status.ipcam?.rtsp_url || status.ipcam?.current_liveview !== undefined) {
    const camParts: string[] = [];
    if (status.ipcam.rtsp_url) {
      camParts.push(
        status.ipcam.rtsp_url === "disable"
          ? "LAN Liveview: disabled"
          : `LAN Liveview: enabled (${status.ipcam.rtsp_url})`,
      );
    }
    if (status.ipcam.current_liveview !== undefined) {
      const camName =
        LIVEVIEW_CAMERAS[status.ipcam.current_liveview] ||
        `camera ${status.ipcam.current_liveview}`;
      camParts.push(`Active View: ${camName}`);
    }
    if (camParts.length) {
      lines.push(`**Camera:** ${camParts.join(" · ")}`);
    }
  }

  if (status.print_error && status.print_error !== 0) {
    lines.push(
      `**Print Error:** 0x${status.print_error.toString(16).toUpperCase()} (${status.print_error})`,
    );
  }
  if (Array.isArray(status.hms) && status.hms.length > 0) {
    const codes = status.hms
      .map((h) =>
        h.attr !== undefined && h.code !== undefined
          ? `${h.attr.toString(16).padStart(8, "0").toUpperCase()}_${h.code.toString(16).padStart(8, "0").toUpperCase()}`
          : JSON.stringify(h),
      )
      .join(", ");
    lines.push(`**HMS Alerts (${status.hms.length}):** ${codes}`);
  }

  if (status.ams?.ams?.length) {
    lines.push("\n**AMS:**");
    for (const unit of status.ams.ams) {
      const unitMeta: string[] = [];
      if (unit.humidity_raw !== undefined && unit.humidity_raw !== "") {
        unitMeta.push(`${unit.humidity_raw}% RH`);
      } else if (unit.humidity !== undefined && unit.humidity !== "") {
        unitMeta.push(`Humidity lvl ${unit.humidity}/5`);
      }
      if (unit.temp !== undefined && unit.temp !== "") {
        unitMeta.push(`${unit.temp}°C`);
      }
      if (typeof unit.dry_time === "number" && unit.dry_time > 0) {
        const dh = Math.floor(unit.dry_time / 60);
        const dm = unit.dry_time % 60;
        unitMeta.push(`Drying: ${dh > 0 ? `${dh}h ` : ""}${dm}m left`);
      }
      const metaSuffix = unitMeta.length ? ` (${unitMeta.join(", ")})` : "";
      lines.push(`- **${formatAmsUnitLabel(unit.id)}**${metaSuffix}`);
      if (unit.tray) {
        for (const tray of unit.tray) {
          const color = tray.tray_color
            ? `#${tray.tray_color.slice(0, 6)}`
            : "unknown";
          const material = tray.tray_sub_brands || tray.tray_type || "empty";
          const remain =
            typeof tray.remain === "number" && tray.remain >= 0
              ? ` · ${tray.remain}%`
              : "";
          lines.push(
            `  - Slot ${Number(tray.id) + 1} (tray ${tray.id}): ${material} (${color})${remain}`,
          );
        }
      }
    }
  }

  return lines.join("\n");
}

export function registerStatusTools(
  server: McpServer,
  fleet: FleetManager,
): void {
  server.tool(
    "get_status",
    "Get current status of a printer (or all printers). Shows print progress, temperatures, speed, AMS, lights, etc.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
      detailed: z
        .boolean()
        .optional()
        .describe(
          "Request full status push from printer (slower but fresh data). Default: false (use cached).",
        ),
      format: z
        .enum(["markdown", "json"])
        .optional()
        .describe("Output format. Default: markdown"),
    },
    async ({ printer, detailed, format }) => {
      const printers = fleet.resolvePrinters(printer);

      const results = await Promise.allSettled(
        printers.map(async (conn) => {
          const status = detailed
            ? await conn.mqtt.requestStatus()
            : conn.mqtt.getCachedStatus();

          if (format === "json") {
            const label =
              printers.length > 1
                ? `${conn.config.name || conn.config.id}: `
                : "";
            return `${label}${JSON.stringify(status, null, 2)}`;
          }

          return formatStatusMarkdown(
            conn.config.name || conn.config.id,
            status,
            conn.config.model,
          );
        }),
      );

      const text = results
        .map((r, i) =>
          r.status === "fulfilled"
            ? r.value
            : `## ${printers[i].config.name || printers[i].config.id}\nError: ${(r as PromiseRejectedResult).reason?.message || r.reason}`,
        )
        .join("\n\n---\n\n");

      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "get_version",
    "Get firmware and module version information from a printer.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
    },
    async ({ printer }) => {
      return fleet.executeOnPrinters(printer, async (conn) => {
        const version = await conn.mqtt.getVersion();
        return JSON.stringify(version, null, 2);
      });
    },
  );
}
