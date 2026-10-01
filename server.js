const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

/* ---------- CORS ---------- */

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

/* ---------- Upload ---------- */

const upload = multer({
  dest: "/tmp/uploads",
  limits: {
    fileSize: 50 * 1024 * 1024
  }
});

/* ---------- Memory ---------- */

let latestData = [];
let latestDate = null;
let dataStatus = "waiting for CSV upload";
let lastError = null;

/* ---------- Helpers ---------- */

function num(value) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
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
  const lines = csv
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

function normalizeRow(row) {
  return {
    date: row.TradDt || null,
    symbol: row.TckrSymb || null,
    series: row.SctySrs || null,
    instrumentType: row.FinInstrmTp || null,
    name: row.FininstrmNm || null,

    open: num(row.OpnPric),
    high: num(row.HghPric),
    low: num(row.LwPric),
    close: num(row.ClsPric),
    last: num(row.LastPric),

    previousClose: num(row.PrvsClsgPric),
    volume: num(row.TtlTradgVol),
    turnover: num(row.TtlTrfVal),
    trades: num(row.TtlNbOfTxsExctd),

    openInterest: num(row.OpnIntrst),
    changeInOI: num(row.ChngInOpnIntrst)
  };
}

function loadCSV(csv) {
  const rows = csvToObjects(csv);

  latestData = rows
    .map(normalizeRow)
    .filter(row => row.symbol);

  latestDate = latestData[0]?.date || null;
  dataStatus = "loaded";
  lastError = null;

  return latestData.length;
}

function findStock(symbol) {
  const wanted = symbol.toUpperCase();

  return latestData.find(row =>
    row.symbol &&
    row.symbol.toUpperCase() === wanted &&
    row.series === "EQ"
  );
}

/* ---------- Daily Levels ---------- */

function calculateLevels(row) {
  if (!row) return null;

  const range =
    row.high !== null && row.low !== null
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

/* ---------- Daily Price Action ---------- */

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
      setup = "Bullish setup";
    } else if (row.close < row.open) {
      structure = "Bearish";
      setup = "Bearish setup";
    }
  }

  let changePercent = null;

  if (
    row.previousClose !== null &&
    row.previousClose !== 0 &&
    row.last !== null
  ) {
    changePercent =
      ((row.last - row.previousClose) /
        row.previousClose) * 100;
  }

  return {
    structure,
    setup,
    changePercent,

    breakout: "Needs intraday candles",
    retest: "Needs intraday candles",
    falseBreakout: "Needs intraday candles"
  };
}

/* =========================================================
   DEMO INTRADAY ENGINE

   IMPORTANT:
   These are generated educational candles.
   They are NOT live market data.
========================================================= */

function generateDemoCandles(row, interval) {
  if (!row) {
    return [];
  }

  const count =
    interval === "15m"
      ? 32
      : 48;

  const base =
    Number(row.last ?? row.close);

  if (!Number.isFinite(base)) {
    return [];
  }

  const dailyRange =
    Number(row.high) -
    Number(row.low);

  const step =
    Number.isFinite(dailyRange) &&
    dailyRange > 0
      ? dailyRange / 80
      : base * 0.001;

  const candles = [];

  let previousClose = base;

  for (let i = 0; i < count; i++) {

    /*
      Deterministic movement.
      Same daily input = same demo candles.
    */

    const wave =
      Math.sin(i * 0.72) * step * 2.2;

    const drift =
      Math.sin(i * 0.19) * step;

    const open =
      previousClose;

    const close =
      open + wave + drift;

    const high =
      Math.max(open, close) +
      Math.abs(step * (1 + Math.sin(i)));

    const low =
      Math.min(open, close) -
      Math.abs(step * (1 + Math.cos(i)));

    const volume =
      Math.round(
        500 +
        Math.abs(
          Math.sin(i * 0.5)
        ) * 2500
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
        String(hour).padStart(2, "0") +
        ":" +
        String(minute).padStart(2, "0"),

      open: Number(open.toFixed(2)),
      high: Number(high.toFixed(2)),
      low: Number(low.toFixed(2)),
      close: Number(close.toFixed(2)),
      volume
    });

    previousClose = close;
  }

  return candles;
}

/* ---------- Intraday Analysis ---------- */

function analyzeIntraday(candles) {

  if (!candles || candles.length < 5) {
    return {
      structure: "Neutral",
      breakout: "Insufficient candles",
      retest: "Insufficient candles",
      falseBreakout: "Insufficient candles",
      setup: "No confirmed setup"
    };
  }

  const last =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const recent =
    candles.slice(
      Math.max(0, candles.length - 10)
    );

  const resistance =
    Math.max(
      ...recent.map(c => c.high)
    );

  const support =
    Math.min(
      ...recent.map(c => c.low)
    );

  let structure = "Neutral";

  if (last.close > previous.close) {
    structure = "Bullish";
  } else if (last.close < previous.close) {
    structure = "Bearish";
  }

  let breakout =
    "No confirmed breakout";

  let retest =
    "No confirmed retest";

  let falseBreakout =
    "No confirmed false breakout";

  /*
    Educational classification only.
  */

  if (last.close > resistance) {
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
    breakout === "Breakout detected"
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
    setup
  };
}

