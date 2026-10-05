const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");
const { calculateCandleEngine } = require("./candle-engine");

const {
  Client,
  StreamableHTTPClientTransport
} = require("@modelcontextprotocol/client");

const app = express();

const PORT = process.env.PORT || 10000;

const BHAVCOPY_MCP =
  "https://mcp.nseindia.in/bhavcopy/cm/mcp";

const CMMARKET_MCP =
  "https://mcp.nseindia.in/cmmkt/mcp";

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const upload = multer({
  dest: "/tmp/uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

let latestData = [];
let latestDate = null;
let dataStatus = "waiting for NSE data";
let lastError = null;

let mcpStatus = {
  bhavcopy: "not connected",
  cmMarket: "not connected"
};

let mcpErrors = {
  bhavcopy: null,
  cmMarket: null
};

let bhavcopyClient = null;
let cmMarketClient = null;


// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function num(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(String(value).replace(/,/g, ""));

  return Number.isFinite(n) ? n : null;
}

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9&._-]/g, "");
}


// --------------------------------------------------
// CSV PARSER
// --------------------------------------------------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      i++;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        i++;
      }

      row.push(value);
      value = "";

      if (row.some(x => String(x).trim() !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    value += char;
  }

  if (value.length || row.length) {
    row.push(value);

    if (row.some(x => String(x).trim() !== "")) {
      rows.push(row);
    }
  }

  if (!rows.length) return [];

  const headers = rows[0].map(x =>
    String(x).trim().replace(/^\uFEFF/, "")
  );

  return rows.slice(1).map(r => {
    const obj = {};

    headers.forEach((h, i) => {
      obj[h] = r[i] !== undefined ? String(r[i]).trim() : "";
    });

    return obj;
  });
}


function normalizeRow(row) {
  return {
    symbol: cleanSymbol(row.TckrSymb),
    name: row.FinInstrmNm || "",
    series: row.SctySrs || "",
    isin: row.ISIN || "",

    date: row.TradDt || "",

    open: num(row.OpnPric),
    high: num(row.HghPric),
    low: num(row.LwPric),
    close: num(row.ClsPric),
    last: num(row.LastPric),
    previousClose: num(row.PrvsClsgPric),

    volume: num(row.TtlTradgVol),
    value: num(row.TtlTrfVal),
    transactions: num(row.TtlNbOfTxsExctd)
  };
}


function loadCSV(text) {
  const parsed = parseCSV(text);

  latestData = parsed
    .map(normalizeRow)
    .filter(x => x.symbol);

  if (latestData.length) {
    latestDate = latestData[0].date || null;
    dataStatus = "NSE bhavcopy loaded";
  }

  return latestData.length;
}


function findStock(symbol) {
  const s = cleanSymbol(symbol);

  return latestData.find(x =>
    x.symbol === s &&
    (!x.series || x.series === "EQ")
  );
}


// --------------------------------------------------
// LEVELS
// --------------------------------------------------

function calculateLevels(stock) {
  if (!stock) {
    return {
      resistance: null,
      support: null,
      range: null,
      strength: "UNAVAILABLE"
    };
  }

  const resistance = stock.high;
  const support = stock.low;

  const range =
    resistance !== null && support !== null
      ? resistance - support
      : null;

  let strength = "WEAK";

  if (range !== null && stock.close !== null && stock.close !== 0) {
    const rangePercent = Math.abs(range / stock.close) * 100;

    if (rangePercent >= 5) {
      strength = "NORMAL";
    }

    if (rangePercent >= 10) {
      strength = "STRONG";
    }
  }

  return {
    resistance,
    support,
    range,
    strength
  };
}


// --------------------------------------------------
// EDUCATIONAL PRICE-ACTION CLASSIFICATION
// --------------------------------------------------

function priceAction(stock) {
  if (!stock) {
    return {
      structure: "Unavailable",
      setup: "No confirmed setup",
      breakout: "Unavailable",
      retest: "Unavailable",
      falseBreakout: "Unavailable"
    };
  }

  const change = num(stock.changePercent);

  let structure = "Neutral";

  if (change !== null) {
    if (change > 0.5) {
      structure = "Bullish";
    } else if (change < -0.5) {
      structure = "Bearish";
    }
  }

  return {
    structure,

    setup:
      structure === "Bullish"
        ? "Bullish structure"
        : structure === "Bearish"
          ? "Bearish structure"
          : "Neutral structure",

    breakout: "Intraday candles unavailable",
    retest: "Intraday candles unavailable",
    falseBreakout: "Intraday candles unavailable"
  };
}


