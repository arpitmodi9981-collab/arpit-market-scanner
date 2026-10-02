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
   CORS
========================================================= */

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

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

app.use(express.json());

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

let dataStatus =
  "waiting for NSE data";

let lastError = null;

let mcpStatus = {
  bhavcopy: "not connected",
  cmMarket: "not connected"
};

/* =========================================================
   MCP CLIENTS
========================================================= */

let bhavcopyClient = null;
let cmMarketClient = null;

/* =========================================================
   BASIC NUMBER HELPER
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

  return Number.isFinite(n)
    ? n
    : null;
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
    .filter(
      line => line.trim()
    );

  if (lines.length < 2) {
    throw new Error(
      "CSV has no data rows"
    );
  }

  const headers =
    parseCSVLine(lines[0]);

  return lines
    .slice(1)
    .map(line => {
      const values =
        parseCSVLine(line);

      const obj = {};

      headers.forEach(
        (header, index) => {
          obj[header] =
            values[index] ?? "";
        }
      );

      return obj;
    });
}

/* =========================================================
   NORMALIZE NSE UDIFF ROW
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

    open:
      num(
        row.OpnPric ??
        row.open
      ),

    high:
      num(
        row.HghPric ??
        row.high
      ),

    low:
      num(
        row.LwPric ??
        row.low
      ),

    close:
      num(
        row.ClsPric ??
        row.close
      ),

    last:
      num(
        row.LastPric ??
        row.last
      ),

    previousClose:
      num(
        row.PrvsClsgPric ??
        row.previousClose
      ),

    volume:
      num(
        row.TtlTradgVol ??
        row.volume
      ),

    turnover:
      num(
        row.TtlTrfVal ??
        row.turnover
      ),

    trades:
      num(
        row.TtlNbOfTxsExctd ??
        row.trades
      ),

    openInterest:
      num(
        row.OpnIntrst ??
        row.openInterest
      ),

    changeInOI:
      num(
        row.ChngInOpnIntrst ??
        row.changeInOI
      )
  };
}

/* =========================================================
   LOAD CSV
========================================================= */

function loadCSV(csv) {
  const rows =
    csvToObjects(csv);

  latestData =
    rows
      .map(normalizeRow)
      .filter(
        row =>
          row.symbol &&
          row.series === "EQ"
      );

  latestDate =
    latestData[0]?.date ||
    null;

  dataStatus =
    "loaded";

  lastError = null;

  return latestData.length;
}

/* =========================================================
   STOCK FINDER
========================================================= */

