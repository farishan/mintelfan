Build a macOS CLI diagnostic tool using **Bun + TypeScript** that investigates why an **Intel MacBook's fan is spinning**.

## Goal

I want a small terminal tool that answers:

> "My MacBook fan is spinning. What is most likely causing the thermal load?"

The tool should work specifically on **Intel Macs**, not assume Apple Silicon APIs.

Do NOT implement fan control. This is a **read-only diagnostic/observability tool**.

## Core output

The CLI should continuously display something approximately like:

```text
MacBook Fan Diagnostic
────────────────────────────────

Fan
  Left:       4200 RPM
  Right:      3900 RPM

Thermal
  CPU:        82°C
  GPU:        76°C
  Thermal:    nominal

System
  CPU usage:  34%
  GPU usage:  --
  Load:       2.31

Top processes
  WindowServer     18.4%
  kernel_task      11.2%
  Google Chrome     8.7%
  Code              5.1%

Power / Energy
  WindowServer      ...
  kernel_task       ...
  Google Chrome     ...

Likely thermal contributors
  1. WindowServer
  2. kernel_task
  3. Google Chrome
```

The exact fields depend on what macOS exposes on the particular Intel Mac.

## Important technical requirement

Do not simply use CPU percentage and claim that the highest CPU process is "causing the fan".

The tool should distinguish:

* CPU utilization
* CPU power / energy impact
* GPU activity if available
* temperature
* fan RPM
* thermal pressure
* process activity
* system/kernel activity

The final "likely contributors" section must clearly be an **inference**, not a claim that macOS explicitly reports the cause.

For example:

```text
Likely contributor:
  WindowServer

Evidence:
  CPU activity increased
  GPU activity detected
  CPU temperature increased
  Fan RPM increased

Confidence:
  medium
```

## Data sources

Investigate and use native macOS facilities where possible.

Potential sources include:

### `powermetrics`

Investigate:

```bash
sudo powermetrics --samplers smc,tasks -i 1000
```

and:

```bash
sudo powermetrics --show-process-energy -i 1000
```

Determine exactly what information is available on Intel Macs.

Do not assume the output is identical across macOS versions.

### `top`

Use native process information if useful:

```bash
top -l 1 -o cpu
```

or another appropriate invocation.

### `ps`

Use it for process metadata where appropriate.

### `sysctl`

Investigate useful thermal/system information available through:

```bash
sysctl
```

especially Intel-specific CPU and thermal-related values.

### IOKit / SMC

Investigate whether fan RPM and temperature sensors can be accessed through IOKit/SMC.

If Bun cannot directly access the required APIs, create a small native helper if necessary.

Do NOT blindly copy an Apple Silicon implementation.

## Architecture

Prefer:

```text
Bun CLI
   │
   ├── process collector
   ├── thermal collector
   ├── fan collector
   ├── power/energy collector
   └── correlation engine
            │
            ▼
       terminal renderer
```

Keep each collector independent.

For example:

```text
src/
  cli.ts
  collectors/
    processes.ts
    thermal.ts
    fans.ts
    power.ts
  analysis/
    correlation.ts
  ui/
    terminal.ts
  types.ts
```

Avoid unnecessary frameworks.

Use Bun APIs where appropriate, but do not force everything through Bun if macOS native APIs are required.

## Correlation

The interesting part of this project is not simply collecting data.

Record measurements over time:

```text
timestamp
fan RPM
temperature
thermal pressure
CPU usage
process CPU usage
process energy
GPU information
```

Then detect relationships such as:

```text
process activity increases
        ↓
temperature increases
        ↓
fan RPM increases
```

For example, calculate whether a process's activity consistently precedes increases in temperature/fan RPM.

Do not call this scientifically proven causation. Label it as:

* likely contributor
* possible contributor
* insufficient evidence

## Intel compatibility

Target Intel Macs first.

Before implementing hardware-specific functionality, identify:

1. Intel CPU architecture
2. macOS version
3. available SMC sensors
4. available fan sensors
5. available temperature sensors
6. whether `powermetrics` requires sudo
7. which information is unavailable without privileged access

Gracefully handle missing sensors.

For example:

```text
GPU temperature: unavailable
```

is preferable to crashing.

## CLI

Support something like:

```bash
bun run start
```

and eventually:

```bash
bun run start --interval 1
bun run start --json
bun run start --once
```

`--json` should output machine-readable data.

`--once` should collect one snapshot and exit.

Keep the initial implementation small.

## Development strategy

Do NOT build the entire application at once.

Implement in stages:

### Stage 1

Detect:

* Intel vs Apple Silicon
* macOS version
* Mac model

Print the information.

### Stage 2

Collect process CPU usage.

### Stage 3

Collect fan RPM.

### Stage 4

Collect temperature/thermal information.

### Stage 5

Collect energy/power information.

### Stage 6

Create timestamped snapshots.

### Stage 7

Implement correlation between process activity, temperature and fan RPM.

### Stage 8

Create the terminal dashboard.

At every stage, make sure the program still runs.

## Safety

This is a monitoring tool.

Do NOT:

* modify fan curves
* write to SMC
* disable thermal management
* kill processes automatically
* change CPU power settings
* change system settings

Read-only only.

## Engineering preferences

Use:

* Bun
* TypeScript
* minimal dependencies
* strict TypeScript
* simple functions
* small modules
* clear types

Avoid:

* React
* Electron
* large CLI frameworks
* unnecessary abstractions
* Apple Silicon-only libraries

Prefer native macOS commands/APIs over third-party dependencies when they provide reliable information.

## Important research task

Before writing substantial code, inspect what **Intel macOS actually exposes**.

Do not assume that an API works just because it works on Apple Silicon.

If a proposed data source is unavailable on Intel, document that and find the closest alternative.

Start with **Stage 1 only**, then show me the implementation and explain what information we can reliably obtain on an Intel Mac.
