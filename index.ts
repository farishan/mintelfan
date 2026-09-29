import { $ } from "bun";
import os from "node:os";

async function cmd(args: string[]): Promise<string | null> {
  try {
    const out = await $`${args}`.text();
    const v = out.trim();
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

type ProcInfo = { pid: number; cpu: number; name: string };

async function topProcesses(limit = 5): Promise<ProcInfo[]> {
  const out = await cmd(["ps", "-axro", "pid,pcpu,comm"]);
  if (!out) return [];
  return out
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((p) => p.length >= 3)
    .map((p) => ({ pid: Number(p[0]), cpu: Number(p[1]), name: p.slice(2).join(" ") }))
    .filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.cpu))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, limit);
}

async function cpuUsageLine(): Promise<string | null> {
  const out = await cmd(["top", "-l", "1", "-n", "0"]);
  if (!out) return null;
  const line = out.split("\n").find((l) => l.includes("CPU usage"));
  return line?.trim() ?? null;
}
let smcCache: string | null | undefined;
async function smcOutput(): Promise<string | null> {
  if (smcCache !== undefined) return smcCache;
  try {
    smcCache = await $`sudo -n powermetrics --samplers smc,thermal -i 500 -n 1`.text();
  } catch {
    smcCache = null;
  }
  return smcCache;
}

function parseSmcNumber(out: string, re: RegExp): number | null {
  const m = out.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

async function fanRpm(): Promise<{ fans: number[]; note: string | null }> {
  const out = await smcOutput();
  if (!out) return { fans: [], note: "unavailable (powermetrics requires sudo)" };
  const fans = [...out.matchAll(/Fan[^:]*:\s*([\d.]+)\s*rpm/gi)].map((m) => Math.round(Number(m[1])));
  if (fans.length > 0) return { fans, note: null };
  return { fans: [], note: "unavailable (no SMC fan keys in powermetrics output)" };
}

type ThermalInfo = {
  cpuDieC: number | null;
  cpuLevel: number | null;
  ioLevel: number | null;
  prochots: number | null;
  pressure: string | null;
  note: string | null;
};

async function thermalInfo(): Promise<ThermalInfo> {
  const [out, pmset] = await Promise.all([
    smcOutput(),
    cmd(["pmset", "-g", "therm"]),
  ]);
  let pressure: string | null = null;
  if (pmset) {
    if (/No thermal warning/i.test(pmset)) pressure = "nominal";
    else {
      const m = pmset.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
      pressure = m ? (Number(m[1]) >= 100 ? "nominal" : `throttled (speed limit ${m[1]}%)`) : pmset.split("\n")[0].trim();
    }
  }
  if (!out) return { cpuDieC: null, cpuLevel: null, ioLevel: null, prochots: null, pressure, note: "unavailable (powermetrics requires sudo)" };
  return {
    cpuDieC: parseSmcNumber(out, /CPU die temperature:\s*([\d.]+)\s*C/i),
    cpuLevel: parseSmcNumber(out, /CPU Thermal level:\s*([\d.]+)/i),
    ioLevel: parseSmcNumber(out, /IO Thermal level:\s*([\d.]+)/i),
    prochots: parseSmcNumber(out, /Number of prochots:\s*([\d.]+)/i),
    pressure,
    note: null,
  };
}

type EnergyProc = { name: string; pid: number | null; energy: number };

async function topEnergy(limit = 5): Promise<{ rows: EnergyProc[]; note: string | null }> {
  try {
    const out = await $`sudo -n powermetrics --samplers tasks --show-process-energy -i 500 -n 1`.text();
    const lines = out.split("\n");
    const rows: EnergyProc[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(.+?)\s+(\d+)\s+([\d.\s]+)$/);
      if (!m) continue;
      const nums = m[3].trim().split(/\s+/);
      if (nums.length < 7) continue;
      const energy = Number(nums[nums.length - 1]);
      if (!Number.isFinite(energy) || energy <= 0) continue;
      rows.push({ name: m[1].trim(), pid: Number(m[2]), energy });
    }
    rows.sort((a, b) => b.energy - a.energy);
    const selfNames = new Set(["top", "powermetrics"]);
    const top = rows
      .filter((r) => !(selfNames.has(r.name) || (r.name === "bun" && r.pid === process.pid)))
      .slice(0, limit);
    if (top.length > 0) return { rows: top, note: null };
    return { rows: [], note: "unavailable (no per-process energy rows parsed)" };
  } catch {
    return { rows: [], note: "unavailable (powermetrics requires sudo)" };
  }
}
type Snapshot = {
  timestamp: string;
  fans: number[];
  fanNote: string | null;
  thermal: ThermalInfo;
  cpuLine: string | null;
  load: number[];
  processes: ProcInfo[];
  energy: EnergyProc[];
  energyNote: string | null;
  gpu: string | null;
};

