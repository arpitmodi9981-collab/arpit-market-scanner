const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");

const {
  Client,
  StreamableHTTPClientTransport
} = require("@modelcontextprotocol/client");

const app = express();

const PORT = process.env.PORT || 10000;

/* =========================================================
   NSE MCP URLS
========================================================= */

const NSE_BHAVCOPY_MCP =
  "https://mcp.nseindia.in/bhavcopy/cm/mcp";

const NSE_CM_MARKET_MCP =
  "https://mcp.nseindia.in/cmmkt/mcp";

/* =========================================================
   APP
========================================================= */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "5mb" }));

/* =========================================================
   UPLOAD
========================================================= */

const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/* =========================================================
   MEMORY
========================================================= */

let latestData = [];
let latestDate = null;

let dataStatus = "waiting for NSE data";
let lastError = null;

let mcpStatus = {
  bhavcopy: "not connected",
  cmMarket: "not connected"
};

let bhavcopyClient = null;
let cmMarketClient = null;

/* =========================================================
   HELPERS
========================================================= */

function num(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const n = Number(
    String(value).replace(/,/g, "")
  );

  return Number.isFinite(n) ? n : null;
}

function cleanSymbol(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase();
}

/* =========================================================
   CSV PARSER
========================================================= */

function parseCSVLine(line) {
  const result = [];

  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (
        quoted &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (
      ch === "," &&
      !quoted
    ) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  result.push(current);

  return result;
}

function csvToObjects(csv) {
  const lines = String(csv)
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error("CSV has no data rows");
  }

  const headers = parseCSVLine(lines[0]);

  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = values[index] ?? "";
    });

    return obj;
  });
}

/* =========================================================
   NORMALIZE BHAAVCOPY
========================================================= */

function normalizeRow(row) {
  return {
    date:
      row.TradDt ||
      row.date ||
      null,

    symbol:
      row.TckrSymb ||
      row.symbol ||
      row.ticker ||
      null,

    series:
      row.SctySrs ||
      row.series ||
      "EQ",

    instrumentType:
      row.FinInstrmTp ||
      row.instrumentType ||
      null,

    name:
      row.FininstrmNm ||
      row.name ||
      null,

    open: num(
      row.OpnPric ?? row.open
    ),

    high: num(
      row.HghPric ?? row.high
    ),

    low: num(
      row.LwPric ?? row.low
    ),

    close: num(
      row.ClsPric ?? row.close
    ),

    last: num(
      row.LastPric ?? row.last
    ),

    previousClose: num(
      row.PrvsClsgPric ??
      row.previousClose
    ),

    volume: num(
      row.TtlTradgVol ??
      row.volume
    ),

    turnover: num(
      row.TtlTrfVal ??
      row.turnover
    ),

    trades: num(
      row.TtlNbOfTxsExctd ??
      row.trades
    ),

    openInterest: num(
      row.OpnIntrst ??
      row.openInterest
    ),

    changeInOI: num(
      row.ChngInOpnIntrst ??
      row.changeInOI
    )
  };
}

/* =========================================================
   LOAD CSV
========================================================= */

function loadCSV(csv) {
  const rows = csvToObjects(csv);

  latestData = rows
    .map(normalizeRow)
    .filter(
      row =>
        row.symbol &&
        row.series === "EQ"
    );

  latestDate =
    latestData[0]?.date || null;

  dataStatus = "loaded";
  lastError = null;

  return latestData.length;
}

/* =========================================================
   STOCK FINDER
========================================================= */

function findStock(symbol) {
  const wanted = cleanSymbol(symbol);

  return latestData.find(
    row =>
      row.symbol &&
      cleanSymbol(row.symbol) === wanted &&
      row.series === "EQ"
  );
}

/* =========================================================
   DAILY LEVELS
========================================================= */

function calculateLevels(row) {
  if (!row) {
    return null;
  }

  const range =
    row.high !== null &&
    row.low !== null
      ? row.high - row.low
      : null;

  let strength = "WEAK";

  if (row.volume !== null) {
    if (row.volume >= 1000000) {
      strength = "STRONG";
    } else if (row.volume >= 100000) {
      strength = "MEDIUM";
    }
  }

  return {
    resistance: row.high,
    support: row.low,
    range,
    strength
  };
}

