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

    breakout:
      "Needs intraday candles",

    retest:
      "Needs intraday candles",

    falseBreakout:
      "Needs intraday candles"
  };
}
