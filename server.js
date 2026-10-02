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

  const n = Number(value);

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

  for (
    let i = 0;
    i < line.length;
    i++
  ) {
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
  const lines =
    csv
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
        row => row.symbol
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
    if (
      row.close >
      row.open
    ) {
      structure =
        "Bullish";

      setup =
        "Bullish setup";
    } else if (
      row.close <
      row.open
    ) {
      structure =
        "Bearish";

      setup =
        "Bearish setup";
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

  if (
    !Number.isFinite(base)
  ) {
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

  const resistance =
    Math.max(
      ...recent.map(
        c => c.high
      )
    );

  const support =
    Math.min(
      ...recent.map(
        c => c.low
      )
    );

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
    last.close >
    resistance
  ) {
    breakout =
      "Breakout detected";
  }

  if (
    last.low <= resistance &&
    last.close > resistance
  ) {
    retest =
      "Retest confirmed";
  }

  if (
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
  }

  if (
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
            .toUpperCase()
      }
    });

  return result;
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

      res.json({
        status: "ok",

        symbol,

        source:
          "NSE CM Market MCP",

        data:
          result,

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

function scanner(symbol) {
  const row =
    findStock(symbol);

  if (!row) {
    return {
      symbol,

      status:
        "No NSE equity row found",

      mode:
        "nse-udiff-bhavcopy",

      date:
        latestDate,

      note:
        "Daily BhavCopy contains individual securities. Live market data is available separately through NSE CM Market MCP."
    };
  }

  return {
    symbol,

    status:
      "real NSE daily data",

    mode:
      "nse-udiff-bhavcopy",

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
      priceAction(row)
  };
}

/* =========================================================
   SCANNER ENDPOINT
========================================================= */

app.get(
  "/scanner/:symbol",
  (req, res) => {
    try {
      const symbol =
        req.params.symbol
          .toUpperCase();

      res.json(
        scanner(symbol)
      );

    } catch (error) {
      lastError =
        error.message;

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
      return res.status(404)
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
   TEMP FILE CLEANUP
========================================================= */

function deleteTempFile(path) {
  try {
    if (
      path &&
      fs.existsSync(path)
    ) {
      fs.unlinkSync(path);
    }
  } catch (error) {
    console.log(
      "Temporary file cleanup failed:",
      error.message
    );
  }
}

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
        "NSE UDiFF daily + NSE MCP + educational demo intraday",

      dataStatus,

      latestDate,

      rowCount:
        latestData.length,

      mcpStatus
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
   NSE STATUS
========================================================= */

app.get(
  "/nse/status",
  (req, res) => {
    res.json({
      status:
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
   UPLOAD PAGE
========================================================= */

app.get(
  "/upload",
  (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>

<head>

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
/>

<title>
Arpit Market Scanner - NSE Upload
</title>

<style>

body {
  font-family: Arial, sans-serif;
  background: #111;
  color: #fff;
  padding: 24px;
  margin: 0;
}

.box {
  max-width: 520px;
  margin: 30px auto;
  background: #1d1d1d;
  padding: 24px;
  border-radius: 16px;
}

input {
  width: 100%;
  box-sizing: border-box;
  padding: 14px;
  margin: 15px 0;
}

button {
  width: 100%;
  padding: 15px;
  border: 0;
  border-radius: 8px;
  font-size: 16px;
  font-weight: bold;
}

.info {
  color: #bbb;
  font-size: 14px;
  line-height: 1.5;
}

code {
  color: #6ea8fe;
}

</style>

</head>

<body>

<div class="box">

<h2>
Arpit Market Scanner
</h2>

<p>
Upload NSE UDiFF Bhavcopy
</p>

<p class="info">

CSV या ZIP file upload करें.

<br><br>

NSE MCP connected:

<br>

<code>
/nse/mcp/tools
</code>

<br><br>

Live stock test:

<br>

<code>
/nse/live/20MICRONS
</code>

</p>

<form
  action="/upload-bhavcopy"
  method="POST"
  enctype="multipart/form-data"
>

<input
  type="file"
  name="file"
  accept=".csv,.zip"
  required
>

<button type="submit">
Upload Bhavcopy
</button>

</form>

</div>

</body>

</html>
    `);
  }
);

/* =========================================================
   UPLOAD BHAVCOPY
========================================================= */

app.post(
  "/upload-bhavcopy",
  upload.single("file"),
  (req, res) => {

    if (!req.file) {
      return res
        .status(400)
        .send(
          "CSV or ZIP file required"
        );
    }

    try {
      const buffer =
        fs.readFileSync(
          req.file.path
        );

      const isZip =
        buffer.length >= 2 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b;

      let csv = null;

      if (isZip) {

        const zip =
          new AdmZip(
            buffer
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
            "ZIP does not contain a CSV file"
          );
        }

        csv =
          csvEntry
            .getData()
            .toString("utf8");

      } else {

        csv =
          buffer.toString(
            "utf8"
          );
      }

      const count =
        loadCSV(csv);

      deleteTempFile(
        req.file.path
      );

      res.json({
        status:
          "uploaded",

        rows:
          count,

        latestDate,

        dataStatus,

        message:
          "NSE Bhavcopy loaded successfully"
      });

    } catch (error) {

      deleteTempFile(
        req.file.path
      );

      lastError =
        error.message;

      dataStatus =
        "error";

      res.status(500).json({
        status:
          "upload failed",

        error:
          error.message
      });
    }
  }
);

/* =========================================================
   GENERIC OLD UPLOAD ENDPOINT
========================================================= */

app.post(
  "/upload",
  upload.single("file"),
  (req, res) => {

    if (!req.file) {
      return res
        .status(400)
        .json({
          error:
            "file required"
        });
    }

    try {
      const buffer =
        fs.readFileSync(
          req.file.path
        );

      const isZip =
        buffer.length >= 2 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4b;

      let csv = null;

      if (isZip) {

        const zip =
          new AdmZip(
            buffer
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

        csv =
          csvEntry
            .getData()
            .toString("utf8");

      } else {

        csv =
          buffer.toString(
            "utf8"
          );
      }

      const count =
        loadCSV(csv);

      deleteTempFile(
        req.file.path
      );

      res.json({
        status:
          "ok",

        rows:
          count,

        latestDate,

        dataStatus
      });

    } catch (error) {

      deleteTempFile(
        req.file.path
      );

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
    }
  }
);

/* =========================================================
   HISTORY ENDPOINT
========================================================= */

app.get(
  "/history/:symbol",
  (req, res) => {
    const symbol =
      req.params.symbol
        .toUpperCase();

    const rows =
      latestData.filter(
        row =>
          row.symbol &&
          row.symbol.toUpperCase() ===
            symbol
      );

    res.json({
      status: "ok",

      symbol,

      count:
        rows.length,

      data:
        rows
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
   GLOBAL ERROR
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      "Global error:",
      error
    );

    lastError =
      error.message;

    res.status(500).json({
      status:
        "server error",

      error:
        error.message
    });
  }
);

/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      `Arpit Market Scanner Backend running on port ${PORT}`
    );

    try {

      await Promise.all([
        connectMcp(
          "bhavcopy"
        ),

        connectMcp(
          "cmMarket"
        )
      ]);

      console.log(
        "NSE MCP connections established"
      );

    } catch (error) {

      lastError =
        error.message;

      console.error(
        "NSE MCP startup connection failed:",
        error.message
      );
    }
  }
);
