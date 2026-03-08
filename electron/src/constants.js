const PROTOCOL_VERSION = 1;

const CONTENT_TYPE_BITS = {
  html: 1,
  image: 2,
  pdf: 4,
  terminal: 8,
  markdown: 16
};

const SUPPORTED_CONTENT_TYPES = ['html', 'image', 'pdf', 'terminal', 'markdown'];

const CAPABILITY_BITMASK =
  CONTENT_TYPE_BITS.html |
  CONTENT_TYPE_BITS.image |
  CONTENT_TYPE_BITS.pdf |
  CONTENT_TYPE_BITS.terminal |
  CONTENT_TYPE_BITS.markdown;

const CONTENT_LIMITS = {
  htmlBytes: 256 * 1024,
  imageBytes: 10 * 1024 * 1024,
  markdownBytes: 64 * 1024,
  maxTerminalLines: 10_000,
  pdfBytes: 10 * 1024 * 1024
};

const SHORT_MARKUP_DEBOUNCE_MS = 500;
const LONG_MARKUP_DEBOUNCE_MS = 3500;

module.exports = {
  CAPABILITY_BITMASK,
  CONTENT_LIMITS,
  CONTENT_TYPE_BITS,
  LONG_MARKUP_DEBOUNCE_MS,
  PROTOCOL_VERSION,
  SHORT_MARKUP_DEBOUNCE_MS,
  SUPPORTED_CONTENT_TYPES
};