// --------------------------------------------------
// MCP CONNECTION
// --------------------------------------------------

async function connectMcp(type) {
  const isBhavcopy = type === "bhavcopy";

  const existing = isBhavcopy
    ? bhavcopyClient
    : cmMarketClient;

  if (existing) {
    return existing;
  }

  const url = isBhavcopy
    ? BHAVCOPY_MCP
    : CMMARKET_MCP;

  try {
    const client = new Client({
      name: "arpit-market-scanner",
      version: "1.0.0"
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(url)
    );

    await client.connect(transport);

    if (isBhavcopy) {
      bhavcopyClient = client;
      mcpStatus.bhavcopy = "connected";
      mcpErrors.bhavcopy = null;
    } else {
      cmMarketClient = client;
      mcpStatus.cmMarket = "connected";
      mcpErrors.cmMarket = null;
    }

    return client;
  } catch (error) {
    const message = error?.message || String(error);

    if (isBhavcopy) {
      bhavcopyClient = null;
      mcpStatus.bhavcopy = "error";
      mcpErrors.bhavcopy = message;
    } else {
      cmMarketClient = null;
      mcpStatus.cmMarket = "error";
      mcpErrors.cmMarket = message;
    }

    throw error;
  }
}


// --------------------------------------------------
// MCP TOOLS
// --------------------------------------------------

async function getMcpTools(type) {
  const client = await connectMcp(type);
  return client.listTools();
}


app.get("/nse/mcp/tools", async (req, res) => {
  try {
    const cm = await getMcpTools("cmMarket");

    res.json({
      status: "ok",
      tools: cm.tools || []
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


app.post("/nse/mcp/call", async (req, res) => {
  try {
    const {
      type = "cmMarket",
      name,
      arguments: args = {}
    } = req.body || {};

    if (!name) {
      return res.status(400).json({
        status: "error",
        message: "Tool name required"
      });
    }

    const client = await connectMcp(type);

    const result = await client.callTool({
      name,
      arguments: args
    });

    res.json({
      status: "ok",
      result
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


// --------------------------------------------------
// NSE CM MARKET
// --------------------------------------------------

async function getMcpLiveStock(symbol) {
  const client = await connectMcp("cmMarket");

  const result = await client.callTool({
    name: "cm_get_equity_stocks",
    arguments: {
      limit: 10,
      symbolFilter: cleanSymbol(symbol)
    }
  });

  return result;
}


function parseLiveMcpResult(result) {
  if (!result) return null;

  const content = Array.isArray(result.content)
    ? result.content
    : [];

  const textItem = content.find(
    x => x && x.type === "text"
  );

  if (!textItem || !textItem.text) {
    return null;
  }

  try {
    const parsed = JSON.parse(textItem.text);

    if (
      parsed &&
      Array.isArray(parsed.stocks) &&
      parsed.stocks.length
    ) {
      return parsed.stocks[0];
    }

    return null;
  } catch {
    return null;
  }
}


function normalizeLiveStock(stock) {
  if (!stock) return null;

  return {
    symbol: cleanSymbol(stock.symbol),
    series: stock.series || "EQ",
    type: stock.type || "CM",

    price: num(stock.lastTradedPrice),

    open: num(stock.openPrice),
    high: num(stock.highPrice),
    low: num(stock.lowPrice),

    previousClose: num(stock.preClosePrice),

    change: num(stock.change),
    changePercent: num(stock.perChange),

    volume: num(stock.volume),
    value: num(stock.value),

    fiftyTwoWeekHigh: num(stock.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: num(stock.fiftyTwoWeekLow),

    latestTimestamp: stock.latestTimestamp || null
  };
}


function livePriceAction(stock) {
  if (!stock) {
    return {
      structure: "Unavailable",
      setup: "No confirmed setup",
      changePercent: null,
      breakout: "Intraday candles unavailable",
      retest: "Intraday candles unavailable",
      falseBreakout: "Intraday candles unavailable"
    };
  }

  let structure = "Neutral";

  if (stock.changePercent !== null) {
    if (stock.changePercent > 0.5) {
      structure = "Bullish";
    } else if (stock.changePercent < -0.5) {
      structure = "Bearish";
    }
  }

  return {
    structure,

    setup:
      structure === "Bullish"
        ? "Bullish structure"
        : structure === "Bearish"
          ? "Bearish structure"
          : "Neutral structure",

    changePercent: stock.changePercent,

    breakout: "Intraday candles unavailable",
    retest: "Intraday candles unavailable",
    falseBreakout: "Intraday candles unavailable"
  };
}


// --------------------------------------------------
// LIVE ENDPOINT
// --------------------------------------------------

app.get("/nse/live/:symbol", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);

    const raw = await getMcpLiveStock(symbol);
    const stock = normalizeLiveStock(
      parseLiveMcpResult(raw)
    );

    if (!stock) {
      return res.status(404).json({
        status: "not_found",
        symbol
      });
    }

    res.json({
      status: "ok",
      symbol,
      source: "NSE CM Market MCP",
      data: raw,
      parsedStock: stock,
      disclaimer:
        "NSE market data is provided for informational and educational purposes."
    });
  } catch (error) {
    lastError = error.message;

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});


// --------------------------------------------------
// INTRADAY
// --------------------------------------------------

app.get("/intraday/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);

  const interval =
    req.query.interval === "15m"
      ? "15m"
      : "5m";

  res.json({
    status: "intraday_data_unavailable",
    symbol,
    interval,

    candles: [],

    analysis: {
      structure: "Unavailable",
      breakout: "Actual intraday candles required",
      retest: "Actual intraday candles required",
      falseBreakout: "Actual intraday candles required",
      setup: "No confirmed setup"
    },

    message:
      "NSE CM Market MCP currently provides quote data, not a 5m/15m candle series.",

    disclaimer:
      "Do not treat this endpoint as live 5m/15m trading data."
  });
});


// --------------------------------------------------
// SCANNER
// --------------------------------------------------

app.get("/scanner/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);

  try {
    const raw = await getMcpLiveStock(symbol);

    const live = normalizeLiveStock(
      parseLiveMcpResult(raw)
    );

    if (live) {
      const levels = calculateLevels({
        high: live.high,
        low: live.low,
        close: live.price
      });

      const action = livePriceAction(live);

      return res.json({
        symbol: live.symbol,

        status: "NSE CM Market data",
        mode: "nse-cm-market-mcp",
        source: "NSE CM Market MCP",

        price: live.price,

        open: live.open,
        high: live.high,
        low: live.low,

        previousClose: live.previousClose,

        change: live.change,
        changePercent: live.changePercent,

        volume: live.volume,
        value: live.value,

        fiftyTwoWeekHigh: live.fiftyTwoWeekHigh,
        fiftyTwoWeekLow: live.fiftyTwoWeekLow,

        latestTimestamp: live.latestTimestamp,

        levels,

        priceAction: action,

        intraday: {
          status: "unavailable",

          interval5m:
            "Actual 5m candles required",

          interval15m:
            "Actual 15m candles required",

          breakout: "Not calculated",
          retest: "Not calculated",
          falseBreakout: "Not calculated"
        },

        disclaimer:
          "Educational / informational market-data display. No trade execution."
      });
    }

    throw new Error("NSE stock not found");

  } catch (error) {
    lastError = error.message;

    const stock = findStock(symbol);

    if (!stock) {
      return res.status(404).json({
        status: "error",
        symbol,
        message: "Stock data unavailable",
        error: error.message
      });
    }

    const changePercent =
      stock.close !== null &&
      stock.previousClose
        ? ((stock.close - stock.previousClose) /
            stock.previousClose) * 100
        : null;

    const fallback = {
      symbol: stock.symbol,
      status: "Bhavcopy data",
      mode: "uploaded-bhavcopy",
      source: "NSE Bhavcopy",

      price: stock.last ?? stock.close,

      open: stock.open,
      high: stock.high,
      low: stock.low,

      previousClose: stock.previousClose,

      change:
        stock.close !== null &&
        stock.previousClose !== null
          ? stock.close - stock.previousClose
          : null,

      changePercent,

      volume: stock.volume,
      value: stock.value,

      latestTimestamp: stock.date,

      levels: calculateLevels(stock),

      priceAction: {
        structure:
          changePercent > 0.5
            ? "Bullish"
            : changePercent < -0.5
              ? "Bearish"
              : "Neutral",

        setup: "Daily structure only",

        changePercent,

        breakout:
          "Intraday candles unavailable",

        retest:
          "Intraday candles unavailable",

        falseBreakout:
          "Intraday candles unavailable"
      },

      intraday: {
        status: "unavailable",
        interval5m: "Actual 5m candles required",
        interval15m: "Actual 15m candles required",
        breakout: "Not calculated",
        retest: "Not calculated",
        falseBreakout: "Not calculated"
      },

      disclaimer:
        "Educational / informational market-data display."
    };

    res.json(fallback);
  }
});


// --------------------------------------------------
// STOCK
// --------------------------------------------------

app.get("/stock/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);

  try {
    const raw = await getMcpLiveStock(symbol);
    const live = normalizeLiveStock(
      parseLiveMcpResult(raw)
    );

    if (!live) {
      throw new Error("Stock not found");
    }

    res.json({
      status: "ok",
      source: "NSE CM Market MCP",
      stock: live
    });
  } catch (error) {
    const stock = findStock(symbol);

    if (!stock) {
      return res.status(404).json({
        status: "error",
        message: error.message
      });
    }

    res.json({
      status: "ok",
      source: "NSE Bhavcopy",
      stock
    });
  }
});


// --------------------------------------------------
// UPLOAD BHAVCOPY
// --------------------------------------------------

async function processUploadedFile(filePath) {
  const ext = filePath.toLowerCase();

  if (ext.endsWith(".zip")) {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();

    for (const entry of entries) {
      if (
        !entry.isDirectory &&
        entry.entryName.toLowerCase().endsWith(".csv")
      ) {
        const text = entry.getData().toString("utf8");

        return loadCSV(text);
      }
    }

    throw new Error("CSV not found inside ZIP");
  }

  const text = fs.readFileSync(filePath, "utf8");

  return loadCSV(text);
}


app.post(
  "/upload-bhavcopy",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "File required"
        });
      }

      const count = await processUploadedFile(
        req.file.path
      );

      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      res.json({
        status: "ok",
        rows: count,
        latestDate,
        dataStatus
      });
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);


app.post(
  "/upload",
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "File required"
        });
      }

      const count = await processUploadedFile(
        req.file.path
      );

      try {
        fs.unlinkSync(req.file.path);
      } catch {}

      res.json({
        status: "ok",
        rows: count,
        latestDate,
        dataStatus
      });
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);


// --------------------------------------------------
// HEALTH
// --------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",

    app: "Arpit Market Scanner Backend",

    dataStatus,

    latestDate,

    rowCount: latestData.length,

    mcpStatus,

    mcpErrors,

    lastError,

    intraday:
      "5m/15m actual candle feed not connected"
  });
});