/* =========================================================
   DAILY PRICE ACTION
========================================================= */

function priceAction(row) {
  if (!row) {
    return null;
  }

  let structure = "Neutral";
  let setup = "No confirmed setup";

  if (
    row.close !== null &&
    row.open !== null
  ) {
    if (row.close > row.open) {
      structure = "Bullish";
      setup = "Bullish structure";
    } else if (row.close < row.open) {
      structure = "Bearish";
      setup = "Bearish structure";
    }
  }

  let changePercent = null;

  if (
    row.previousClose !== null &&
    row.previousClose !== 0 &&
    row.last !== null
  ) {
    changePercent =
      (
        (row.last - row.previousClose) /
        row.previousClose
      ) * 100;
  }

  return {
    structure,
    setup,
    changePercent,

    breakout: "Intraday candles unavailable",
    retest: "Intraday candles unavailable",
    falseBreakout: "Intraday candles unavailable"
  };
}

/* =========================================================
   MCP CONNECTION
========================================================= */

async function connectMcp(type) {
  const isBhavcopy =
    type === "bhavcopy";

  const url =
    isBhavcopy
      ? NSE_BHAVCOPY_MCP
      : NSE_CM_MARKET_MCP;

  const existing =
    isBhavcopy
      ? bhavcopyClient
      : cmMarketClient;

  if (existing) {
    return existing;
  }

  const client = new Client({
    name: "arpit-market-scanner",
    version: "1.0.0"
  });

  const transport =
    new StreamableHTTPClientTransport(
      new URL(url)
    );

  await client.connect(transport);

  if (isBhavcopy) {
    bhavcopyClient = client;
    mcpStatus.bhavcopy = "connected";
  } else {
    cmMarketClient = client;
    mcpStatus.cmMarket = "connected";
  }

  return client;
}

/* =========================================================
   MCP TOOLS
========================================================= */

async function getMcpTools(type) {
  const client = await connectMcp(type);
  return await client.listTools();
}

app.get(
  "/nse/mcp/tools",
  async (req, res) => {
    try {
      const [
        bhavcopy,
        cmMarket
      ] = await Promise.all([
        getMcpTools("bhavcopy"),
        getMcpTools("cmMarket")
      ]);

      res.json({
        status: "connected",

        servers: {
          bhavcopy: {
            url: NSE_BHAVCOPY_MCP,
            tools: bhavcopy.tools || []
          },

          cmMarket: {
            url: NSE_CM_MARKET_MCP,
            tools: cmMarket.tools || []
          }
        }
      });
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "MCP connection failed",
        error: error.message,
        mcpStatus
      });
    }
  }
);

/* =========================================================
   GENERIC MCP CALL
========================================================= */

app.post(
  "/nse/mcp/call",
  async (req, res) => {
    try {
      const {
        server,
        tool,
        arguments: toolArguments
      } = req.body || {};

      if (!server || !tool) {
        return res.status(400).json({
          error:
            "server and tool are required"
        });
      }

      const client =
        await connectMcp(
          server === "cmMarket"
            ? "cmMarket"
            : "bhavcopy"
        );

      const result =
        await client.callTool({
          name: tool,
          arguments: toolArguments || {}
        });

      res.json({
        status: "ok",
        server,
        tool,
        result
      });
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "MCP tool call failed",
        error: error.message
      });
    }
  }
);

/* =========================================================
   NSE LIVE STOCK
========================================================= */

async function getMcpLiveStock(symbol) {
  const client =
    await connectMcp("cmMarket");

  return await client.callTool({
    name: "cm_get_equity_stocks",

    arguments: {
      limit: 10,
      symbolFilter: cleanSymbol(symbol)
    }
  });
}

/* =========================================================
   PARSE LIVE MCP
========================================================= */

