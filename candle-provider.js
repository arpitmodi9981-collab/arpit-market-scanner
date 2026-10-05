
// Arpit Market Scanner
// Candle Provider
// Keeps candle-source logic separate from server.js

function normalizeCandle(candle) {
  if (!candle || typeof candle !== "object") {
    return null;
  }

  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const volume = Number(candle.volume || 0);

  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return null;
  }

  return {
    time: candle.time ?? candle.timestamp ?? null,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0
  };
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) {
    return [];
  }

  return candles
    .map(normalizeCandle)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.time == null || b.time == null) return 0;

      return String(a.time).localeCompare(String(b.time));
    });
}

function createCandleResponse({
  symbol,
  timeframe,
  candles = [],
  source = "unknown"
}) {
  const normalized = normalizeCandles(candles);

  return {
    status: normalized.length ? "ok" : "no_data",
    symbol: String(symbol || "").toUpperCase(),
    timeframe,
    source,
    count: normalized.length,
    candles: normalized
  };
}

function validateTimeframe(timeframe) {
  return timeframe === "15m" ? "15m" : "5m";
}

/*
  Generic provider interface.

  Actual authorized candle data can be connected here later
  without changing server.js.
*/

async function getCandles({
  symbol,
  timeframe = "5m",
  candles = []
} = {}) {
  const interval = validateTimeframe(timeframe);

  return createCandleResponse({
    symbol,
    timeframe: interval,
    candles,
    source: "external-candle-provider"
  });
}

module.exports = {
  normalizeCandle,
  normalizeCandles,
  createCandleResponse,
  validateTimeframe,
  getCandles
};
