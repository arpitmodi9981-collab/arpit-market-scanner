const express = require("express");

const {
  Client,
  StreamableHTTPClientTransport
} = require("@modelcontextprotocol/client");

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

const NSE_MCP_URL =
  "https://mcp.nseindia.in/cmmkt/mcp";

let nseClient = null;
let nseTransport = null;
let nseStatus = "not connected";
let nseTools = [];
let nseProtocol = null;
let nseLastError = null;

function errorDetails(error) {
  return {
    name: error?.name || null,
    message: error?.message || String(error),
    code: error?.code || null,
    cause: error?.cause
      ? String(error.cause.message || error.cause)
      : null
  };
}

async function connectNSE() {
  console.log("Starting NSE MCP connection...");

  nseStatus = "connecting";
  nseLastError = null;

  try {
    const client = new Client(
      {
        name: "arpit-market-scanner",
        version: "1.0.0"
      },
      {
        versionNegotiation: {
          mode: "auto",
          probe: {
            timeoutMs: 30000,
            maxRetries: 1
          }
        }
      }
    );

    const transport =
      new StreamableHTTPClientTransport(
        new URL(NSE_MCP_URL)
      );

    await client.connect(transport);

    nseClient = client;
    nseTransport = transport;

    nseProtocol =
      typeof client.getProtocolEra === "function"
        ? client.getProtocolEra()
        : null;

    const toolsResult =
      await client.listTools();

    nseTools =
      toolsResult.tools || [];

    nseStatus = "connected";

    console.log("NSE MCP connected");
    console.log(
      "NSE protocol:",
      nseProtocol
    );

    console.log(
      "NSE tool count:",
      nseTools.length
    );

    console.log(
      "NSE tools:",
      nseTools.map(tool => tool.name)
    );

    return true;

  } catch (error) {

    nseStatus = "connection failed";

    nseLastError =
      errorDetails(error);

    console.error(
      "NSE MCP connection error:",
      nseLastError
    );

    nseClient = null;
    nseTransport = null;

    return false;
  }
}


/* -----------------------------
   DEMO MARKET DATA
----------------------------- */

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


/* -----------------------------
   DEMO CANDLES
----------------------------- */

function demoCandles(price) {

  return [

    {
      open: price - 35,
      high: price - 10,
      low: price - 50,
      close: price - 20
    },

    {
      open: price - 20,
      high: price + 5,
      low: price - 25,
      close: price - 5
    },

    {
      open: price - 5,
      high: price + 25,
      low: price - 10,
      close: price + 15
    },

    {
      open: price + 15,
      high: price + 20,
      low: price - 5,
      close: price + 8
    },

    {
      open: price + 8,
      high: price + 30,
      low: price + 2,
      close: price + 22
    }

  ];

}


/* -----------------------------
   SUPPORT / RESISTANCE
----------------------------- */

function findLevels(candles) {

  const highs =
    candles.map(c => c.high);

  const lows =
    candles.map(c => c.low);

  const resistance =
    Math.max(...highs);

  const support =
    Math.min(...lows);

  const resistanceTouches =
    candles.filter(
      c => c.high >= resistance - 10
    ).length;

  const supportTouches =
    candles.filter(
      c => c.low <= support + 10
    ).length;

  let strength = "WEAK";

  if (
    resistanceTouches >= 3 ||
    supportTouches >= 3
  ) {

    strength = "STRONG";

  } else if (
    resistanceTouches >= 2 ||
    supportTouches >= 2
  ) {

    strength = "MEDIUM";

  }

  return {

    resistance,
    support,

    resistanceTouches,
    supportTouches,

    strength

  };

}


/* -----------------------------
   PRICE ACTION
----------------------------- */

function detectPriceAction(
  candles,
  levels
) {

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  let structure = "Neutral";

  if (
    last.close > last.open
  ) {

    structure = "Bullish";

  } else if (
    last.close < last.open
  ) {

    structure = "Bearish";

  }

  let breakout =
    "Waiting for close";

  let retest =
    "Not triggered";

  let falseBreakout =
    "No confirmation";


  /* Breakout requires CLOSE */

  if (
    last.close >
    levels.resistance
  ) {

    breakout =
      "Breakout above resistance";

  } else if (
    last.close <
    levels.support
  ) {

    breakout =
      "Breakdown below support";

  }


  /* Retest */

  const resistanceDistance =
    Math.abs(
      last.low -
      levels.resistance
    );

  const supportDistance =
    Math.abs(
      last.high -
      levels.support
    );


  if (
    previous.close >
      levels.resistance &&
    resistanceDistance <= 15
  ) {

    retest =
      "Retest of resistance";

  }


  if (
    previous.close <
      levels.support &&
    supportDistance <= 15
  ) {

    retest =
      "Retest of support";

  }


  /* False breakout */

  if (
    last.high >
      levels.resistance &&
    last.close <
      levels.resistance
  ) {

    falseBreakout =
      "False breakout above resistance";

  } else if (
    last.low <
      levels.support &&
    last.close >
      levels.support
  ) {

    falseBreakout =
      "False breakdown below support";

  }


  return {

    breakout,
    retest,
    falseBreakout,
    structure

  };

}


/* -----------------------------
   SCANNER
----------------------------- */

function scanner(symbol) {

  const m =
    market[symbol];

  const candles5m =
    demoCandles(m.price);

  const candles15m =
    demoCandles(m.price);

  const levels =
    findLevels(candles15m);

  const priceAction =
    detectPriceAction(
      candles15m,
      levels
    );

  return {

    symbol,

    price: m.price,

    mode:
      nseStatus === "connected"
        ? "nse-mcp-connected"
        : "demo",

    timeframes: [
      "Daily",
      "15m",
      "5m"
    ],

    dailyLevels: {

      previousDayHigh:
        m.previousHigh,

      previousDayLow:
        m.previousLow,

      previousClose:
        m.previousClose,

      currentDayHigh:
        m.dayHigh,

      currentDayLow:
        m.dayLow

    },

    levels: {

      resistance:
        levels.res
