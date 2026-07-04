const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { monitorEventLoopDelay, performance } = require("node:perf_hooks");
const { rollingStats } = require("./liveUtils");

function average(values) {
  const finite = values.filter((value) => Number.isFinite(value) && value > 0);

  if (finite.length === 0) {
    return null;
  }

  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function readCurrentCpuMHz(options = {}) {
  const fsApi = options.fs || fs;
  const osApi = options.os || os;
  const cpufreqRoot = options.cpufreqRoot || "/sys/devices/system/cpu";
  const cpuinfoPath = options.cpuinfoPath || "/proc/cpuinfo";

  try {
    const mhzValues = fsApi
      .readdirSync(cpufreqRoot)
      .filter((entry) => /^cpu\d+$/.test(entry))
      .map((entry) => path.join(cpufreqRoot, entry, "cpufreq", "scaling_cur_freq"))
      .map((filePath) => Number.parseFloat(fsApi.readFileSync(filePath, "utf8")) / 1000);
    const mhz = average(mhzValues);

    if (mhz !== null) {
      return { mhz, source: "scaling_cur_freq", fallback: false };
    }
  } catch (_error) {
    // Try the next local source.
  }

  try {
    const cpuinfo = fsApi.readFileSync(cpuinfoPath, "utf8");
    const mhzValues = [...cpuinfo.matchAll(/cpu MHz\s*:\s*([0-9.]+)/g)]
      .map((match) => Number.parseFloat(match[1]));
    const mhz = average(mhzValues);

    if (mhz !== null) {
      return { mhz, source: "proc_cpuinfo", fallback: true };
    }
  } catch (_error) {
    // Fall back to Node's static CPU metadata.
  }

  const mhz = average(osApi.cpus().map((cpu) => cpu.speed));

  return {
    mhz,
    source: "os.cpus",
    fallback: true,
  };
}

function calculateProcessCpuPercent(cpuUsageMicros, elapsedMicros, logicalCores) {
  if (!cpuUsageMicros || !(elapsedMicros > 0) || !(logicalCores > 0)) {
    return 0;
  }

  return ((cpuUsageMicros.user + cpuUsageMicros.system) / (elapsedMicros * logicalCores)) * 100;
}

class RuntimeMetrics {
  constructor(options = {}) {
    this.os = options.os || os;
    this.performance = options.performance || performance;
    this.logicalCores = this.os.cpus().length || 1;
    this.cpuModel = this.os.cpus()[0] ? this.os.cpus()[0].model : "unknown";
    this.startedAtEpochMs = Date.now();
    this.counters = {
      upbitOrderbookMessages: 0,
      parsedMessages: 0,
      recalculatedCycles: 0,
      pushedPointUpdates: 0,
    };
    this.previousCounters = { ...this.counters };
    this.previousRateEpochMs = Date.now();
    this.previousCpuUsage = process.cpuUsage();
    this.previousCpuTime = process.hrtime.bigint();
    this.previousElu = this.performance.eventLoopUtilization();
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: options.eventLoopDelayResolution || 20 });
    this.eventLoopDelay.enable();
    this.latencySamples = [];
    this.maxLatencySamples = options.maxLatencySamples || 2000;
    this.latencyWindowMs = options.latencyWindowMs || 10000;
  }

  increment(name, count = 1) {
    if (!Object.hasOwn(this.counters, name)) {
      this.counters[name] = 0;
      this.previousCounters[name] = 0;
    }

    this.counters[name] += count;
  }

  addLatencySample(value, nowMs = Date.now()) {
    if (!Number.isFinite(value)) {
      return;
    }

    this.latencySamples.push({ t: nowMs, v: value });

    if (this.latencySamples.length > this.maxLatencySamples * 2) {
      this.latencySamples = this.latencySamples.slice(-this.maxLatencySamples);
    }
  }

  getRates(nowMs = Date.now()) {
    const elapsedSec = Math.max((nowMs - this.previousRateEpochMs) / 1000, 0.001);
    const rates = {};

    for (const [name, value] of Object.entries(this.counters)) {
      rates[`${name}PerSec`] = (value - (this.previousCounters[name] || 0)) / elapsedSec;
    }

    this.previousCounters = { ...this.counters };
    this.previousRateEpochMs = nowMs;
    return rates;
  }

  getProcessCpuPercent() {
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - this.previousCpuTime) / 1000;
    const delta = process.cpuUsage(this.previousCpuUsage);
    const percent = calculateProcessCpuPercent(delta, elapsedMicros, this.logicalCores);

    this.previousCpuUsage = process.cpuUsage();
    this.previousCpuTime = now;
    return percent;
  }

  snapshot(wsStatus = {}, nowMs = Date.now()) {
    const memory = process.memoryUsage();
    const cpuFrequency = readCurrentCpuMHz();
    const elu = this.performance.eventLoopUtilization(this.previousElu);
    this.previousElu = this.performance.eventLoopUtilization();

    const delay = {
      p50Ms: this.eventLoopDelay.percentile(50) / 1e6,
      p95Ms: this.eventLoopDelay.percentile(95) / 1e6,
      p99Ms: this.eventLoopDelay.percentile(99) / 1e6,
    };
    this.eventLoopDelay.reset();

    return {
      cpu: {
        model: this.cpuModel,
        logicalCores: this.logicalCores,
        currentMHz: cpuFrequency.mhz,
        currentMHzSource: cpuFrequency.source,
        currentMHzFallback: cpuFrequency.fallback,
        processCpuPercent: this.getProcessCpuPercent(),
        loadAverage: this.os.loadavg(),
      },
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
      },
      eventLoop: {
        utilization: elu.utilization,
        delay,
      },
      websocket: {
        openConnections: wsStatus.openConnectionCount || 0,
        totalConnections: wsStatus.connectionCount || 0,
        marketCount: wsStatus.marketCount || 0,
      },
      rates: this.getRates(nowMs),
      latency: rollingStats(this.latencySamples, nowMs, this.latencyWindowMs, this.maxLatencySamples),
      counters: { ...this.counters },
      sampledAtEpochMs: nowMs,
    };
  }
}

module.exports = {
  RuntimeMetrics,
  readCurrentCpuMHz,
  calculateProcessCpuPercent,
};
