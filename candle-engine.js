// Arpit Market Scanner
// Candle Engine
// Educational / informational market-structure analysis only

function calculateCandleEngine(candles = [], timeframe = "5m") {
  if (!Array.isArray(candles) || candles.length < 5) {
    return {
      status: "insufficient-data",
      timeframe,
      message: "At least 5 candles are required.",
      candles: []
    };
  }

  const clean = candles
    .map((c) => ({
      time: c.time ?? c.timestamp ?? null,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume || 0)
    }))
    .filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    );

  if (clean.length < 5) {
    return {
      status: "insufficient-data",
      timeframe,
      message: "Valid OHLC candles are insufficient.",
      candles: []
    };
  }

  const latest = clean[clean.length - 1];

  // --------------------------------------------------
  // Swing detection
  // --------------------------------------------------

  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < clean.length - 2; i++) {
    const c = clean[i];

    const isSwingHigh =
      c.high > clean[i - 1].high &&
      c.high > clean[i - 2].high &&
      c.high >= clean[i + 1].high &&
      c.high >= clean[i + 2].high;

    const isSwingLow =
      c.low < clean[i - 1].low &&
      c.low < clean[i - 2].low &&
      c.low <= clean[i + 1].low &&
      c.low <= clean[i + 2].low;

    if (isSwingHigh) {
      swingHighs.push({
        index: i,
        time: c.time,
        price: c.high
      });
    }

    if (isSwingLow) {
      swingLows.push({
        index: i,
        time: c.time,
        price: c.low
      });
    }
  }

  // --------------------------------------------------
  // Recent support / resistance
  // --------------------------------------------------

  const recentCandles = clean.slice(-20);

  const resistance = Math.max(
    ...recentCandles.map((c) => c.high)
  );

  const support = Math.min(
    ...recentCandles.map((c) => c.low)
  );

  // --------------------------------------------------
  // Market structure
  // --------------------------------------------------

  let structure = "Neutral";

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const h1 = swingHighs[swingHighs.length - 2].price;
    const h2 = swingHighs[swingHighs.length - 1].price;

    const l1 = swingLows[swingLows.length - 2].price;
    const l2 = swingLows[swingLows.length - 1].price;

    if (h2 > h1 && l2 > l1) {
      structure = "Bullish";
    } else if (h2 < h1 && l2 < l1) {
      structure = "Bearish";
    }
  }

  // --------------------------------------------------
  // Breakout classification
  // --------------------------------------------------

  let breakout = "No confirmed breakout";

  const previousResistance = Math.max(
    ...clean.slice(-6, -1).map((c) => c.high)
  );

  const previousSupport = Math.min(
    ...clean.slice(-6, -1).map((c) => c.low)
  );

  if (latest.close > previousResistance) {
    breakout = "Upside breakout detected";
  } else if (latest.close < previousSupport) {
    breakout = "Downside breakout detected";
  }

  // --------------------------------------------------
  // Retest classification
  // --------------------------------------------------

  let retest = "No confirmed retest";

  if (breakout === "Upside breakout detected") {
    const touchedLevel = clean
      .slice(-4)
      .some(
        (c) =>
          c.low <= previousResistance &&
          c.high >= previousResistance
      );

    if (touchedLevel && latest.close > previousResistance) {
      retest = "Upside retest confirmed";
    }
  }

  if (breakout === "Downside breakout detected") {
    const touchedLevel = clean
      .slice(-4)
      .some(
        (c) =>
          c.low <= previousSupport &&
          c.high >= previousSupport
      );

    if (touchedLevel && latest.close < previousSupport) {
      retest = "Downside retest confirmed";
    }
  }

  // --------------------------------------------------
  // False breakout classification
  // --------------------------------------------------

  let falseBreakout = "No confirmed false breakout";

  const previousCandle = clean[clean.length - 2];

  if (
    previousCandle.high > previousResistance &&
    previousCandle.close <= previousResistance &&
    latest.close <= previousResistance
  ) {
    falseBreakout = "Possible upside false breakout";
  }

  if (
    previousCandle.low < previousSupport &&
    previousCandle.close >= previousSupport &&
    latest.close >= previousSupport
  ) {
    falseBreakout = "Possible downside false breakout";
  }

  // --------------------------------------------------
  // Candle range
  // --------------------------------------------------

  const candleRange = latest.high - latest.low;

  const bodySize = Math.abs(latest.close - latest.open);

  const candleDirection =
    latest.close > latest.open
      ? "Bullish candle"
      : latest.close < latest.open
      ? "Bearish candle"
      : "Neutral candle";

  // --------------------------------------------------
  // Final result
  // --------------------------------------------------

  return {
    status: "ok",
    timeframe,

    latest: {
      time: latest.time,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      range: Number(candleRange.toFixed(4)),
      body: Number(bodySize.toFixed(4)),
      direction: candleDirection
    },

    levels: {
      resistance: Number(resistance.toFixed(4)),
      support: Number(support.toFixed(4))
    },

    structure: {
      market: structure,
      swingHighs: swingHighs.slice(-5),
      swingLows: swingLows.slice(-5)
    },

    priceAction: {
      breakout,
      retest,
      falseBreakout
    }
  };
}


// CommonJS export for Node.js backend
module.exports = {
  calculateCandleEngine
};