async function collectSnapshot(): Promise<Snapshot> {
  smcCache = undefined;
  const [cpuLine, procs, fan, therm, energy] = await Promise.all([
    cpuUsageLine(),
    topProcesses(5),
    fanRpm(),
    thermalInfo(),
    topEnergy(5),
  ]);
  return {
    timestamp: new Date().toISOString(),
    fans: fan.fans,
    fanNote: fan.note,
    thermal: therm,
    cpuLine,
    load: os.loadavg(),
    processes: procs,
    energy: energy.rows,
    energyNote: energy.note,
    gpu: null,
  };
}
async function detect(quiet = false) {
  const platform = process.platform;
  const nodeArch = process.arch;

  const [unameM, hwMachine, hwModel, cpuBrand, ncpu, memsize, osName, osVersion, osBuild] =
    await Promise.all([
      cmd(["uname", "-m"]),
      cmd(["sysctl", "-n", "hw.machine"]),
      cmd(["sysctl", "-n", "hw.model"]),
      cmd(["sysctl", "-n", "machdep.cpu.brand_string"]),
      cmd(["sysctl", "-n", "hw.ncpu"]),
      cmd(["sysctl", "-n", "hw.memsize"]),
      cmd(["sw_vers", "-productName"]),
      cmd(["sw_vers", "-productVersion"]),
      cmd(["sw_vers", "-buildVersion"]),
    ]);

  const arch = unameM ?? hwMachine ?? nodeArch;
  const brand = cpuBrand ?? "unknown";

  let chip: string;
  if (/intel/i.test(brand)) chip = "Intel";
  else if (/apple/i.test(brand)) chip = "Apple Silicon";
  else if (arch === "x86_64") chip = "Intel";
  else if (arch === "arm64") chip = "Apple Silicon";
  else chip = "unknown";

  const isIntelTarget = chip === "Intel";
  const model = hwModel ?? "unknown";

  if (!quiet) {
  console.log("MacBook Fan Diagnostic");
  console.log("────────────────────────────────");
  console.log(`Platform:     ${platform} (${arch})`);
  console.log(`Chip:         ${chip}`);
  console.log(`CPU:          ${brand}`);
  console.log(`Mac model:    ${model}`);
  console.log(`macOS:        ${osName ?? "macOS"} ${osVersion ?? "unknown"} (${osBuild ?? "unknown build"})`);
  console.log(`CPUs:         ${ncpu ?? "unknown"}`);
  console.log(
    `Memory:       ${memsize ? `${(Number(memsize) / 1024 ** 3).toFixed(1)} GB` : "unknown"}`
  );
  console.log("────────────────────────────────");

  if (platform !== "darwin") {
    console.log("Warning: not running on macOS, Intel SMC sensors unavailable.");
    return null;
  }
  if (!isIntelTarget) {
    console.log("Note: this tool targets Intel Macs first, some sensors may differ.");
  }
  }
  return { platform, arch, chip, cpu: brand, model, os: `${osName ?? "macOS"} ${osVersion ?? "unknown"} (${osBuild ?? "unknown build"})`, cpus: ncpu, memBytes: memsize ? Number(memsize) : null };
}

function renderSnapshot(s: Snapshot) {
  console.log(`\nSnapshot: ${s.timestamp}`);
  console.log("\nFan");
  if (s.fans.length === 0) console.log(`  ${s.fanNote ?? "unavailable"}`);
  else s.fans.forEach((rpm, i) => console.log(`  Fan ${i}:  ${rpm} RPM`));
  console.log("\nThermal");
  const t = s.thermal;
  if (t.note && t.cpuDieC === null && t.pressure === null) console.log(`  ${t.note}`);
  else {
    console.log(`  CPU die:      ${t.cpuDieC !== null ? `${t.cpuDieC.toFixed(1)}°C` : "unavailable"}`);
    console.log(`  CPU level:    ${t.cpuLevel !== null ? t.cpuLevel : "unavailable"}`);
    console.log(`  IO level:     ${t.ioLevel !== null ? t.ioLevel : "unavailable"}`);
    console.log(`  Prochots:     ${t.prochots !== null ? t.prochots : "unavailable"}`);
    console.log(`  Pressure:     ${t.pressure ?? "unavailable"}`);
    console.log(`  GPU:          ${s.gpu ?? "unavailable"}`);
    if (t.note) console.log(`  Note: ${t.note}`);
  }
  console.log("\nSystem");
  console.log(`  ${s.cpuLine ?? "CPU usage: unavailable"}`);
  console.log(`  Load: ${s.load.map((v) => v.toFixed(2)).join(" ")}`);
  console.log("\nTop processes");
  if (s.processes.length === 0) console.log("  unavailable");
  else for (const p of s.processes) console.log(`  ${p.name} (${p.pid})  ${p.cpu.toFixed(1)}%`);
  console.log("\nPower / Energy");
  if (s.energy.length === 0) console.log(`  ${s.energyNote ?? "unavailable"}`);
  else for (const e of s.energy) console.log(`  ${e.name} (${e.pid ?? "?"})  ${e.energy.toFixed(1)}`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const once = args.includes("--once");
  let interval = 0;
  for (let i = 0; i < args.length; i++) {
    const m = args[i].match(/^--interval(?:=(\d+(?:\.\d+)?))?$/);
    if (m) {
      interval = Number(m[1] ?? args[i + 1]);
      if (!Number.isFinite(interval) || interval <= 0) interval = 0;
    }
  }
  return { json, once, interval };
}

async function main() {
  const { json, once, interval } = parseArgs();
  const system = await detect(json);
  if (system === null) return;

  if (json) {
    console.log(JSON.stringify({ system, snapshot: await collectSnapshot() }, null, 2));
    return;
  }

  if (once || interval <= 0) {
    renderSnapshot(await collectSnapshot());
    return;
  }

  while (true) {
    console.clear();
    renderSnapshot(await collectSnapshot());
    await Bun.sleep(interval * 1000);
  }
}

await main();