function parseLiveMcpResult(result) {
  try {
    const text =
      result?.content?.find(
        item => item.type === "text"
      )?.text;

    if (!text) {
      return null;
    }

    const parsed = JSON.parse(text);

    if (
      !parsed ||
      !Array.isArray(parsed.stocks)
    ) {
      return null;
    }

    return parsed.stocks[0] || null;
  } catch (error) {
    console.error(
      "MCP result parse error:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   NORMALIZE LIVE STOCK
========================================================= */

function normalizeLiveStock(stock) {
  if (!stock) {
    return null;
  }

  return {
    symbol:
      stock.symbol || null,

    series:
      stock.series || "EQ",

    type:
      stock.type || "CM",

    price:
      num(stock.lastTradedPrice),

    open:
      num(stock.openPrice),

    high:
      num(stock.highPrice),

    low:
      num(stock.lowPrice),

    previousClose:
      num(stock.preClosePrice),

    change:
      num(stock.change),

    changePercent:
      num(stock.perChange),

    volume:
      num(stock.volume),

    value:
      num(stock.value),

    fiftyTwoWeekHigh:
      num(stock.fiftyTwoWeekHigh),

    fiftyTwoWeekLow:
      num(stock.fiftyTwoWeekLow),

    latestTimestamp:
      stock.latestTimestamp || null
  };
}

/* =========================================================
   LIVE PRICE ACTION
========================================================= */

function livePriceAction(stock) {
  if (!stock) {
    return {
      structure: "Neutral",
      setup: "No confirmed setup",
      breakout:
        "Intraday candles unavailable",
      retest:
        "Intraday candles unavailable",
      falseBreakout:
        "Intraday candles unavailable"
    };
  }

  let structure = "Neutral";

  if (
    stock.changePercent !== null
  ) {
    if (stock.changePercent > 0) {
      structure = "Bullish";
    } else if (
      stock.changePercent < 0
    ) {
      structure = "Bearish";
    }
  }

  let setup = "No confirmed setup";

  if (structure === "Bullish") {
    setup = "Bullish structure";
  } else if (structure === "Bearish") {
    setup = "Bearish structure";
  }

  return {
    structure,
    setup,

    changePercent:
      stock.changePercent,

    breakout:
      "Intraday candles unavailable",

    retest:
      "Intraday candles unavailable",

    falseBreakout:
      "Intraday candles unavailable"
  };
}

/* =========================================================
   LIVE TEST
========================================================= */

app.get(
  "/nse/live/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(req.params.symbol);

    try {
      const result =
        await getMcpLiveStock(symbol);

      const stock =
        parseLiveMcpResult(result);

      res.json({
        status:
          stock
            ? "ok"
            : "no stock found",

        symbol,

        source:
          "NSE CM Market MCP",

        data: result,

        parsedStock:
          normalizeLiveStock(stock),

        disclaimer:
          "NSE market data is provided for informational and educational purposes."
      });
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "error",
        symbol,
        message: error.message
      });
    }
  }
);

/* =========================================================
   INTRADAY
   IMPORTANT:
   No fake candles.
   ========================================================= */

app.get(
  "/intraday/:symbol",
  async (req, res) => {
    const symbol =
      cleanSymbol(req.params.symbol);

    const interval =
      req.query.interval === "15m"
        ? "15m"
        : "5m";

    res.json({
      status:
        "intraday_data_unavailable",

      symbol,

      interval,

      candles: [],

      analysis: {
        structure: "Unavailable",

        breakout:
          "Actual intraday candles required",

        retest:
          "Actual intraday candles required",

        falseBreakout:
          "Actual intraday candles required",

        setup:
          "No confirmed setup"
      },

      message:
        "NSE CM Market MCP currently provides the quote used by this backend, not a 5m/15m candle series.",

      disclaimer:
        "Do not treat this endpoint as live 5m/15m trading data."
    });
  }
);

/* =========================================================
   SCANNER
========================================================= */