function findStock(symbol) {
  const wanted =
    String(symbol)
      .trim()
      .toUpperCase();

  return latestData.find(
    row =>
      row.symbol &&
      row.symbol.toUpperCase() ===
        wanted &&
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
    } else if (
      row.volume >= 100000
    ) {
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
   PRICE ACTION
========================================================= */

function priceAction(row) {
  if (!row) {
    return null;
  }

  let structure =
    "Neutral";

  let setup =
    "No confirmed setup";

  if (
    row.close !== null &&
    row.open !== null
  ) {
    if (row.close > row.open) {
      structure =
        "Bullish";

      setup =
        "Bullish structure";
    } else if (
      row.close < row.open
    ) {
      structure =
        "Bearish";

      setup =
        "Bearish structure";
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
        (row.last -
          row.previousClose) /
        row.previousClose
      ) * 100;
  }

  return {
    structure,
    setup,
    changePercent,

    breakout:
      "Needs intraday candles",

    retest:
      "Needs intraday candles",

    falseBreakout:
      "Needs intraday candles"
  };
}

/* =========================================================
   DEMO INTRADAY
========================================================= */

function generateDemoCandles(
  row,
  interval
) {
  if (!row) {
    return [];
  }

  const count =
    interval === "15m"
      ? 32
      : 48;

  const base =
    Number(
      row.last ??
      row.close
    );

  if (!Number.isFinite(base)) {
    return [];
  }

  const dailyRange =
    Number(row.high) -
    Number(row.low);

  const step =
    Number.isFinite(
      dailyRange
    ) &&
    dailyRange > 0
      ? dailyRange / 80
      : base * 0.001;

  const candles = [];

  let previousClose =
    base;

  for (
    let i = 0;
    i < count;
    i++
  ) {
    const wave =
      Math.sin(i * 0.72) *
      step *
      2.2;

    const drift =
      Math.sin(i * 0.19) *
      step;

    const open =
      previousClose;

    const close =
      open +
      wave +
      drift;

    const high =
      Math.max(
        open,
        close
      ) +
      Math.abs(
        step *
        (1 + Math.sin(i))
      );

    const low =
      Math.min(
        open,
        close
      ) -
      Math.abs(
        step *
        (1 + Math.cos(i))
      );

    const volume =
      Math.round(
        500 +
        Math.abs(
          Math.sin(i * 0.5)
        ) *
        2500
      );

    const minutes =
      interval === "15m"
        ? i * 15
        : i * 5;

    const hour =
      9 +
      Math.floor(
        (30 + minutes) / 60
      );

    const minute =
      (30 + minutes) % 60;

    candles.push({
      time:
        String(hour)
          .padStart(2, "0") +
        ":" +
        String(minute)
          .padStart(2, "0"),

      open:
        Number(
          open.toFixed(2)
        ),

      high:
        Number(
          high.toFixed(2)
        ),

      low:
        Number(
          low.toFixed(2)
        ),

      close:
        Number(
          close.toFixed(2)
        ),

      volume
    });

    previousClose =
      close;
  }

  return candles;
}

/* =========================================================
   INTRADAY ANALYSIS
========================================================= */

function analyzeIntraday(
  candles
) {
  if (
    !candles ||
    candles.length < 5
  ) {
    return {
      structure:
        "Neutral",

      breakout:
        "Insufficient candles",

      retest:
        "Insufficient candles",

      falseBreakout:
        "Insufficient candles",

      setup:
        "No confirmed setup"
    };
  }

  const last =
    candles[
      candles.length - 1
    ];

  const previous =
    candles[
      candles.length - 2
    ];

  const recent =
    candles.slice(
      Math.max(
        0,
        candles.length - 10
      )
    );

  const previousRecent =
    candles.slice(
      Math.max(
        0,
        candles.length - 11
      ),
      candles.length - 1
    );

  const resistance =
    previousRecent.length
      ? Math.max(
          ...previousRecent.map(
            c => c.high
          )
        )
      : null;

  const support =
    previousRecent.length
      ? Math.min(
          ...previousRecent.map(
            c => c.low
          )
        )
      : null;

  let structure =
    "Neutral";

  if (
    last.close >
    previous.close
  ) {
    structure =
      "Bullish";
  } else if (
    last.close <
    previous.close
  ) {
    structure =
      "Bearish";
  }

  let breakout =
    "No confirmed breakout";

  let retest =
    "No confirmed retest";

  let falseBreakout =
    "No confirmed false breakout";

  if (
    resistance !== null &&
    last.close > resistance
  ) {
    breakout =
      "Breakout detected";
  }

  if (
    resistance !== null &&
    last.low <= resistance &&
    last.close > resistance
  ) {
    retest =
      "Retest confirmed";
  }

  if (
    resistance !== null &&
    last.high > resistance &&
    last.close < resistance
  ) {
    falseBreakout =
      "False breakout";
  }

  let setup =
    "No confirmed setup";

  if (
    structure === "Bullish" &&
    breakout ===
      "Breakout detected"
  ) {
    setup =
      "Bullish structure";
  } else if (
    structure === "Bearish"
  ) {
    setup =
      "Bearish structure";
  }

  return {
    structure,
    breakout,
    retest,
    falseBreakout,
    setup,
    support,
    resistance
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

  const client =
    new Client({
      name:
        "arpit-market-scanner",

      version:
        "1.0.0"
    });

  const transport =
    new StreamableHTTPClientTransport(
      new URL(url)
    );

  await client.connect(
    transport
  );

  if (isBhavcopy) {
    bhavcopyClient =
      client;

    mcpStatus.bhavcopy =
      "connected";
  } else {
    cmMarketClient =
      client;

    mcpStatus.cmMarket =
      "connected";
  }

  return client;
}

/* =========================================================
   MCP TOOL DISCOVERY
========================================================= */

async function getMcpTools(type) {
  const client =
    await connectMcp(type);

  return await client.listTools();
}

/* =========================================================
   MCP TOOL LIST
========================================================= */

app.get(
  "/nse/mcp/tools",
  async (req, res) => {
    try {
      const [
        bhavcopy,
        cmMarket
      ] =
        await Promise.all([
          getMcpTools(
            "bhavcopy"
          ),

          getMcpTools(
            "cmMarket"
          )
        ]);

      res.json({
        status:
          "connected",

        servers: {
          bhavcopy: {
            url:
              NSE_BHAVCOPY_MCP,

            tools:
              bhavcopy.tools ||
              []
          },

          cmMarket: {
            url:
              NSE_CM_MARKET_MCP,

            tools:
              cmMarket.tools ||
              []
          }
        }
      });

    } catch (error) {
      lastError =
        error.message;

      res.status(500).json({
        status:
          "MCP connection failed",

        error:
          error.message,

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
        arguments:
          toolArguments
      } =
        req.body || {};

      if (
        !server ||
        !tool
      ) {
        return res
          .status(400)
          .json({
            error:
              "server and tool are required"
          });
      }

      const client =
        await connectMcp(
          server ===
            "cmMarket"
            ? "cmMarket"
            : "bhavcopy"
        );

      const result =
        await client.callTool({
          name: tool,

          arguments:
            toolArguments || {}
        });

      res.json({
        status: "ok",
        server,
        tool,
        result
      });

    } catch (error) {
      lastError =
        error.message;

      res.status(500).json({
        status:
          "MCP tool call failed",

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   LIVE NSE STOCK
========================================================= */

async function getMcpLiveStock(
  symbol
) {
  const client =
    await connectMcp(
      "cmMarket"
    );

  const result =
    await client.callTool({
      name:
        "cm_get_equity_stocks",

      arguments: {
        limit: 10,

        symbolFilter:
          String(symbol)
            .trim()
            .toUpperCase()
      }
    });

  return result;
}

/* =========================================================
   PARSE LIVE MCP RESULT
========================================================= */

function parseLiveMcpResult(
  result
) {
  try {
    const text =
      result?.content?.find(
        item =>
          item.type === "text"
      )?.text;

    if (!text) {
      return null;
    }

    const parsed =
      JSON.parse(text);

    if (
      !parsed ||
      !Array.isArray(
        parsed.stocks
      )
    ) {
      return null;
    }

    return (
      parsed.stocks[0] ||
      null
    );

  } catch (error) {
    console.error(
      "MCP result parse error:",
      error.message
    );

    return null;
  }
}

/* =========================================================
   NORMALIZE LIVE NSE STOCK
========================================================= */

function normalizeLiveStock(
  stock
) {
  if (!stock) {
    return null;
  }

  const price =
    num(
      stock.lastTradedPrice
    );

  const previousClose =
    num(
      stock.preClosePrice
    );

  const change =
    num(
      stock.change
    );

  const perChange =
    num(
      stock.perChange
    );

  return {
    symbol:
      stock.symbol ||
      null,

    series:
      stock.series ||
      "EQ",

    type:
      stock.type ||
      "CM",

    price,

    open:
      num(stock.openPrice),

    high:
      num(stock.highPrice),

    low:
      num(stock.lowPrice),

    previousClose,

    change,

    changePercent:
      perChange,

    volume:
      num(stock.volume),

    value:
      num(stock.value),

    fiftyTwoWeekHigh:
      num(
        stock.fiftyTwoWeekHigh
      ),

    fiftyTwoWeekLow:
      num(
        stock.fiftyTwoWeekLow
      ),

    latestTimestamp:
      stock.latestTimestamp ||
      null,

    updatedAt:
      null
  };
}

/* =========================================================
   LIVE PRICE ACTION
========================================================= */

function livePriceAction(
  stock
) {
  if (!stock) {
    return {
      structure:
        "Neutral",

      setup:
        "No confirmed setup"
    };
  }

  let structure =
    "Neutral";

  if (
    stock.changePercent !==
      null &&
    stock.changePercent > 0
  ) {
    structure =
      "Bullish";
  } else if (
    stock.changePercent !==
      null &&
    stock.changePercent < 0
  ) {
    structure =
      "Bearish";
  }

  let setup =
    "No confirmed setup";

  if (
    structure === "Bullish"
  ) {
    setup =
      "Bullish structure";
  } else if (
    structure === "Bearish"
  ) {
    setup =
      "Bearish structure";
  }

  return {
    structure,
    setup,

    changePercent:
      stock.changePercent,

    breakout:
      "Needs intraday candles",

    retest:
      "Needs intraday candles",

    falseBreakout:
      "Needs intraday candles"
  };
}

/* =========================================================
   LIVE STOCK TEST ENDPOINT
========================================================= */

app.get(
  "/nse/live/:symbol",
  async (req, res) => {
    try {
      const symbol =
        req.params.symbol
          .toUpperCase();

      const result =
        await getMcpLiveStock(
          symbol
        );

      const stock =
        parseLiveMcpResult(
          result
        );

      res.json({
        status:
          stock
            ? "ok"
            : "no stock found",

        symbol,

        source:
          "NSE CM Market MCP",

        data:
          result,

        parsedStock:
          normalizeLiveStock(
            stock
          ),

        disclaimer:
          "NSE market data is provided for informational and educational purposes."
      });

    } catch (error) {
      console.error(
        "NSE live error:",
        error
      );

      lastError =
        error.message;

      res.status(500).json({
        status:
          "error",

        symbol:
          req.params.symbol
            .toUpperCase(),

        message:
          error.message
      });
    }
  }
);

/* =========================================================
   INTRADAY ENDPOINT
========================================================= */

app.get(
  "/intraday/:symbol",
  (req, res) => {
    const symbol =
      req.params.symbol
        .toUpperCase();

    const interval =
      req.query.interval ===
      "15m"
        ? "15m"
        : "5m";

    const row =
      findStock(symbol);

    if (!row) {
      return res.json({
        symbol,

        status:
          "no daily base data",

        mode:
          "demo-intraday",

        interval,

        candles: []
      });
    }

    const candles =
      generateDemoCandles(
        row,
        interval
      );

    const analysis =
      analyzeIntraday(
        candles
      );

    res.json({
      symbol,

      status:
        "demo intraday data",

      mode:
        "educational-demo",

      interval,

      baseDate:
        row.date,

      basePrice:
        row.last ??
        row.close,

      candles,

      analysis,

      disclaimer:
        "These candles are generated demo data, not live market data."
    });
  }
);

/* =========================================================
   SCANNER
========================================================= */

async function scanner(
  symbol
) {
  const wanted =
    String(symbol)
      .trim()
      .toUpperCase();

  /* -------------------------------------------------------
     FIRST: NSE CM MARKET MCP
  ------------------------------------------------------- */

  try {
    const result =
      await getMcpLiveStock(
        wanted
      );

    const rawStock =
      parseLiveMcpResult(
        result
      );

    const liveStock =
      normalizeLiveStock(
        rawStock
      );

    if (liveStock) {
      const range =
        liveStock.high !== null &&
        liveStock.low !== null
          ? liveStock.high -
            liveStock.low
          : null;

      let strength =
        "WEAK";

      if (
        liveStock.volume !== null
      ) {
        if (
          liveStock.volume >=
          1000000
        ) {
          strength =
            "STRONG";
        } else if (
          liveStock.volume >=
          100000
        ) {
          strength =
            "MEDIUM";
        }
      }

      return {
        symbol:
          wanted,

        status:
          "NSE CM Market data",

        mode:
          "nse-cm-market-mcp",

        source:
          "NSE CM Market MCP",

        price:
          liveStock.price,

        open:
          liveStock.open,

        high:
          liveStock.high,

        low:
          liveStock.low,

        previousClose:
          liveStock.previousClose,

        change:
          liveStock.change,

        changePercent:
          liveStock.changePercent,

        volume:
          liveStock.volume,

        value:
          liveStock.value,

        fiftyTwoWeekHigh:
          liveStock.fiftyTwoWeekHigh,

        fiftyTwoWeekLow:
          liveStock.fiftyTwoWeekLow,

        latestTimestamp:
          liveStock.latestTimestamp,

        levels: {
          resistance:
            liveStock.high,

          support:
            liveStock.low,

          range,

          strength
        },

        priceAction:
          livePriceAction(
            liveStock
          ),

        intraday: {
          breakout:
            "Needs 5m/15m market candles",

          retest:
            "Needs 5m/15m market candles",

          falseBreakout:
            "Needs 5m/15m market candles"
        },

        disclaimer:
          "NSE market data is provided for informational and educational purposes."
      };
    }

  } catch (error) {
    console.error(
      "Live MCP scanner failed:",
      error.message
    );

    lastError =
      error.message;
  }

  /* -------------------------------------------------------
     FALLBACK: NSE UDIFF BHAVCOPY
  ------------------------------------------------------- */

  const row =
    findStock(wanted);

  if (!row) {
    return {
      symbol: wanted,

      status:
        "No NSE data found",

      mode:
        "nse-cm-market-mcp-with-bhavcopy-fallback",

      date:
        latestDate,

      note:
        "Live NSE CM Market data was unavailable and no matching BhavCopy row was loaded.",

      disclaimer:
        "NSE market data is provided for informational and educational purposes."
    };
  }

  return {
    symbol: wanted,

    status:
      "real NSE daily data",

    mode:
      "nse-udiff-bhavcopy-fallback",

    date:
      row.date,

    price:
      row.last ??
      row.close,

    open:
      row.open,

    high:
      row.high,

    low:
      row.low,

    close:
      row.close,

    previousClose:
      row.previousClose,

    volume:
      row.volume,

    turnover:
      row.turnover,

    trades:
      row.trades,

    levels:
      calculateLevels(row),

    priceAction:
      priceAction(row),

    disclaimer:
      "NSE market data is provided for informational and educational purposes."
  };
}

/* =========================================================
   SCANNER ENDPOINT
========================================================= */

app.get(
  "/scanner/:symbol",
  async (req, res) => {
    try {
      const symbol =
        req.params.symbol
          .toUpperCase();

      const result =
        await scanner(symbol);

      res.json(result);

    } catch (error) {
      lastError =
        error.message;

      console.error(
        "Scanner error:",
        error
      );

      res.status(500).json({
        status:
          "scanner error",

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   DAILY STOCK ENDPOINT
========================================================= */

app.get(
  "/stock/:symbol",
  (req, res) => {
    const symbol =
      req.params.symbol
        .toUpperCase();

    const row =
      findStock(symbol);

    if (!row) {
      return res
        .status(404)
        .json({
          status:
            "not found",

          symbol
        });
    }

    res.json({
      status: "ok",

      stock: row
    });
  }
);

/* =========================================================
   UPLOAD BAHVCOPY ZIP / CSV
========================================================= */

app.post(
  "/upload-bhavcopy",
  upload.single("file"),
  (req, res) => {
    let uploadedPath = null;

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            status:
              "error",

            message:
              "Please upload a BhavCopy ZIP or CSV file using field name 'file'."
          });
      }

      uploadedPath =
        req.file.path;

      const originalName =
        req.file.originalname ||
        "";

      let csvText = "";

      /* ---------------------------------------------------
         ZIP FILE
      --------------------------------------------------- */

      if (
        originalName
          .toLowerCase()
          .endsWith(".zip")
      ) {
        const zip =
          new AdmZip(
            uploadedPath
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
            "No CSV file found inside ZIP."
          );
        }

        csvText =
          csvEntry.getData()
            .toString("utf8");
      }

      /* ---------------------------------------------------
         DIRECT CSV
      --------------------------------------------------- */

      else if (
        originalName
          .toLowerCase()
          .endsWith(".csv")
      ) {
        csvText =
          fs.readFileSync(
            uploadedPath,
            "utf8"
          );
      }

      else {
        throw new Error(
          "Only .zip or .csv files are supported."
        );
      }

      const count =
        loadCSV(csvText);

      res.json({
        status:
          "success",

        message:
          "NSE BhavCopy loaded successfully.",

        rows:
          count,

        date:
          latestDate,

        dataStatus,

        file:
          originalName
      });

    } catch (error) {
      lastError =
        error.message;

      dataStatus =
        "error";

      console.error(
        "BhavCopy upload error:",
        error
      );

      res.status(500).json({
        status:
          "error",

        message:
          error.message
      });

    } finally {
      deleteTempFile(
        uploadedPath
      );
    }
  }
);

/* =========================================================
   GENERIC UPLOAD ENDPOINT
========================================================= */

app.post(
  "/upload",
  upload.single("file"),
  (req, res) => {
    let uploadedPath = null;

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            status:
              "error",

            message:
              "No file uploaded."
          });
      }

      uploadedPath =
        req.file.path;

      const originalName =
        req.file.originalname ||
        "";

      let csvText = "";

      if (
        originalName
          .toLowerCase()
          .endsWith(".zip")
      ) {
        const zip =
          new AdmZip(
            uploadedPath
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
            "No CSV file found inside ZIP."
          );
        }

        csvText =
          csvEntry.getData()
            .toString("utf8");
      } else {
        csvText =
          fs.readFileSync(
            uploadedPath,
            "utf8"
          );
      }

      const count =
        loadCSV(csvText);

      res.json({
        status:
          "success",

        rows:
          count,

        date:
          latestDate,

        dataStatus
      });

    } catch (error) {
      lastError =
        error.message;

      dataStatus =
        "error";

      res.status(500).json({
        status:
          "error",

        error:
          error.message
      });

    } finally {
      deleteTempFile(
        uploadedPath
      );
    }
  }
);

/* =========================================================
   NSE STATUS
========================================================= */

app.get(
  "/nse/status",
  async (req, res) => {
    let bhavcopy =
      mcpStatus.bhavcopy;

    let cmMarket =
      mcpStatus.cmMarket;

    try {
      await connectMcp(
        "bhavcopy"
      );

      bhavcopy =
        mcpStatus.bhavcopy;
    } catch (error) {
      bhavcopy =
        "error";

      lastError =
        error.message;
    }

    try {
      await connectMcp(
        "cmMarket"
      );

      cmMarket =
        mcpStatus.cmMarket;
    } catch (error) {
      cmMarket =
        "error";

      lastError =
        error.message;
    }

    res.json({
      status:
        "ok",

      mcpStatus: {
        bhavcopy,
        cmMarket
      },

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
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      app:
        "Arpit Market Scanner Backend",

      dataStatus,

      latestDate,

      rowCount:
        latestData.length,

      mcpStatus,

      lastError
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

      mode:
        "NSE MCP + BhavCopy",

      endpoints: {
        health:
          "/health",

        nseStatus:
          "/nse/status",

        mcpTools:
          "/nse/mcp/tools",

        liveStock:
          "/nse/live/:symbol",

        scanner:
          "/scanner/:symbol",

        stock:
          "/stock/:symbol",

        intraday:
          "/intraday/:symbol?interval=5m",

        uploadBhavcopy:
          "POST /upload-bhavcopy",

        upload:
          "POST /upload",

        mcpCall:
          "POST /nse/mcp/call"
      },

      message:
        "Backend is ready."
    });
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      status:
        "not found",

      path:
        req.originalUrl
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "Unhandled error:",
      error
    );

    lastError =
      error.message;

    res.status(
      error.status || 500
    ).json({
      status:
        "error",

      message:
        error.message ||
        "Internal server error"
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `Arpit Market Scanner Backend running on port ${PORT}`
    );
  }
);
