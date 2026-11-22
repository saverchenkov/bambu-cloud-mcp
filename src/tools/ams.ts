import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FleetManager } from "../fleet-manager.js";

export function registerAmsTools(
  server: McpServer,
  fleet: FleetManager,
): void {
  server.tool(
    "change_filament",
    "Change to a different AMS filament tray on a printer.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID or omit for single printer"),
      tray: z
        .number()
        .describe(
          "AMS tray index: 0-3 for AMS A, 4-15 for additional AMS units (B-D), 128-135 for AMS HT, or 254 for external spool",
        ),
      target_temp: z
        .number()
        .optional()
        .describe("Target temperature for the filament change (°C). Optional."),
    },
    async ({ printer, tray, target_temp }) => {
      const valid =
        (tray >= 0 && tray <= 15) ||
        (tray >= 128 && tray <= 135) ||
        tray === 254;
      if (!valid) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Tray number must be 0-15 (AMS units A-D), 128-135 (AMS HT), or 254 (external spool).",
            },
          ],
        };
      }

      return fleet.executeOnPrinters(printer, async (conn) => {
        await conn.mqtt.changeFilament(tray, target_temp);
        return `Changing to AMS tray ${tray}.`;
      });
    },
  );

  server.tool(
    "unload_filament",
    "Unload the current filament from the extruder on a printer (or all printers).",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
    },
    async ({ printer }) => {
      return fleet.executeOnPrinters(printer, async (conn) => {
        await conn.mqtt.unloadFilament();
        return "Filament unload initiated.";
      });
    },
  );
}
