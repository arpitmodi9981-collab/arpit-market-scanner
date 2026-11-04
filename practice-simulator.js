// Arpit Market Scanner — educational practice module
// Synthetic candles only. No broker connection, live feed, or trade calls.
const INDEXES = ["NIFTY", "BANKNIFTY", "SENSEX"];

function makePracticeSession(index = "NIFTY") {
  if (!INDEXES.includes(index)) throw new Error("Unsupported index");
  const previousDay = { open: 100, high: 112, low: 94, close: 106 };
  const candles = [
    { time: "09:15", open: 106, high: 108, low: 104, close: 107 },
    { time: "09:30", open: 107, high: 111, low: 106, close: 110 },
    { time: "09:45", open: 110, high: 114, low: 109, close: 111 },
    { time: "10:00", open: 111, high: 113, low: 108, close: 109 },
    { time: "10:15", open: 109, high: 110, low: 105, close: 106 }
  ];
  return {
    index, previousDay,
    levels: { PDH: previousDay.high, PDL: previousDay.low },
    candles,
    lesson: "Study how candle closes relate to the previous day's high and low. Synthetic learning example only."
  };
}

function explainCandle(candle, levels) {
  if (!candle || !levels) throw new Error("Candle and levels are required");
  const closeAbove = candle.close > levels.PDH;
  const closeBelow = candle.close < levels.PDL;
  const sweptHigh = candle.high > levels.PDH && !closeAbove;
  const sweptLow = candle.low < levels.PDL && !closeBelow;
  return {
    closeLocation: closeAbove ? "Above previous-day high" :
      closeBelow ? "Below previous-day low" : "Between previous-day levels",
    concepts: [
      ...(sweptHigh ? ["Price moved above PDH but closed back below: an example of rejection."] : []),
      ...(sweptLow ? ["Price moved below PDL but closed back above: an example of rejection."] : []),
      ...(!sweptHigh && !sweptLow ? ["Compare the candle body and wick with the marked levels."] : [])
    ],
    educationalOnly: true
  };
}

module.exports = { INDEXES, makePracticeSession, explainCandle };
