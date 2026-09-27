const express = require('express');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const market = {
  NIFTY: {
    price: 25480,
    previousHigh: 25500,
    previousLow: 25420,
    previousClose: 25460,
    dayHigh: 25495,
    dayLow: 25435
  },
  BANKNIFTY: {
    price: 52320,
    previousHigh: 52400,
    previousLow: 52150,
    previousClose: 52280,
    dayHigh: 52380,
    dayLow: 52200
  },
  "MCX CRUDE OIL": {
    price: 9845,
    previousHigh: 9880,
    previousLow: 9760,
    previousClose: 9820,
    dayHigh: 9860,
    dayLow: 9790
  }
};

function demoCandles(price) {
  return [
    { open: price - 35, high: price - 10, low: price - 50, close: price - 20 },
    { open: price - 20, high: price + 5, low: price - 25, close: price - 5 },
    { open: price - 5, high: price + 25, low: price - 10, close: price + 15 },
    { open: price + 15, high: price + 20, low: price - 5, close: price + 8 },
    { open: price + 8, high: price + 30, low: price + 2, close: price + 22 }
  ];
}

function scanner(symbol) {
  const m = market[symbol];
  const candles5m = demoCandles(m.price);
  const candles15m = demoCandles(m.price);

  return {
    symbol,
    price: m.price,
    mode: "demo",
    timeframes: ["Daily", "15m", "5m"],

    dailyLevels: {
      previousDayHigh: m.previousHigh,
      previousDayLow: m.previousLow,
      previousClose: m.previousClose,
      currentDayHigh: m.dayHigh,
      currentDayLow: m.dayLow
    },

    levels: {
      resistance: m.previousHigh,
      support: m.previousLow,
      strength: "STRONG"
    },

    priceAction: {
      breakout: "Waiting for close",
      retest: "Not triggered",
      falseBreakout: "No confirmation",
      structure:
        candles15m.at(-1).close >= candles15m.at(-1).open
          ? "Bullish"
          : "Bearish"
    },

    candles: {
      "15m": candles15m,
      "5m": candles5m
    }
  };
}

app.get("/", (req, res) => {
  res.json({
    app: "Arpit Market Scanner Backend",
    status: "online",
    mode: "demo",
    message: "Scanner engine ready"
  });
});
app.get("/history/:symbol", (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol).toUpperCase();

  if (!market[symbol]) {
    return res.status(404).json({
      error: "Instrument not supported"
    });
  }

  res.json({
    symbol,
    status: "ready",
    timeframes: ["1D", "15m", "5m"],
    history: [],
    message: "Historical data source not connected yet"
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/scanner/:symbol", (req, res) => {
  const symbol = decodeURIComponent(req.params.symbol).toUpperCase();

  if (!market[symbol]) {
    return res.status(404).json({
      error: "Instrument not supported"
    });
  }

  return res.json(scanner(symbol));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
