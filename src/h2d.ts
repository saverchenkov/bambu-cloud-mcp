import type { PrinterStatus } from "./types.js";

/** Models with dual independent nozzles (right = index 0 / T0, left = index 1 / T1). */
const DUAL_NOZZLE_MODELS = new Set([
  "H2D",
  "H2D PRO",
  "H2DPRO",
  "H2C",
  "X2D",
]);

/** Models whose LAN camera uses RTSPS on port 322 rather than TLS port 6000 chamber-image. */
const RTSP_CAMERA_MODELS = new Set([
  "X1",
  "X1C",
  "X1E",
  "X1 CARBON",
  "H2D",
  "H2D PRO",
  "H2DPRO",
  "H2S",
  "H2C",
  "X2D",
  "P2S",
]);

/** Liveview camera IDs reported by H2 series in status.ipcam.current_liveview. */
export const LIVEVIEW_CAMERAS: Record<number, string> = {
  4: "main",
  5: "birdseye",
};

export function normalizeModel(model?: string): string {
  return (model || "").toUpperCase().trim();
}

export function isDualNozzleModel(model?: string): boolean {
  const m = normalizeModel(model);
  if (!m) return false;
  if (DUAL_NOZZLE_MODELS.has(m)) return true;
  return m.startsWith("H2D") || m.startsWith("H2C") || m.startsWith("X2D");
}

export function isRtspCameraModel(model?: string): boolean {
  const m = normalizeModel(model);
  if (!m) return false;
  if (RTSP_CAMERA_MODELS.has(m)) return true;
  return (
    m.startsWith("X1") ||
    m.startsWith("X2") ||
    m.startsWith("H2") ||
    m.startsWith("P2")
  );
}

/**
 * Decode Bambu's packed 32-bit temperature value used in newer H2-series
 * telemetry (`device.extruder.info[].temp`, `device.bed.info.temp`, `device.ctc.info.temp`).
 * Low 16 bits = current °C, high 16 bits = target °C.
 */
export function decodePackedTemp(packed: number): {
  current: number;
  target: number;
} {
  const current = packed & 0xffff;
  const target = (packed >>> 16) & 0xffff;
  return { current, target };
}