async function scanner(symbol) {
  const wanted =
    cleanSymbol(symbol);

  /* -----------------------------------------
     FIRST: NSE CM MARKET MCP
  ----------------------------------------- */

  try {
    const result =
      await getMcpLiveStock(wanted);

    const liveStock =
      parseLiveMcpResult(result);

    const stock =
      normalizeLiveStock(liveStock);

    if (stock) {
      const levels = {
        resistance: stock.high,
        support: stock.low,

        range:
          stock.high !== null &&
          stock.low !== null
            ? stock.high - stock.low
            : null,

        strength: "WEAK"
      };

      return {
        symbol: stock.symbol,

        status:
          "NSE CM Market data",

        mode:
          "nse-cm-market-mcp",

        source:
          "NSE CM Market MCP",

        price:
          stock.price,

        open:
          stock.open,

        high:
          stock.high,

        low:
          stock.low,

        previousClose:
          stock.previousClose,

        change:
          stock.change,

        changePercent:
          stock.changePercent,

        volume:
          stock.volume,

        value:
          stock.value,

        fiftyTwoWeekHigh:
          stock.fiftyTwoWeekHigh,

        fiftyTwoWeekLow:
          stock.fiftyTwoWeekLow,

        latestTimestamp:
          stock.latestTimestamp,

        levels,

        priceAction:
          livePriceAction(stock),

        intraday: {
          status:
            "unavailable",

          interval5m:
            "Actual 5m candles required",

          interval15m:
            "Actual 15m candles required",

          breakout:
            "Not calculated",

          retest:
            "Not calculated",

          falseBreakout:
            "Not calculated"
        },

        disclaimer:
          "NSE market data is provided for informational and educational purposes."
      };
    }
  } catch (error) {
    lastError = error.message;
  }

  /* -----------------------------------------
     SECOND: BHAWCOPY FALLBACK
  ----------------------------------------- */

  const row =
    findStock(wanted);

  if (!row) {
    return {
      symbol: wanted,

      status:
        "stock_not_found",

      mode:
        "no_data",

      message:
        "No NSE CM Market MCP data and no uploaded BhavCopy data found.",

      intraday: {
        status:
          "unavailable"
      }
    };
  }

  return {
    symbol: wanted,

    status:
      "BhavCopy data",

    mode:
      "bhavcopy",

    source:
      "Uploaded NSE BhavCopy",

    date:
      row.date,

    open:
      row.open,

    high:
      row.high,

    low:
      row.low,

    close:
      row.close,

    last:
      row.last,

    previousClose:
      row.previousClose,

    volume:
      row.volume,

    turnover:
      row.turnover,

    levels:
      calculateLevels(row),

    priceAction:
      priceAction(row),

    intraday: {
      status:
        "unavailable",

      breakout:
        "Actual 5m/15m candles required",

      retest:
        "Actual 5m/15m candles required",

      falseBreakout:
        "Actual 5m/15m candles required"
    },

    disclaimer:
      "BhavCopy is end-of-day data and is not a 5m/15m intraday feed."
  };
}

/* =========================================================
   SCANNER ENDPOINT
========================================================= */

app.get(
  "/scanner/:symbol",
  async (req, res) => {
    try {
      const result =
        await scanner(
          req.params.symbol
        );

      res.json(result);
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "error",

        symbol:
          cleanSymbol(
            req.params.symbol
          ),

        message:
          error.message
      });
    }
  }
);

/* =========================================================
   STOCK ENDPOINT
========================================================= */

