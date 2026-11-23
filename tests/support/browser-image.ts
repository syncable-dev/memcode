import type { BrowserImage } from "../../src/browser";

const PNG_WIDTH_OFFSET = 16;
const JPEG_FIRST_SEGMENT = 2;
const isJpegFrameHeader = (marker: number) => marker >= 0xc0 && marker <= 0xc3;

/** The encoded image's size in device pixels, read from its PNG or JPEG header. */
export function pixelSize(image: BrowserImage): {
  width: number;
  height: number;
} {
  const bytes = Buffer.from(image.data, "base64");
  if (image.mimeType === "image/png")
    return {
      width: bytes.readUInt32BE(PNG_WIDTH_OFFSET),
      height: bytes.readUInt32BE(PNG_WIDTH_OFFSET + 4),
    };
  for (let offset = JPEG_FIRST_SEGMENT; offset < bytes.length;) {
    const marker = bytes[offset + 1];
    if (isJpegFrameHeader(marker))
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw Error("The JPEG has no frame header.");
}
