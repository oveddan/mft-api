const MF64_HUES = [0, 0, 16, 60, 140, 120, 114, 96, 78, 42, 22, 0, 334, 300, 320];

function clampIndex(index) {
  return Number.isInteger(index) && index >= 0 && index <= 127 ? index : 0;
}

/** CSS preview of the persistent 7-bit hardware color index. */
export function colorCss(index, palette) {
  const value = clampIndex(index);
  if (value === 0) return "#090b10";
  if (palette === "mf64") {
    if (value <= 3) return `hsl(0 0% ${[0, 15, 50, 100][value]}%)`;
    if (value < 60) {
      const group = Math.floor(value / 4);
      const shade = value % 4;
      return `hsl(${MF64_HUES[group] ?? 0} 100% ${[74, 50, 28, 12][shade]}%)`;
    }
    return `hsl(${(value * 137.508) % 360} 72% ${38 + ((value * 17) % 35)}%)`;
  }
  if (value === 127) return "#ffffff";
  const hue = (240 - ((value - 1) * 360) / 126 + 360) % 360;
  return `hsl(${hue} 100% 50%)`;
}

export function colorLabel(index, palette) {
  return `${palette === "mf64" ? "MF64" : "Classic"} ${clampIndex(index)}`;
}

/** The indicator-ring detent is a red/blue balance, not an RGB palette entry. */
export function detentCss(index) {
  const value = clampIndex(index);
  const blue = Math.round((value / 127) * 255);
  return `rgb(${255 - blue} 0 ${blue})`;
}

export function detentLabel(index) {
  return `Red/blue ${clampIndex(index)}`;
}