app.get(
  "/stock/:symbol",
  async (req, res) => {
    try {
      const result =
        await scanner(
          req.params.symbol
        );

      res.json(result);
    } catch (error) {
      lastError = error.message;

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

/* =========================================================
   UPLOAD BHAWCOPY
========================================================= */

app.post(
  "/upload-bhavcopy",
  upload.single("file"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "No file uploaded"
        });
      }

      const originalName =
        req.file.originalname || "";

      const isZip =
        originalName
          .toLowerCase()
          .endsWith(".zip");

      let csvText = "";

      if (isZip) {
        const zip =
          new AdmZip(
            req.file.path
          );

        const entries =
          zip.getEntries();

        const csvEntry =
          entries.find(
            entry =>
              !entry.isDirectory &&
              entry.entryName
                .toLowerCase()
                .endsWith(".csv")
          );

        if (!csvEntry) {
          throw new Error(
            "No CSV file found inside ZIP"
          );
        }

        csvText =
          csvEntry.getData()
            .toString("utf8");
      } else {
        csvText =
          fs.readFileSync(
            req.file.path,
            "utf8"
          );
      }

      const count =
        loadCSV(csvText);

      try {
        fs.unlinkSync(
          req.file.path
        );
      } catch {}

      res.json({
        status: "ok",

        message:
          "BhavCopy loaded successfully",

        rowCount:
          count,

        latestDate,

        dataStatus
      });
    } catch (error) {
      lastError =
        error.message;

      try {
        if (req.file?.path) {
          fs.unlinkSync(
            req.file.path
          );
        }
      } catch {}

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

/* =========================================================
   UPLOAD ALIAS
========================================================= */

app.post(
  "/upload",
  upload.single("file"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          status: "error",
          message: "No file uploaded"
        });
      }

      const originalName =
        req.file.originalname || "";

      let csvText = "";

      if (
        originalName
          .toLowerCase()
          .endsWith(".zip")
      ) {
        const zip =
          new AdmZip(
            req.file.path
          );

        const entries =
          zip.getEntries();

        const csvEntry =
          entries.find(
            entry =>
              !entry.isDirectory &&
              entry.entryName
                .toLowerCase()
                .endsWith(".csv")
          );

        if (!csvEntry) {
          throw new Error(
            "No CSV file found inside ZIP"
          );
        }

        csvText =
          csvEntry.getData()
            .toString("utf8");
      } else {
        csvText =
          fs.readFileSync(
            req.file.path,
            "utf8"
          );
      }

      const count =
        loadCSV(csvText);

      try {
        fs.unlinkSync(
          req.file.path
        );
      } catch {}

      res.json({
        status: "ok",
        rowCount: count,
        latestDate,
        dataStatus
      });
    } catch (error) {
      lastError =
        error.message;

      try {
        if (req.file?.path) {
          fs.unlinkSync(
            req.file.path
          );
        }
      } catch {}

      res.status(500).json({
        status: "error",
        message: error.message
      });
    }
  }
);

/* =========================================================
   NSE STATUS
========================================================= */

app.get(
  "/nse/status",
  async (req, res) => {
    try {
      await Promise.all([
        connectMcp("bhavcopy"),
        connectMcp("cmMarket")
      ]);

      res.json({
        status: "ok",

        mcpStatus,

        dataStatus,

        latestDate,

        rowCount:
          latestData.length,

        lastError,

        sources: {
          bhavcopy:
            NSE_BHAVCOPY_MCP,

          cmMarket:
            NSE_CM_MARKET_MCP
        }
      });
    } catch (error) {
      lastError =
        error.message;

      res.status(500).json({
        status: "error",

        mcpStatus,

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status: "ok",

      app:
        "Arpit Market Scanner Backend",

      dataStatus,

      latestDate,

      rowCount:
        latestData.length,

      mcpStatus,

      lastError,

      intraday:
        "5m/15m actual candle feed not connected"
    });
  }
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      app:
        "Arpit Market Scanner Backend",

      status:
        "online",

      version:
        "1.0.0",

      endpoints: {
        health:
          "/health",

        nseStatus:
          "/nse/status",

        nseTools:
          "/nse/mcp/tools",

        nseLive:
          "/nse/live/:symbol",

        scanner:
          "/scanner/:symbol",

        stock:
          "/stock/:symbol",

        intraday:
          "/intraday/:symbol?interval=5m",

        upload:
          "/upload-bhavcopy"
      },

      dataSources: {
        quote:
          "NSE CM Market MCP",

        bhavcopy:
          "NSE BhavCopy",

        intraday:
          "Not connected"
      }
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      status: "not_found",

      path:
        req.originalUrl
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(
      "Server error:",
      error
    );

    lastError =
      error.message;

    res.status(500).json({
      status: "error",
      message:
        error.message
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Arpit Market Scanner Backend running on port ${PORT}`
    );
  }
);
