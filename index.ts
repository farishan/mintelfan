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
      pressure = m ? (Number(m[1] ?? 100) >= 100 ? "nominal" : `throttled (speed limit ${m[1]}%)`) : pmset.split("\n")[0]?.trim() ?? null;
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
      if (!m || !m[1] || !m[2] || !m[3]) continue;
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
export type Snapshot = {
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
export type Verdict = "likely" | "possible" | "insufficient evidence";

export type Contributor = {
  name: string;
  verdict: Exclude<Verdict, "insufficient evidence">;
  evidence: string[];
  confidence: "medium" | "low";
};

export type Analysis = {
  verdict: Verdict;
  contributors: Contributor[];
  confidence: "medium" | "low" | null;
  note: string | null;
};

const MIN_SAMPLES = 3;
const MAX_HISTORY = 60;

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function avgTemp(snaps: Snapshot[]): number | null {
  return avg(snaps.map((s) => s.thermal.cpuDieC).filter((v) => v !== null));
}

function avgFan(snaps: Snapshot[]): number | null {
  return avg(
    snaps
      .filter((s) => s.fans.length > 0)
      .map((s) => s.fans.reduce((a, b) => a + b, 0) / s.fans.length)
  );
}

type ProcStat = { cpu: number; energy: number | null };

function procStats(snaps: Snapshot[]): Map<string, ProcStat> {
  const cpu = new Map<string, number[]>();
  const energy = new Map<string, number[]>();
  for (const s of snaps) {
    for (const p of s.processes) {
      const a = cpu.get(p.name) ?? [];
      a.push(p.cpu);
      cpu.set(p.name, a);
    }
    for (const e of s.energy) {
      const a = energy.get(e.name) ?? [];
      a.push(e.energy);
      energy.set(e.name, a);
    }
  }
  const out = new Map<string, ProcStat>();
  for (const [name, vals] of cpu) {
    const c = avg(vals) ?? 0;
    const es = energy.get(name);
    out.set(name, { cpu: c, energy: es ? avg(es) : null });
  }
  for (const [name, vals] of energy) {
    if (!out.has(name)) out.set(name, { cpu: 0, energy: avg(vals) });
  }
  return out;
}

export function correlate(history: Snapshot[]): Analysis {
  const none: Analysis = { verdict: "insufficient evidence", contributors: [], confidence: null, note: null };
  if (history.length < MIN_SAMPLES) {
    return { ...none, note: `need at least ${MIN_SAMPLES} snapshots (have ${history.length})` };
  }
  const mid = Math.floor(history.length / 2);
  const base = history.slice(0, mid);
  const recent = history.slice(mid);

  const baseTemp = avgTemp(base);
  const recentTemp = avgTemp(recent);
  const baseFan = avgFan(base);
  const recentFan = avgFan(recent);

  const tempRise =
    baseTemp !== null && recentTemp !== null && recentTemp - baseTemp >= 1.5;
  const fanRise =
    baseFan !== null &&
    recentFan !== null &&
    (recentFan - baseFan >= 150 || (baseFan > 0 && (recentFan - baseFan) / baseFan >= 0.05));

  if (baseTemp === null && baseFan === null) {
    return { ...none, note: "temperature and fan data unavailable (powermetrics requires sudo)" };
  }
  if (!tempRise && !fanRise) {
    return { ...none, note: "no temperature/fan rise detected across samples" };
  }

  const baseStats = procStats(base);
  const recentStats = procStats(recent);
  const risen: { name: string; dCpu: number; cpuRise: boolean; eRise: boolean; bc: number; rc: number; be: number | null; re: number | null }[] = [];
  for (const [name, r] of recentStats) {
    const b = baseStats.get(name);
    const bc = b?.cpu ?? 0;
    const be = b?.energy ?? null;
    const dCpu = r.cpu - bc;
    const cpuRise = dCpu >= 2;
    const eRise =
      r.energy !== null &&
      r.energy > 0 &&
      (be === null || be <= 0 ? r.energy >= 5 : r.energy >= be * 1.3 + 1);
    if (cpuRise || eRise) risen.push({ name, dCpu, cpuRise, eRise, bc, rc: r.cpu, be, re: r.energy });
  }
  if (risen.length === 0) {
    return { ...none, note: "thermal rise detected but no process activity rise found" };
  }
  risen.sort((a, b) => b.dCpu - a.dCpu);

  const sysEvidence: string[] = [];
  if (tempRise && baseTemp !== null && recentTemp !== null)
    sysEvidence.push(`CPU temperature increased (${baseTemp.toFixed(1)}°C → ${recentTemp.toFixed(1)}°C)`);
  if (fanRise && baseFan !== null && recentFan !== null)
    sysEvidence.push(`Fan RPM increased (${Math.round(baseFan)} → ${Math.round(recentFan)} RPM)`);

  const contributors: Contributor[] = risen.slice(0, 3).map((r) => {
    const evidence: string[] = [];
    if (r.cpuRise) evidence.push(`CPU activity increased (${r.bc.toFixed(1)}% → ${r.rc.toFixed(1)}%)`);
    if (r.eRise && r.be !== null && r.re !== null)
      evidence.push(`Energy impact increased (${r.be.toFixed(1)} → ${r.re.toFixed(1)})`);
    else if (r.eRise && r.re !== null)
      evidence.push(`Energy impact appeared (${r.re.toFixed(1)})`);
    evidence.push(...sysEvidence);
    const isLikely = tempRise && fanRise;
    return {
      name: r.name,
      verdict: isLikely ? "likely" : "possible",
      evidence,
      confidence: isLikely ? "medium" : "low",
    };
  });

  const verdict: Verdict = tempRise && fanRise ? "likely" : "possible";
  return {
    verdict,
    contributors,
    confidence: verdict === "likely" ? "medium" : "low",
    note: null,
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

function renderAnalysis(a: Analysis) {
  console.log("\nLikely thermal contributors");
  if (a.verdict === "insufficient evidence" || a.contributors.length === 0) {
    console.log("  insufficient evidence");
    if (a.note) console.log(`  (${a.note})`);
    return;
  }
  a.contributors.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name} — ${c.verdict} contributor`);
    console.log("     Evidence:");
    for (const e of c.evidence) console.log(`       ${e}`);
    console.log(`     Confidence: ${c.confidence}`);
  });
  console.log("  (inference, not proven causation)");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const once = args.includes("--once");
  const noSave = args.includes("--no-save");
  let interval = 0;
  for (let i = 0; i < args.length; i++) {
    const m = args[i]?.match(/^--interval(?:=(\d+(?:\.\d+)?))?$/);
    if (m) {
      interval = Number(m[1] ?? args[i + 1]);
      if (!Number.isFinite(interval) || interval <= 0) interval = 0;
    }
  }
  return { json, once, interval, noSave };
}

function runId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function saveSnapshot(runDir: string, n: number, payload: unknown): Promise<string> {
  await $`mkdir -p ${runDir}`.text().catch(() => null);
  const path = `${runDir}/${String(n).padStart(4, "0")}.json`;
  await Bun.write(path, JSON.stringify(payload, null, 2));
  const user = process.env.SUDO_USER;
  if (user) {
    try {
      await $`chown ${user} ${runDir} ${path}`.text();
    } catch {
    }
  }
  return path;
}

async function main() {
  const { json, once, interval, noSave } = parseArgs();
  const system = await detect(json);
  if (system === null) return;

  const dir = `snapshots/${runId()}`;
  let n = 0;
  const save = async (snapshot: Snapshot, analysis: Analysis | null) => {
    if (noSave) return null;
    const path = await saveSnapshot(dir, ++n, { system, snapshot, analysis });
    if (!json) console.log(`\nSaved: ${path}`);
    return path;
  };

  if (json) {
    console.log(JSON.stringify({ system, snapshot: await collectSnapshot() }, null, 2));
    return;
  }

  if (once || interval <= 0) {
    const s = await collectSnapshot();
    const a = correlate([s]);
    renderSnapshot(s);
    if (!json) renderAnalysis(a);
    await save(s, a);
    return;
  }

  const history: Snapshot[] = [];
  while (true) {
    console.clear();
    console.log("MacBook Fan Diagnostic");
    console.log(`${system.model} · ${system.os} · every ${interval}s · sample #${n + 1} (history ${Math.min(n + 1, MAX_HISTORY)})`);
    console.log("────────────────────────────────");
    const s = await collectSnapshot();
    history.push(s);
    if (history.length > MAX_HISTORY) history.shift();
    const a = correlate(history);
    renderSnapshot(s);
    renderAnalysis(a);
    await save(s, a);
    await Bun.sleep(interval * 1000);
  }
}

if (import.meta.main) await main();