/* ---------- Intraday Endpoint ---------- */

app.get(
  "/intraday/:symbol",
  (req, res) => {

    const symbol =
      req.params.symbol.toUpperCase();

    const interval =
      req.query.interval === "15m"
        ? "15m"
        : "5m";

    const row =
      findStock(symbol);

    if (!row) {

      return res.json({
        symbol,
        status: "no daily base data",
        mode: "demo-intraday",
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
      analyzeIntraday(candles);

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
        row.last ?? row.close,

      candles,

      analysis,

      disclaimer:
        "These candles are generated demo data, not live market data."
    });
  }
);

/* ---------- Combined Scanner ---------- */

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
        "Daily BhavCopy contains individual securities. NIFTY/BANKNIFTY and live intraday data require a separate data source."

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
      row.last ?? row.close,

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

/* ---------- Temp Cleanup ---------- */

function deleteTempFile(path) {

  try {

    if (
      path &&
      fs.existsSync(path)
    ) {

      fs.unlinkSync(path);

    }

  } catch (e) {

    console.log(
      "Temporary file cleanup failed:",
      e.message
    );

  }
}

/* ---------- Home ---------- */

app.get("/", (req, res) => {

  res.json({

    app:
      "Arpit Market Scanner Backend",

    status:
      "online",

    mode:
      "NSE UDiFF daily + educational demo intraday",

    dataStatus,

    latestDate,

    rowCount:
      latestData.length

  });

});

/* ---------- Health ---------- */

app.get("/health", (req, res) => {

  res.json({

    status:
      "ok",

    dataStatus,

    latestDate,

    rowCount:
      latestData.length

  });

});

/* ---------- NSE Status ---------- */

app.get("/nse/status", (req, res) => {

  res.json({

    status:
      dataStatus,

    latestDate,

    rowCount:
      latestData.length,

    lastError

  });

});

/* ---------- Upload Page ---------- */

app.get("/upload", (req, res) => {

  res.send(`

<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width, initial-scale=1">

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

CSV or ZIP file upload करें.

<br><br>

Example:

BhavCopy_NSE_CM_0_0_0_20260929_F_0000.csv.zip

</p>

<form
action="/upload-bhavcopy"
method="POST"
enctype="multipart/form-data">

<input
type="file"
name="file"
accept=".csv,.zip"
required>

<button type="submit">
Upload Bhavcopy
</button>

</form>

</div>

</body>

</html>

  `);

});

/* ---------- Upload ---------- */

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

      let csv;

      if (isZip) {

        const zip =
          new AdmZip(buffer);

        const entry =
          zip.getEntries().find(
            item =>
              !item.isDirectory &&
              item.entryName
                .toLowerCase()
                .endsWith(".csv")
          );

        if (!entry) {

          throw new Error(
            "CSV not found inside ZIP"
          );

        }

        csv =
          entry
            .getData()
            .toString("utf8");

      } else {

        csv =
          buffer.toString("utf8");

      }

      const count =
        loadCSV(csv);

      deleteTempFile(
        req.file.path
      );

      res.send(`

<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width, initial-scale=1">

<title>
Upload Complete
</title>

</head>

<body style="
font-family:Arial;
padding:30px;
background:#111;
color:#fff
">

<h2>
✅ Upload successful
</h2>

<p>
Date: ${latestDate || "unknown"}
</p>

<p>
Rows loaded: ${count}
</p>

<p>
<a
href="/nse/status"
style="color:#6ea8fe">
View NSE Status
</a>
</p>

<p>
<a
href="/scanner/20MICRONS"
style="color:#6ea8fe">
Test Scanner
</a>
</p>

<p>
<a
href="/intraday/20MICRONS?interval=5m"
style="color:#6ea8fe">
Test Demo 5m Data
</a>
</p>

</body>

</html>

      `);

    } catch (error) {

      dataStatus =
        "load failed";

      lastError =
        error.message;

      deleteTempFile(
        req.file.path
      );

      res
        .status(500)
        .send(`

<h2>
Upload failed
</h2>

<p>
${error.message}
</p>

        `);

    }

  }
);

/* ---------- Stock ---------- */

app.get(
  "/stock/:symbol",
  (req, res) => {

    const row =
      findStock(
        req.params.symbol
      );

    if (!row) {

      return res
        .status(404)
        .json({

          status:
            "not found",

          symbol:
            req.params.symbol,

          latestDate

        });

    }

    res.json(row);

  }
);

/* ---------- Scanner ---------- */

app.get(
  "/scanner/:symbol",
  (req, res) => {

    res.json(
      scanner(
        req.params.symbol
      )
    );

  }
);

/* ---------- History ---------- */

app.get(
  "/history/:symbol",
  (req, res) => {

    const symbol =
      req.params.symbol.toUpperCase();

    const rows =
      latestData.filter(row =>
        row.symbol &&
        row.symbol.toUpperCase() ===
          symbol &&
        row.series === "EQ"
      );

    res.json({

      symbol,

      status:
        rows.length
          ? "available"
          : "not found",

      mode:
        "nse-udiff-bhavcopy",

      rows

    });

  }
);

/* ---------- Start ---------- */

app.listen(
  PORT,
  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }
);
