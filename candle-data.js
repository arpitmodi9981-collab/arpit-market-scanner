// Arpit Market Scanner
// Candle Data Adapter
// Educational / informational use only

(function () {
  function normalizeCandle(candle) {
    if (!candle || typeof candle !== "object") {
      return null;
    }

    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume || 0);

    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      return null;
    }

    return {
      time:
        candle.time ??
        candle.timestamp ??
        candle.datetime ??
        null,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0
    };
  }

  function normalizeCandles(candles) {
    if (!Array.isArray(candles)) {
      return [];
    }

    return candles
      .map(normalizeCandle)
      .filter(Boolean)
      .sort((a, b) => {
        if (a.time == null || b.time == null) {
          return 0;
        }

        return String(a.time).localeCompare(String(b.time));
      });
  }

  function parseJson(text) {
    const data = JSON.parse(text);

    if (Array.isArray(data)) {
      return normalizeCandles(data);
    }

    if (Array.isArray(data.candles)) {
      return normalizeCandles(data.candles);
    }

    return [];
  }

  function parseCsv(text) {
    const lines = text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);

    if (lines.length < 2) {
      return [];
    }

    const headers = lines[0]
      .split(",")
      .map((x) => x.trim().toLowerCase());

    const findHeader = (...names) => {
      for (const name of names) {
        const index = headers.indexOf(name);
        if (index !== -1) {
          return index;
        }
      }
      return -1;
    };

    const timeIndex = findHeader(
      "time",
      "timestamp",
      "datetime",
      "date"
    );

    const openIndex = findHeader("open", "opn");
    const highIndex = findHeader("high", "hgh");
    const lowIndex = findHeader("low", "lwe");
    const closeIndex = findHeader("close", "cls");
    const volumeIndex = findHeader(
      "volume",
      "vol",
      "ttltrdgv"
    );

    if (
      openIndex === -1 ||
      highIndex === -1 ||
      lowIndex === -1 ||
      closeIndex === -1
    ) {
      return [];
    }

    const candles = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(",");

      const candle = normalizeCandle({
        time:
          timeIndex >= 0
            ? values[timeIndex]
            : null,

        open: values[openIndex],
        high: values[highIndex],
        low: values[lowIndex],
        close: values[closeIndex],

        volume:
          volumeIndex >= 0
            ? values[volumeIndex]
            : 0
      });

      if (candle) {
        candles.push(candle);
      }
    }

    return normalizeCandles(candles);
  }

  async function readFile(file) {
    if (!file) {
      return {
        status: "error",
        message: "No file selected.",
        candles: []
      };
    }

    const text = await file.text();

    try {
      const lowerName = file.name.toLowerCase();

      const candles =
        lowerName.endsWith(".json")
          ? parseJson(text)
          : parseCsv(text);

      return {
        status: candles.length
          ? "ok"
          : "no_data",
        source: "user-file",
        fileName: file.name,
        count: candles.length,
        candles
      };
    } catch (error) {
      return {
        status: "error",
        source: "user-file",
        fileName: file.name,
        count: 0,
        candles: [],
        message: error.message
      };
    }
  }

  window.CandleData = {
    normalizeCandle,
    normalizeCandles,
    parseJson,
    parseCsv,
    readFile
  };
})();
