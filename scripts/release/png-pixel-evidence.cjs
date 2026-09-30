const { createHash } = require("node:crypto");
const { inflateSync } = require("node:zlib");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MIN_MATCHING_PIXELS = 16;

function inspectScreenshotPixels(imageBase64, expectedColors) {
  if (typeof imageBase64 !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    throw new Error("capture_screenshot_image_missing");
  }
  const png = Buffer.from(imageBase64, "base64");
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("capture_screenshot_image_not_png");
  }

  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    if (offset + 12 > png.length) throw new Error("capture_screenshot_png_truncated");
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) throw new Error("capture_screenshot_png_truncated");
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) throw new Error("capture_screenshot_png_invalid_header");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("capture_screenshot_png_interlaced_unsupported");
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = end;
  }

  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 67_108_864) {
    throw new Error("capture_screenshot_png_dimensions_invalid");
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || compressed.length === 0) {
    throw new Error("capture_screenshot_png_format_unsupported");
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: height * (rowBytes + 1) });
  if (raw.length !== height * (rowBytes + 1)) throw new Error("capture_screenshot_png_pixel_data_invalid");
  let previous = Buffer.alloc(rowBytes);
  const counts = new Map();
  let rawOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const current = Buffer.alloc(rowBytes);
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? current[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
          : filter === 2 ? up
            : filter === 3 ? Math.floor((left + up) / 2)
              : filter === 4 ? paeth(left, up, upLeft)
                : null;
      if (predictor === null) throw new Error(`capture_screenshot_png_filter_unsupported:${filter}`);
      current[x] = (raw[rawOffset + x] + predictor) & 0xff;
    }
    rawOffset += rowBytes;
    for (let x = 0; x < rowBytes; x += bytesPerPixel) {
      if (colorType !== 6 || current[x + 3] >= 250) {
        const rgb = current.subarray(x, x + 3).toString("hex");
        counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
      }
    }
    previous = current;
  }

  const required = [...new Set(expectedColors.map(normalizeRgb))].sort();
  const missing = required.filter((rgb) => (counts.get(rgb) ?? 0) < MIN_MATCHING_PIXELS);
  if (missing.length > 0) {
    throw new Error(`capture_screenshot_expected_pixels_missing:${missing.join(",")}`);
  }
  return {
    height,
    matchedRgbHex: required,
    pngBytes: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    width,
  };
}

function normalizeRgb(value) {
  const rgb = String(value).replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(rgb)) throw new Error("capture_screenshot_expected_rgb_invalid");
  return rgb;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

module.exports = { inspectScreenshotPixels };
