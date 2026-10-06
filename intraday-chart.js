function renderIntradayChart(candles = []) {
  const host = document.getElementById("chart");

  if (!host) return;

  if (!Array.isArray(candles) || candles.length < 2) {
    host.textContent = "Not enough candles for chart.";
    return;
  }

  const data = candles.slice(-60);
  const width = 760;
  const height = 300;
  const pad = { top: 18, right: 18, bottom: 42, left: 58 };

  const highs = data.map(c => Number(c.high));
  const lows = data.map(c => Number(c.low));

  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;

  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const step = innerW / data.length;
  const bodyW = Math.max(3, Math.min(10, step * 0.58));

  const y = price =>
    pad.top + ((max - price) / range) * innerH;

  const x = i =>
    pad.left + step * i + step / 2;

  const escape = value =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  const lines = [];

  for (let i = 0; i <= 4; i++) {
    const py = pad.top + (innerH * i / 4);
    const price = max - range * i / 4;

    lines.push(
      '<line x1="' + pad.left +
      '" y1="' + py +
      '" x2="' + (width - pad.right) +
      '" y2="' + py +
      '" stroke="#27313d" stroke-width="1"/>'
    );

    lines.push(
      '<text x="' + (pad.left - 8) +
      '" y="' + (py + 4) +
      '" text-anchor="end" fill="#8f9ba8" font-size="11">' +
      escape(price.toFixed(2)) +
      "</text>"
    );
  }

  const candlesSvg = data.map((c, i) => {
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);

    const bullish = close >= open;

    const bodyTop =
      y(Math.max(open, close));

    const bodyBottom =
      y(Math.min(open, close));

    const bodyHeight =
      Math.max(2, bodyBottom - bodyTop);

    const cx = x(i);

    const color =
      bullish ? "#62d391" : "#ff7272";

    return (
      '<line x1="' + cx +
      '" y1="' + y(high) +
      '" x2="' + cx +
      '" y2="' + y(low) +
      '" stroke="' + color +
      '" stroke-width="1.5"/>' +

      '<rect x="' +
      (cx - bodyW / 2) +
      '" y="' + bodyTop +
      '" width="' + bodyW +
      '" height="' + bodyHeight +
      '" rx="1" fill="' + color +
      '"/>'
    );
  }).join("");

  const labels = data.map((c, i) => {
    if (
      i % Math.max(
        1,
        Math.floor(data.length / 6)
      ) !== 0
    ) {
      return "";
    }

    const label =
      c.time == null
        ? ""
        : String(c.time)
            .replace("T", " ")
            .slice(0, 16);

    return (
      '<text x="' + x(i) +
      '" y="' + (height - 12) +
      '" text-anchor="middle" ' +
      'fill="#8f9ba8" font-size="10">' +
      escape(label) +
      "</text>"
    );
  }).join("");

  host.innerHTML =
    '<svg viewBox="0 0 ' +
    width + ' ' + height +
    '" width="100%" height="300" ' +
    'role="img" ' +
    'aria-label="Intraday candlestick chart">' +

    '<rect x="0" y="0" width="' +
    width + '" height="' +
    height +
    '" fill="#0d131b" rx="10"/>' +

    lines.join("") +
    candlesSvg +
    labels +

    "</svg>" +

    '<div class="status" style="margin-top:8px">' +
    "Showing last " +
    data.length +
    " candles from the loaded OHLC data." +
    "</div>";
}

window.IntradayChart = {
  renderIntradayChart
};
