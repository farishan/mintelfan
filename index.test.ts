import { test, expect } from "bun:test";
import { correlate, type Snapshot } from "./index";

function snap(over: Partial<Snapshot> & { procs: [string, number][]; temp?: number; fan?: number }): Snapshot {
  return {
    timestamp: new Date().toISOString(),
    fans: over.fan !== undefined ? [over.fan] : [],
    fanNote: null,
    thermal: {
      cpuDieC: over.temp ?? null,
      cpuLevel: null,
      ioLevel: null,
      prochots: null,
      pressure: "nominal",
      note: null,
    },
    cpuLine: null,
    load: [1, 1, 1],
    processes: over.procs.map(([name, cpu], i) => ({ pid: i + 1, cpu, name })),
    energy: [],
    energyNote: null,
    gpu: null,
  };
}

test("insufficient evidence with fewer than 3 snapshots", () => {
  const a = correlate([snap({ procs: [["a", 10]] })]);
  expect(a.verdict).toBe("insufficient evidence");
});

test("no rise -> insufficient evidence", () => {
  const h = [
    snap({ fan: 2000, temp: 60, procs: [["a", 10]] }),
    snap({ fan: 2050, temp: 61, procs: [["a", 10]] }),
    snap({ fan: 2000, temp: 60, procs: [["a", 10]] }),
    snap({ fan: 2050, temp: 61, procs: [["a", 10]] }),
  ];
  const a = correlate(h);
  expect(a.verdict).toBe("insufficient evidence");
});

test("activity -> temp -> fan rise gives likely contributor", () => {
  const h = [
    snap({ fan: 2000, temp: 60, procs: [["chrome", 5]] }),
    snap({ fan: 2100, temp: 61, procs: [["chrome", 6]] }),
    snap({ fan: 3000, temp: 75, procs: [["chrome", 40]] }),
    snap({ fan: 3100, temp: 76, procs: [["chrome", 45]] }),
  ];
  const a = correlate(h);
  expect(a.verdict).toBe("likely");
  expect(a.contributors[0]?.name).toBe("chrome");
  expect(a.contributors[0]?.confidence).toBe("medium");
  expect((a.contributors[0]?.evidence.length ?? 0)).toBeGreaterThanOrEqual(3);
});

test("temp rise without fan rise gives possible contributor", () => {
  const h = [
    snap({ temp: 60, procs: [["zed", 5]] }),
    snap({ temp: 61, procs: [["zed", 6]] }),
    snap({ temp: 75, procs: [["zed", 40]] }),
    snap({ temp: 76, procs: [["zed", 45]] }),
  ];
  const a = correlate(h);
  expect(a.verdict).toBe("possible");
  expect(a.confidence).toBe("low");
});
