const express = require("express");
const https = require("https");
const zlib = require("zlib");
const AdmZip = require("adm-zip");

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

/* =========================
   NSE OFFICIAL REPORT
========================= */

const NSE_REPORT_PAGE =
  "https://www.nseindia.com/all-reports";

let latestData = [];
let latestDate = null;
let dataStatus = "not loaded";
let lastError = null;

/* =========================
   DOWNLOAD HELPER
========================= */

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      return reject(new Error("Too many redirects"));
    }

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
          "Accept":
            "application/zip,text/csv,*/*",
          "Accept-Language":
            "en-US,en;q=0.9",
          "Referer":
            "https://www.nseindia.com/"
        }
      },
      res => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return download(
            res.headers.location,
            redirects + 1
          ).then(resolve).catch(reject);
        }

        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `NSE returned HTTP ${res.statusCode}`
            )
          );
        }

        const chunks = [];

        res.on("data", chunk => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          resolve(
            Buffer.concat(chunks)
          );
        });
      }
    );

    req.on("error", reject);

    req.setTimeout(30000, () => {
      req.destroy(
        new Error("NSE request timeout")
      );
    });
  });
}

/* =========================
   CSV PARSER
========================= */

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (
        insideQuotes &&
        line[i + 1] === '"'
      ) {
        current += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (
      ch === "," &&
      !insideQuotes
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
      .filter(Boolean);

  if (!lines.length) {
    return [];
  }

  const headers =
    parseCSVLine(lines[0]);

  const rows = [];

  for (
    let i = 1;
    i < lines.length;
    i++
  ) {
    const values =
      parseCSVLine(lines[i]);

    const row = {};

    headers.forEach(
      (header, index) => {
        row[header] =
          values[index] ?? "";
      }
    );

    rows.push(row);
  }

  return rows;
}

/* =========================
   NUMBER HELPER
========================= */

function num(value) {
  const n =
    Number(
      String(value ?? "")
        .replace(/,/g, "")
        .trim()
    );

  return Number.isFinite(n)
    ? n
    : null;
}

/* =========================
   NORMALIZE UDIFF
========================= */

function normalizeRow(row) {
  return {
    date:
      row.TradDt || null,

    symbol:
      row.TckrSymb || null,

    series:
      row.SctySrs || null,

    name:
      row.FininstrmNm || null,

    open:
      num(row.OpnPric),

    high:
      num(row.HghPric),

    low:
      num(row.LwPric),

    close:
      num(row.ClsPric),

    last:
      num(row.LastPric),

    previousClose:
      num(row.PrvsClsgPric),

    volume:
      num(row.TtlTradgVol),

    turnover:
      num(row.TtlTrfVal),

    trades:
      num(row.TtlNbOfTxsExctd)
  };
}

/* =========================
   FIND CSV INSIDE ZIP
========================= */

function extractCSV(buffer) {
  const zip =
    new AdmZip(buffer);

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
      "CSV not found inside NSE ZIP"
    );
  }

  return csvEntry
    .getData()
    .toString("utf8");
}

/* =========================
   LOAD NSE FILE
========================= */

async function loadNSEFile(url) {
  try {
    dataStatus = "loading";
    lastError = null;

    const buffer =
      await download(url);

    let csv;

    const isZip =
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b;

    if (isZip) {
      csv =
        extractCSV(buffer);
    } else {
      csv =
        buffer.toString("utf8");
    }

    const rows =
      csvToObjects(csv);

    const normalized =
      rows
        .map(normalizeRow)
        .filter(
          row =>
            row.symbol &&
            row.open !== null &&
            row.high !== null &&
            row.low !== null &&
            row.close !== null
        );

    latestData =
      normalized;

    latestDate =
      normalized.length
        ? normalized[0].date
        : null;

    dataStatus =
      "loaded";

    console.log(
      `NSE data loaded: ${normalized.length} rows`
    );

    return normalized;

  } catch (error) {
    dataStatus =
      "error";

    lastError =
      error.message;

    console.error(
      "NSE data error:",
      error.message
    );

    return [];
  }
}

/* =========================
   DEMO FALLBACK
========================= */

const demoMarket = {
  NIFTY: 25480,
  BANKNIFTY: 52320,
  "MCX CRUDE OIL": 9845
};

/* =========================
   STOCK LOOKUP
========================= */

function findStock(symbol) {
  return latestData.find(
    row =>
      row.symbol === symbol &&
      row.series === "EQ"
  );
}

