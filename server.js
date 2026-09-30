const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

const upload = multer({
  dest: "/tmp/uploads",
  limits: { fileSize: 50 * 1024 * 1024 }
});

let latestData = [];
let latestDate = null;
let dataStatus = "waiting for CSV upload";
let lastError = null;

function num(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
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

    headers.forEach((header, i) => {
      obj[header] = values[i] ?? "";
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

function calculateLevels(row) {
  if (!row) return null;

  const range =
    row.high !== null && row.low !== null
      ? row.high - row.low
      : null;

  let strength = "WEAK";

  if (row.volume !== null) {
    if (row.volume >= 1000000) strength = "STRONG";
    else if (row.volume >= 100000) strength = "MEDIUM";
  }

  return {
    resistance: row.high,
    support: row.low,
    range,
    strength
  };
}

function priceAction(row) {
  if (!row) return null;

  let structure = "Neutral";

  if (
    row.close !== null &&
    row.open !== null
  ) {
    if (row.close > row.open) structure = "Bullish";
    if (row.close < row.open) structure = "Bearish";
  }

  const changePercent =
    row.previousClose &&
    row.last !== null
      ? ((row.last - row.previousClose) / row.previousClose) * 100
      : null;

  return {
    structure,
    changePercent,
    breakout: "Needs intraday/previous-session data",
    retest: "Needs intraday/previous-session data",
    falseBreakout: "Needs intraday/previous-session data"
  };
}

function scanner(symbol) {
  const row = findStock(symbol);

  if (!row) {
    return {
      symbol,
      status: "No NSE equity row found",
      mode: "nse-udiff-bhavcopy",
      date: latestDate,
      note:
        "This daily CM Bhavcopy contains individual securities. " +
        "Intraday 5m/15m index data requires a separate source."
    };
  }

  return {
    symbol,
    status: "real NSE daily data",
    mode: "nse-udiff-bhavcopy",
    date: row.date,

    price: row.last ?? row.close,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    previousClose: row.previousClose,

    volume: row.volume,
    turnover: row.turnover,
    trades: row.trades,

    levels: calculateLevels(row),
    priceAction: priceAction(row)
  };
}

app.get("/", (req, res) => {
  res.json({
    app: "Arpit Market Scanner Backend",
    status: "online",
    mode: "NSE UDiFF daily data",
    dataStatus,
    latestDate,
    rowCount: latestData.length
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    dataStatus,
    latestDate,
    rowCount: latestData.length
  });
});

app.get("/nse/status", (req, res) => {
  res.json({
    status: dataStatus,
    latestDate,
    rowCount: latestData.length,
    lastError
  });
});

app.post("/upload-bhavcopy", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "CSV or ZIP file required"
      });
    }

    const buffer = fs.readFileSync(req.file.path);

    let csv;

    const isZip =
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b;

    if (isZip) {
      const zip = new AdmZip(buffer);

      const entry = zip
        .getEntries()
        .find(e =>
          !e.isDirectory &&
          e.entryName.toLowerCase().endsWith(".csv")
        );

      if (!entry) {
        throw new Error("CSV not found inside ZIP");
      }

      csv = entry.getData().toString("utf8");
    } else {
      csv = buffer.toString("utf8");
    }

    const count = loadCSV(csv);

    fs.unlinkSync(req.file.path);

    res.json({
      status: "success",
      message: "NSE Bhavcopy loaded",
      latestDate,
      rowCount: count
    });
  } catch (error) {
    dataStatus = "load failed";
    lastError = error.message;

    try {
      if (req.file?.path) fs.unlinkSync(req.file.path);
    } catch {}

    res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});

app.get("/stock/:symbol", (req, res) => {
  const row = findStock(req.params.symbol);

  if (!row) {
    return res.status(404).json({
      status: "not found",
      symbol: req.params.symbol,
      latestDate
    });
  }

  res.json(row);
});

app.get("/scanner/:symbol", (req, res) => {
  res.json(scanner(req.params.symbol));
});

app.get("/history/:symbol", (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const rows = latestData.filter(
    row =>
      row.symbol &&
      row.symbol.toUpperCase() === symbol &&
      row.series === "EQ"
  );

  res.json({
    symbol,
    status: rows.length ? "available" : "not found",
    mode: "nse-udiff-bhavcopy",
    rows
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