/** Decode Bambu nozzle type codes (e.g. "HS01", "HH01", "HU01") or legacy names. */
export function decodeNozzleType(code?: string): string | undefined {
  if (!code) return undefined;
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  // H2-series 4-char codes like HS01, HH01, HE01, HU01, HS00, HS05
  if (/^[A-Z]{2}\d{2}$/i.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    if (upper[1] === "U") return "TPU High-Flow";
    const flowPrefix =
      upper[1] === "H" || upper[1] === "E" ? "High-Flow " : "";
    const materials: Record<string, string> = {
      "00": "Stainless Steel",
      "01": "Hardened Steel",
      "05": "Tungsten Carbide",
    };
    const mat = materials[upper.slice(2, 4)];
    return mat ? `${flowPrefix}${mat}` : trimmed;
  }

  // Legacy snake_case values like "hardened_steel"
  return trimmed
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

/**
 * Format an AMS unit ID into a friendly label.
 * Standard AMS / AMS 2 Pro units have IDs 0..3; AMS HT units have IDs 128..135.
 */
export function formatAmsUnitLabel(unitId: string | number): string {
  const num = typeof unitId === "number" ? unitId : parseInt(unitId, 10);
  if (isNaN(num)) return `AMS ${unitId}`;
  if (num >= 128 && num <= 135) {
    return `AMS HT ${num - 127} (id ${num})`;
  }
  if (num >= 0 && num <= 15) {
    const letter = num < 26 ? String.fromCharCode(65 + num) : String(num + 1);
    return `AMS ${letter} (id ${num})`;
  }
  return `AMS ${num}`;
}

/**
 * Decode H2D `extruder.info[].snow` value: high byte = AMS unit index, low byte = tray index.
 * 255/255 (65535) = empty/unloaded; amsIndex 255 with tray 0..254 = external spool.
 */
export function formatExtruderSnow(snow?: number): string | undefined {
  if (snow === undefined || snow === null) return undefined;
  const amsIdx = (snow >>> 8) & 0xff;
  const trayIdx = snow & 0xff;
  if (amsIdx === 255 && trayIdx === 255) return undefined;
  if (amsIdx === 255) return "External Spool";
  if (amsIdx >= 128 && amsIdx <= 135) {
    return `AMS HT ${amsIdx - 127}`;
  }
  const letter = amsIdx < 26 ? String.fromCharCode(65 + amsIdx) : `${amsIdx + 1}`;
  return `AMS ${letter}${trayIdx + 1}`;
}

export interface NozzleTelemetry {
  /** 0 = right (or single), 1 = left */
  id: number;
  side: "right" | "left";
  current?: number;
  target?: number;
  diameter?: number;
  type?: string;
  filamentLoaded?: boolean;
  loadedSource?: string;
}

export interface ParsedThermalAndNozzleStatus {
  isDualNozzle: boolean;
  activeNozzle: "right" | "left" | "switching" | null;
  activeNozzleIndex: number | null;
  nozzles: NozzleTelemetry[];
  bed: { current?: number; target?: number };
  chamber: { current?: number; target?: number };
}

/**
 * Parse nozzle, bed, and chamber telemetry from either H2D multi-nozzle payloads
 * (`status.device.*`) or legacy single-nozzle payloads (`nozzle_temper`, etc.).
 */
export function parseThermalAndNozzleStatus(
  status: PrinterStatus,
  model?: string,
): ParsedThermalAndNozzleStatus {
  const extruder = status.device?.extruder;
  const extruderInfo = Array.isArray(extruder?.info) ? extruder.info : undefined;
  const nozzleInfo = Array.isArray(status.device?.nozzle?.info)
    ? status.device.nozzle.info
    : undefined;

  const extruderCount =
    extruder?.state !== undefined ? extruder.state & 0xf : undefined;
  const isDualNozzle =
    isDualNozzleModel(model) ||
    (extruderCount !== undefined && extruderCount >= 2) ||
    (extruderInfo !== undefined && extruderInfo.length >= 2) ||
    (nozzleInfo !== undefined && nozzleInfo.length >= 2);

  let activeNozzleIndex: number | null = null;
  let activeNozzle: "right" | "left" | "switching" | null = null;
  if (extruder?.state !== undefined) {
    const idx = (extruder.state >>> 4) & 0xf;
    activeNozzleIndex = idx;
    if (idx === 0) activeNozzle = "right";
    else if (idx === 1) activeNozzle = "left";
    else if (idx === 15) activeNozzle = "switching";
  }

  const nozzleMap = new Map<number, NozzleTelemetry>();
  const ensureNozzle = (id: number): NozzleTelemetry => {
    let entry = nozzleMap.get(id);
    if (!entry) {
      entry = { id, side: id === 1 ? "left" : "right" };
      nozzleMap.set(id, entry);
    }
    return entry;
  };

  if (extruderInfo) {
    for (const item of extruderInfo) {
      if (item.id !== 0 && item.id !== 1) continue;
      const n = ensureNozzle(item.id);
      if (typeof item.temp === "number") {
        const { current, target } = decodePackedTemp(item.temp);
        n.current = current;
        n.target = target;
      }
      if (typeof item.snow === "number") {
        n.loadedSource = formatExtruderSnow(item.snow);
      }
    }
  } else if (!isDualNozzle) {
    // Legacy single-nozzle payload (only apply to index 0 when not dual-nozzle,
    // because dual-nozzle printers mirror whichever nozzle is active into nozzle_temper).
    if (
      status.nozzle_temper !== undefined ||
      status.nozzle_target_temper !== undefined
    ) {
      const n = ensureNozzle(0);
      n.current = status.nozzle_temper;
      n.target = status.nozzle_target_temper;
    }
  } else if (
    status.nozzle_temper !== undefined ||
    status.nozzle_target_temper !== undefined
  ) {
    // Dual-nozzle model before device.extruder.info has arrived — attach to active nozzle if known
    const targetId = activeNozzleIndex === 1 ? 1 : 0;
    const n = ensureNozzle(targetId);
    n.current = status.nozzle_temper;
    n.target = status.nozzle_target_temper;
  }

  if (nozzleInfo) {
    for (const item of nozzleInfo) {
      if (item.id !== 0 && item.id !== 1) continue;
      const n = ensureNozzle(item.id);
      if (item.diameter !== undefined && item.diameter !== "") {
        const d = Number(item.diameter);
        if (!isNaN(d) && d > 0) n.diameter = d;
      }
      if (item.type) {
        n.type = decodeNozzleType(item.type);
      }
    }
  } else {
    if (status.nozzle_diameter !== undefined) {
      const d = Number(status.nozzle_diameter);
      if (!isNaN(d) && d > 0) ensureNozzle(0).diameter = d;
    }
    if (status.nozzle_type) {
      ensureNozzle(0).type = decodeNozzleType(status.nozzle_type);
    }
  }

  if (typeof status.hw_switch_state === "number") {
    if (nozzleMap.has(0)) {
      nozzleMap.get(0)!.filamentLoaded = (status.hw_switch_state & 0x1) !== 0;
    }
    if (isDualNozzle && nozzleMap.has(1)) {
      nozzleMap.get(1)!.filamentLoaded = (status.hw_switch_state & 0x2) !== 0;
    }
  }

  // Order left (id=1) then right (id=0) on dual-nozzle printers to match physical left/right layout,
  // or single nozzle (id=0) first on single-nozzle printers.
  const nozzles = Array.from(nozzleMap.values()).sort((a, b) =>
    isDualNozzle ? b.id - a.id : a.id - b.id,
  );

  // Bed temperature: prefer packed device.bed.info.temp, fallback to legacy fields
  let bedCurrent = status.bed_temper;
  let bedTarget = status.bed_target_temper;
  if (typeof status.device?.bed?.info?.temp === "number") {
    const decoded = decodePackedTemp(status.device.bed.info.temp);
    bedCurrent = decoded.current;
    bedTarget = decoded.target;
  }

  // Chamber temperature: prefer packed device.ctc.info.temp (H2D active chamber heater), fallback to chamber_temper
  let chamberCurrent = status.chamber_temper;
  let chamberTarget: number | undefined;
  if (typeof status.device?.ctc?.info?.temp === "number") {
    const decoded = decodePackedTemp(status.device.ctc.info.temp);
    chamberCurrent = decoded.current;
    chamberTarget = decoded.target;
  }

  return {
    isDualNozzle,
    activeNozzle,
    activeNozzleIndex,
    nozzles,
    bed: { current: bedCurrent, target: bedTarget },
    chamber: { current: chamberCurrent, target: chamberTarget },
  };
}