// --------------------------------------------------
// NSE STATUS
// --------------------------------------------------

app.get("/nse/status", (req, res) => {
  res.json({
    status: "ok",

    source: {
      cmMarket:
        "https://mcp.nseindia.in/cmmkt/mcp",

      bhavcopy:
        "https://mcp.nseindia.in/bhavcopy/cm/mcp"
    },

    mcpStatus,
    mcpErrors,

    dataStatus,
    latestDate,

    intraday: {
      fiveMinute: false,
      fifteenMinute: false
    },

    message:
      "CM Market quote data is connected separately from intraday candle data."
  });
});


// --------------------------------------------------
// ROOT
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    app: "Arpit Market Scanner Backend",
    status: "online",

    endpoints: {
      health: "/health",
      nseStatus: "/nse/status",
      live: "/nse/live/20MICRONS",
      scanner: "/scanner/20MICRONS",
      stock: "/stock/20MICRONS",
      intraday5m: "/intraday/20MICRONS?interval=5m",
      intraday15m: "/intraday/20MICRONS?interval=15m",
      tools: "/nse/mcp/tools"
    },

    mode: "educational"
  });
});


// --------------------------------------------------
// 404
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Endpoint not found",
    path: req.path
  });
});


// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error(error);

  lastError =
    error?.message || String(error);

  res.status(500).json({
    status: "error",
    message: lastError
  });
});


// --------------------------------------------------
// START
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Arpit Market Scanner Backend running on port ${PORT}`
  );
});
