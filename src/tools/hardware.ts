import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FleetManager } from "../fleet-manager.js";
import { isDualNozzleModel, normalizeModel } from "../h2d.js";

const SPEED_PROFILES: Record<string, number> = {
  silent: 1,
  standard: 2,
  sport: 3,
  ludicrous: 4,
};

const MAX_NOZZLE_TEMP = 300;
const MAX_H2_NOZZLE_TEMP = 350;
const MAX_BED_TEMP = 120;
const MAX_CHAMBER_TEMP = 65;

export function registerHardwareTools(
  server: McpServer,
  fleet: FleetManager,
): void {
  server.tool(
    "set_speed",
    "Set print speed on a printer (or all printers). Use a profile name or a raw percentage.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
      profile: z
        .enum(["silent", "standard", "sport", "ludicrous"])
        .optional()
        .describe("Speed profile name. Takes priority over 'percent' if both given."),
      percent: z
        .number()
        .optional()
        .describe("Raw speed percentage (50-166). Use this for fine-grained control instead of a profile."),
    },
    async ({ printer, profile, percent }) => {
      let speed: number;
      let label: string;

      if (profile) {
        speed = SPEED_PROFILES[profile];
        label = `${profile} (level ${speed})`;
      } else if (percent !== undefined) {
        if (percent < 50 || percent > 166) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Speed percent must be between 50 and 166.",
              },
            ],
          };
        }
        speed = percent;
        label = `${percent}%`;
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Specify either a profile (silent/standard/sport/ludicrous) or a percent (50-166).",
            },
          ],
        };
      }

      return fleet.executeOnPrinters(printer, async (conn) => {
        await conn.mqtt.setPrintSpeed(speed);
        return `Speed set to ${label}.`;
      });
    },
  );

  server.tool(
    "set_light",
    "Control the LED lights on a printer (or all printers). Supports chamber light and work light.",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
      light: z
        .enum(["chamber_light", "work_light"])
        .optional()
        .describe("Which light to control. Default: chamber_light"),
      mode: z.enum(["on", "off"]).describe("Turn the light on or off"),
    },
    async ({ printer, light, mode }) => {
      const node = light || "chamber_light";
      return fleet.executeOnPrinters(printer, async (conn) => {
        await conn.mqtt.setLED(mode, node);
        // H2D has a second chamber light node for the right side
        if (node === "chamber_light" && conn.config.model?.toUpperCase() === "H2D") {
          await conn.mqtt.setLED(mode, "chamber_light2");
        }
        return `${node.replace("_", " ")} turned ${mode}.`;
      });
    },
  );

  server.tool(
    "set_temperature",
    "Set nozzle, bed, or active chamber temperature on a printer. Supports targeting left/right nozzle on dual-nozzle printers (H2D/H2C/X2D). Includes safety limits (nozzle max 300°C or 350°C on H2 series, bed max 120°C, chamber max 65°C).",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
      target: z
        .enum(["nozzle", "bed", "chamber"])
        .describe("Which heater to set"),
      temperature: z
        .number()
        .describe("Target temperature in Celsius. Use 0 to turn off."),
      nozzle: z
        .enum(["active", "left", "right"])
        .optional()
        .describe(
          "Dual-nozzle printers (H2D/H2C/X2D) only: which nozzle to heat ('right' = T0, 'left' = T1, 'active' = currently active). Ignored for bed/chamber.",
        ),
    },
    async ({ printer, target, temperature, nozzle }) => {
      return fleet.executeOnPrinters(printer, async (conn) => {
        const model = normalizeModel(conn.config.model);
        const dual = isDualNozzleModel(model);
        const maxNozzle = model.startsWith("H2")
          ? MAX_H2_NOZZLE_TEMP
          : MAX_NOZZLE_TEMP;
        const maxTemp =
          target === "nozzle"
            ? maxNozzle
            : target === "bed"
              ? MAX_BED_TEMP
              : MAX_CHAMBER_TEMP;

        if (temperature < 0 || temperature > maxTemp) {
          throw new Error(
            `Temperature must be between 0 and ${maxTemp}°C for ${target}.`,
          );
        }

        let gcode: string;
        let label: string = target;

        if (target === "nozzle") {
          if (nozzle === "left" || nozzle === "right") {
            if (!dual) {
              throw new Error(
                `Printer '${conn.config.name}' (${conn.config.model || "unknown"}) is not a dual-nozzle model; omit 'nozzle' or use 'active'.`,
              );
            }
            const toolIdx = nozzle === "left" ? 1 : 0;
            gcode = `M104 T${toolIdx} S${temperature}\n`;
            label = `${nozzle} nozzle (T${toolIdx})`;
          } else {
            gcode = `M104 S${temperature}\n`;
          }
        } else if (target === "bed") {
          gcode = `M140 S${temperature}\n`;
        } else {
          // Chamber heater (H2 series / X1E): M145 toggles chamber circulation mode on H2
          if (model === "X1E") {
            gcode = `M141 S${temperature}\n`;
          } else if (temperature > 40) {
            gcode = `M145 P1\nM141 S${temperature}\n`;
          } else {
            gcode = `M141 S${temperature}\nM145 P0\n`;
          }
        }

        await conn.mqtt.sendGcode(gcode);
        return `${label} temperature set to ${temperature}°C.`;
      });
    },
  );

  server.tool(
    "set_nozzle",
    "Set the nozzle diameter on a printer (for profile selection).",
    {
      printer: z
        .string()
        .optional()
        .describe("Printer ID, 'all', or omit for single printer"),
      diameter: z
        .number()
        .describe("Nozzle diameter in mm (e.g. 0.4, 0.6, 0.8)"),
    },
    async ({ printer, diameter }) => {
      return fleet.executeOnPrinters(printer, async (conn) => {
        await conn.mqtt.setNozzle(diameter);
        return `Nozzle diameter set to ${diameter}mm.`;
      });
    },
  );
}
