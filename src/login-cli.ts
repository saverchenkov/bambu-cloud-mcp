#!/usr/bin/env node
/**
 * Interactive Bambu cloud login. Run in your own terminal:
 *
 *   npm run login
 *
 * Prompts for region / email / password (and an email or 2FA code if your
 * account requires one), then stores an access token in ~/.bambu-mcp/cloud.json
 * so the MCP server can control your printers over the cloud.
 *
 * Your password is only sent to Bambu's login API — it is never stored.
 */

import * as readline from "readline";
import { Writable } from "stream";
import {
  login,
  requestEmailCode,
  loginWithCode,
  loginWithTfa,
  listDevices,
  getAccountUsername,
  type LoginResult,
} from "./bambu-cloud.js";
import { saveCloud, getCloudPath, type CloudCredentials } from "./cloud-store.js";
import { addPrinterToConfig } from "./config.js";
import { mqttHostForRegion } from "./cloud-store.js";

function ask(question: string, muted = false): Promise<string> {
  const mutable = new Writable({
    write(chunk, _enc, cb) {
      if (!(mutable as any).muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({
    input: process.stdin,
    output: mutable,
    terminal: true,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      if (muted) process.stdout.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    (mutable as any).muted = muted;
  });
}

async function main() {
  console.log("=== Bambu Lab cloud login ===\n");
  const regionInput = (await ask("Region [US]/China: ")) || "US";
  const region = regionInput.toLowerCase().startsWith("ch") ? "China" : "US";
  const email = await ask("Bambu account email: ");
  console.log(
    "\nLogin method:\n  1) Email code — no password needed (a code is emailed to you)\n  2) Password",
  );
  const method = (await ask("Choose [1]: ")) || "1";

  let result: LoginResult;

  if (method === "2") {
    const password = await ask("Password (hidden): ", true);
    console.log("\nLogging in...");
    result = await login(email, password, region);
  } else {
    // Passwordless: request an email code and log in with it.
    console.log("\nRequesting an email verification code...");
    try {
      await requestEmailCode(email, region);
      console.log(`A code was emailed to ${email}.`);
    } catch (e: any) {
      console.log(`(Could not auto-request a code: ${e.message})`);
      console.log("Check your inbox anyway — Bambu may have sent one.");
    }
    const code = await ask("Enter the emailed code: ");
    result = await loginWithCode(email, code, region);
  }

  if (result.status === "verifyCode") {
    console.log("Account requires an email verification code. Requesting one...");
    try {
      await requestEmailCode(email, region);
      console.log("A code was emailed to you.");
    } catch (e: any) {
      console.log(`(Could not auto-request a code: ${e.message})`);
      console.log("Bambu may have emailed one anyway — check your inbox.");
    }
    const code = await ask("Enter the emailed code: ");
    result = await loginWithCode(email, code, region);
  } else if (result.status === "tfa") {
    console.log("Account has two-factor (authenticator app) enabled.");
    const code = await ask("Enter your 6-digit 2FA code: ");
    result = await loginWithTfa(result.tfaKey!, code);
  }

  if (result.status !== "success" || !result.accessToken) {
    console.error(`\nLogin failed: ${result.message || result.status}`);
    process.exit(1);
  }

  // The JWT doesn't always carry the MQTT username — resolve it from the API,
  // falling back to manual entry if Bambu's profile endpoint is gated by Cloudflare.
  if (!result.username) {
    try {
      result.username = await getAccountUsername(result.accessToken, region);
    } catch (e: any) {
      console.log(
        `\nLogged in, but automatic MQTT user ID lookup failed (${e.message.slice(0, 140)}).`,
      );
      console.log(
        "Your login token is valid — you can enter your Bambu numeric user ID manually to finish.",
      );
      console.log(
        "(Tip: On Windows, Bambu Studio stores it as `uid` in %APPDATA%\\BambuStudio\\BambuStudio.conf, or find your `u_<digits>` ID on MakerWorld / Bambu Studio logs.)",
      );
      const manualUid = await ask("Bambu user ID (digits or u_<digits>): ");
      if (!manualUid) {
        console.error("Aborted: MQTT user ID is required to connect to Bambu Cloud MQTT.");
        process.exit(1);
      }
      result.username = manualUid.startsWith("u_") ? manualUid : `u_${manualUid}`;
    }
  }
  console.log(`  MQTT user: ${result.username}`);

  const creds: CloudCredentials = {
    region,
    email,
    username: result.username,
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    savedAt: new Date().toISOString(),
  };
  saveCloud(creds);
  console.log(`\n✔ Logged in. Credentials saved to ${getCloudPath()}`);
  if (result.expiresAt) {
    console.log(`  Token expires: ${new Date(result.expiresAt * 1000).toLocaleString()}`);
  }

  console.log("\nDiscovering printers on your account...");
  try {
    const devices = await listDevices(result.accessToken, region);
    if (devices.length === 0) {
      console.log("No printers are bound to this account.");
    } else {
      for (const d of devices) {
        console.log(
          `  • ${d.name}  [${d.model || "?"}]  serial=${d.dev_id}  ${d.online ? "online" : "offline"}`,
        );
      }
      console.log(
        "\nThe MCP server will auto-connect these on next start. You can also run the `sync_cloud_printers` tool.",
      );
    }
  } catch (e: any) {
    console.log(`Could not auto-list cloud printers (${e.message.slice(0, 140)}).`);
    console.log(
      "You can still register your cloud printer directly (it will connect straight to Bambu Cloud MQTT without needing the device-list API).",
    );
    const serial = await ask(
      "Printer serial number (from printer touchscreen Settings → Device, or leave blank to skip): ",
    );
    if (serial) {
      const name = (await ask("Friendly printer name [My Bambu]: ")) || "My Bambu";
      const model = (await ask("Printer model (e.g. H2D, X1C, P1S, A1) [H2D]: ")) || "H2D";
      const id = `cloud-${serial}`;
      addPrinterToConfig({
        id,
        name: `${name} (cloud)`,
        host: mqttHostForRegion(region),
        accessCode: "",
        serialNumber: serial,
        model,
        mode: "cloud",
        region,
      });
      console.log(`\n✔ Saved cloud printer '${name}' (\`${id}\`, model ${model}).`);
      console.log("The MCP server will auto-connect directly over Bambu Cloud MQTT on next start.");
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message || err);
  process.exit(1);
});
