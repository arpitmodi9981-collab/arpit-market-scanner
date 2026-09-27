const express = require("express");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

function zone(low, high, source, strength = "STRONG") {
  return { low, high, source, strength };
}

function buildLevels(daily, candles15m, candles5m) {
  const levels = [];

  // DAILY LEVELS
  levels.push(
    zone(daily.previousHigh, daily.previousHigh, "Previous Day High"),
    zone(daily.previousLow, daily.previousLow, "Previous Day Low"),
    zone(daily.previousClose, daily.previousClose, "Previous Day Close"),
    zone(daily.dayHigh, daily.dayHigh, "Current Day High"),
    zone(daily.dayLow, daily.dayLow, "Current Day Low")
  );

  // 15-MINUTE SWINGS
  for (let i = 1; i < candles15m.length - 1; i++) {
    const prev = candles15m[i - 1];
    const cur = candles15m[i];
    const next = candles15m[i + 1];

    if (cur.high > prev.high && cur.high > next.high) {
      levels.push(zone(cur.high, cur.high, "15m Swing High", "MEDIUM"));
    }

    if (cur.low < prev.low && cur.low < next.low) {
      levels.push(zone(cur.low, cur.low, "15m Swing Low", "MEDIUM"));
    }
  }

  // 5-MINUTE SWINGS
  for (let i = 1; i < candles5m.length - 1; i++) {
    const prev = candles5m[i - 1];
    const cur = candles5m[i];
    const next = candles5m[i + 1];

    if (cur.high > prev.high && cur.high > next.high) {
      levels.push(zone(cur.high, cur.high, "5m Swing High", "NORMAL"));
    }

    if (cur.low < prev.low && cur.low < next.low) {
      levels.push(zone(cur.low, cur.low, "5m Swing Low", "NORMAL"));
    }
  }

  return levels;
}

function analyse(candles, level) {
  if (!candles || candles.length < 3) {
    return {
      status: "Not enough data",
      confirmation: false
    };
  }

  const a = candles[candles.length - 3];
  const b = candles[candles.length - 2];
  const c = candles[candles.length - 1];

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const strongBody = range > 0 && body / range >= 0.55;

  // BREAKOUT ABOVE
  if (b.close <= level.high && c.close > level.high) {
    if (bullish && strongBody) {
      return {
        status: "Breakout detected",
        direction: "Bullish",
        confirmation: true
      };
    }

    return {
      status: "Breakout waiting for confirmation",
      direction: "Bullish",
      confirmation: false
    };
  }

  // BREAKDOWN BELOW
  if (b.close >= level.low && c.close < level.low) {
    if (bearish && strongBody) {
      return {
        status: "Breakdown detected",
        direction: "Bearish",
        confirmation: true
      };
    }

    return {
      status: "Breakdown waiting for confirmation",
      direction: "Bearish",
      confirmation: false
    };
  }

  // FALSE BREAKOUT ABOVE
  if (b.high > level.high && b.close <= level.high && c.close < level.high) {
    return {
      status: "False breakout",
      direction: "Bearish",
      confirmation: true
    };
  }

  // FALSE BREAKDOWN BELOW
  if (b.low < level.low && b.close >= level.low && c.close > level.low) {
    return {
      status: "False breakdown",
      direction: "Bullish",
      confirmation: true
    };
  }

  // RETEST
  if (
    Math.abs(c.low - level.high) <= level.high * 0.001 &&
    c.close > level.high
  ) {
    return {
      status: "Retest confirmed",
      direction: "Bullish",
      confirmation: true
    };
  }

  if (
    Math.abs(c.high - level.low) <= level.low * 0.001 &&
    c.close < level.low
  ) {
    return {
      status: "Retest confirmed",
      direction: "Bearish",
      confirmation: true
    };
  }

  return {
    status: "No confirmed setup",
    direction: "Neutral",
    confirmation: false
  };
}

// DEMO MARKET DATA
const demoMarket = {
  NIFTY: {
    price: 25480,
    daily: {
      previousHigh: 25500,
      previousLow: 25420,
      previousClose: 25460,
     
