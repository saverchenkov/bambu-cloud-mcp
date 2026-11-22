#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FleetManager } from "./fleet-manager.js";
import { loadConfig } from "./config.js";
import { registerManagementTools } from "./tools/management.js";
import { registerStatusTools } from "./tools/status.js";
import { registerPrintControlTools } from "./tools/print-control.js";
import { registerHardwareTools } from "./tools/hardware.js";
import { registerFileTools } from "./tools/files.js";
import { registerCameraTools } from "./tools/camera.js";
import { registerAmsTools } from "./tools/ams.js";
import { registerGcodeTools } from "./tools/gcode.js";
import { registerSigningTools } from "./tools/signing.js";
import { registerCloudTools, syncCloudPrinters } from "./tools/cloud.js";
import { loadCloud } from "./cloud-store.js";

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.BAMBU_READ_ONLY || "");

const server = new McpServer({
  name: "bambu-farm",
  version: "1.0.0",
});

const fleet = new FleetManager();

// Always register read-only status, fleet listing/reconnect, cloud sync, and LAN snapshot tools
registerManagementTools(server, fleet, { readOnly: READ_ONLY });
registerStatusTools(server, fleet);
registerCameraTools(server, fleet, { readOnly: READ_ONLY });
registerCloudTools(server, fleet, { readOnly: READ_ONLY });

if (!READ_ONLY) {
  registerPrintControlTools(server, fleet);
  registerHardwareTools(server, fleet);
  registerFileTools(server, fleet);
  registerAmsTools(server, fleet);
  registerGcodeTools(server, fleet);
  registerSigningTools(server);
} else {
  console.error(
    "Running in READ-ONLY mode (BAMBU_READ_ONLY=true); write and printer-control tools are disabled.",
  );
}

// Connect to all configured printers on startup
async function connectConfiguredPrinters(): Promise<void> {
  const config = loadConfig();
  if (config.printers.length === 0) {
    console.error(
      "No printers configured. Use add_printer or run `npm run login` + sync_cloud_printers.",
    );
    return;
  }

  console.error(`Found ${config.printers.length} configured printer(s).`);

  const results = await Promise.allSettled(
    config.printers.map(async (printer) => {
      try {
        await fleet.connectPrinter(printer);
        console.error(`Connected to ${printer.name} (${printer.id}).`);
      } catch (err: any) {
        console.error(
          `Failed to connect to ${printer.name} (${printer.id}): ${err.message}`,
        );
      }
    }),
  );

  const connected = results.filter((r) => r.status === "fulfilled").length;
  console.error(
    `${connected}/${config.printers.length} printer(s) connected.`,
  );
}

async function main(): Promise<void> {
  // Start MCP server first so it's available immediately
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Bambu Farm MCP server running on stdio.");

  // Connect to printers in the background — don't block startup
  connectConfiguredPrinters()
    .then(async () => {
      // If logged in to Bambu cloud, discover + connect any cloud printers.
      if (loadCloud()) {
        try {
          const res = await syncCloudPrinters(fleet);
          if (res.error) {
            console.error(`Cloud sync: ${res.error}`);
          } else if (res.devices.length > 0) {
            console.error(
              `Cloud: ${res.connected.length}/${res.devices.length} cloud printer(s) connected.`,
            );
          }
        } catch (err: any) {
          console.error("Cloud sync error:", err.message);
        }
      }
    })
    .catch((err) => {
      console.error("Printer connection error:", err.message);
    });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