/* =========================
   LEVELS
========================= */

function calculateLevels(row) {
  if (!row) {
    return null;
  }

  const resistance =
    row.high;

  const support =
    row.low;

  const range =
    resistance - support;

  let strength =
    "WEAK";

  if (range > 0) {
    const volume =
      row.volume || 0;

    if (volume >= 1000000) {
      strength =
        "STRONG";
    } else if (
      volume >= 100000
    ) {
      strength =
        "MEDIUM";
    }
  }

  return {
    resistance,
    support,
    strength,
    range
  };
}

/* =========================
   DAILY PRICE ACTION
========================= */

function dailyPriceAction(row) {
  if (!row) {
    return {
      structure: "No data",
      breakout: "No data",
      retest: "Not available",
      falseBreakout: "Not available"
    };
  }

  let structure =
    "Neutral";

  if (
    row.close >
    row.open
  ) {
    structure =
      "Bullish";
  } else if (
    row.close <
    row.open
  ) {
    structure =
      "Bearish";
  }

  return {
    structure,

    breakout:
      row.close > row.high
        ? "Breakout"
        : "Waiting for next session",

    retest:
      "Needs next-session data",

    falseBreakout:
      "Needs next-session data"
  };
}

/* =========================
   SCANNER
========================= */

function scanner(symbol) {
  const row =
    findStock(symbol);

  if (!row) {
    return {
      symbol,
      status: "No NSE equity row found",
      mode: "nse-bhavcopy",
      note:
        "This daily CM Bhavcopy contains equity securities. Index/derivative intraday data requires a separate source."
    };
  }

  const levels =
    calculateLevels(row);

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

    levels,

    priceAction:
      dailyPriceAction(row)
  };
}

/* =========================
   ROOT
========================= */

app.get(
  "/",
  (req, res) => {
    res.json({
      app:
        "Arpit Market Scanner Backend",

      status:
        "online",

      dataSource:
        "NSE CM-UDiFF Common Bhavcopy",

      dataStatus,

      latestDate,

      rowCount:
        latestData.length,

      message:
        "NSE daily data engine ready"
    });
  }
);

/* =========================
   HEALTH
========================= */

app.get(
  "/health",
  (req, res) => {
    res.json({
      status:
        "ok",

      dataSource:
        "NSE UDiFF Bhavcopy",

      dataStatus,

      latestDate,

      rowCount:
        latestData.length,

      lastError
    });
  }
);

/* =========================
   NSE DATA STATUS
========================= */

app.get(
  "/nse/status",
  (req, res) => {
    res.json({
      status:
        dataStatus,

      source:
        "NSE CM-UDiFF Common Bhavcopy",

      latestDate,

      rowCount:
        latestData.length,

      lastError
    });
  }
);

/* =========================
   STOCK
========================= */

app.get(
  "/stock/:symbol",
  (req, res) => {
    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    const row =
      findStock(symbol);

    if (!row) {
      return res
        .status(404)
        .json({
          error:
            "Stock not found in latest NSE Bhavcopy",
          symbol
        });
    }

    res.json(row);
  }
);

/* =========================
   SCANNER
========================= */

app.get(
  "/scanner/:symbol",
  (req, res) => {
    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    res.json(
      scanner(symbol)
    );
  }
);

/* =========================
   HISTORY
========================= */

app.get(
  "/history/:symbol",
  (req, res) => {
    const symbol =
      decodeURIComponent(
        req.params.symbol
      ).toUpperCase();

    const rows =
      latestData.filter(
        row =>
          row.symbol === symbol &&
          row.series === "EQ"
      );

    res.json({
      symbol,

      source:
        "NSE CM-UDiFF Common Bhavcopy",

      latestDate,

      count:
        rows.length,

      history:
        rows
    });
  }
);

/* =========================
   START
========================= */

app.listen(
  PORT,
  async () => {
    console.log(
      `Server running on port ${PORT}`
    );

    /*
      Current official NSE report URLs
      can change. For the first test,
      set NSE_BHAVCOPY_URL in Render
      environment variables to the exact
      official ZIP URL you downloaded.
    */

    const url =
      process.env.NSE_BHAVCOPY_URL;

    if (!url) {
      dataStatus =
        "waiting for NSE_BHAVCOPY_URL";

      console.log(
        "Set NSE_BHAVCOPY_URL in Render Environment."
      );

      return;
    }

    await loadNSEFile(url);
  }
);
