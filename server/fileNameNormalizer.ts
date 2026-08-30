import path from 'node:path';
import { TextDecoder } from 'node:util';

const INVISIBLE_UNICODE_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/gu;
const DISALLOWED_CHAR_PATTERN = /[<>:/\\|?*\u0000-\u001f]/gu;
const COLLAPSIBLE_SEPARATOR_PATTERN = /[ _.-]{2,}/gu;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_EXTENSION_LENGTH = 40;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const MOJIBAKE_MARKER_PATTERN = /[\u0080-\u009f\u00c2\u00c3\u00d0\u00d1\u00d7\u00d8\u00d9\u00f0\ufffd]/gu;

function mojibakePenalty(value: string): number {
  return [...value.matchAll(MOJIBAKE_MARKER_PATTERN)].reduce((score, match) => {
    const codePoint = match[0].codePointAt(0) || 0;
    if (codePoint === 0xfffd) return score + 100;
    if (codePoint >= 0x80 && codePoint <= 0x9f) return score + 20;
    return score + 2;
  }, 0);
}

/**
 * Browsers encode multipart filenames as UTF-8, while Busboy/Multer decodes
 * header parameters as latin1 by default. Reinterpret only strings that make
 * a lossless UTF-8 round trip and whose mojibake score actually improves.
 */
export function decodeMultipartFileName(fileName: unknown): string {
  const original = String(fileName || '');
  if (!original || [...original].some((character) => (character.codePointAt(0) || 0) > 0xff)) {
    return original.normalize('NFC');
  }

  try {
    const latin1Bytes = Buffer.from(original, 'latin1');
    const decoded = UTF8_DECODER.decode(latin1Bytes);
    const roundTrip = Buffer.from(decoded, 'utf8');
    if (!roundTrip.equals(latin1Bytes) || mojibakePenalty(decoded) >= mojibakePenalty(original)) {
      return original.normalize('NFC');
    }
    return decoded.normalize('NFC');
  } catch {
    return original.normalize('NFC');
  }
}

function normalizeText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(INVISIBLE_UNICODE_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, ' ')
    .replace(DISALLOWED_CHAR_PATTERN, ' ')
    .replace(/(^|\s)["']+(?=\s|$)/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function collapseStemSeparators(value: unknown): string {
  return String(value || '')
    .replace(COLLAPSIBLE_SEPARATOR_PATTERN, (match) => (
      match.includes('_') ? '_' : match.includes('.') ? '.' : match.includes('-') ? '-' : ' '
    ))
    .replace(/^[ ._-]+|[ ._-]+$/gu, '')
    .trim();
}

function splitFileNameParts(fileName: unknown): { stem: string; extension: string } {
  const normalized = normalizeText(fileName);
  const parsed = path.parse(normalized);
  const rawExtension = String(parsed.ext || '').slice(0, MAX_EXTENSION_LENGTH);
  const extension = rawExtension.replace(/[ .]+$/gu, '');
  const stemSource = extension ? parsed.name : normalized;
  return {
    stem: collapseStemSeparators(stemSource),
    extension: collapseStemSeparators(extension).replace(/\s+/gu, ''),
  };
}

function buildTrimmedFileName(stem: string, extension: string, suffix = ''): string {
  const normalizedExtension = extension.startsWith('.') || !extension ? extension : `.${extension}`;
  const reserved = suffix.length + normalizedExtension.length;
  const availableStemLength = Math.max(1, MAX_FILE_NAME_LENGTH - reserved);
  const trimmedStem = collapseStemSeparators(String(stem || '').slice(0, availableStemLength)) || 'attachment';
  return `${trimmedStem}${suffix}${normalizedExtension}`.slice(0, MAX_FILE_NAME_LENGTH);
}

export function normalizeCanonicalFileName(
  fileName: unknown,
  options: { fallbackName?: string } = {},
): string {
  const fallbackName = normalizeText(options.fallbackName || 'attachment') || 'attachment';
  const { stem, extension } = splitFileNameParts(fileName);
  return buildTrimmedFileName(stem || fallbackName, extension);
}

export function createCanonicalFileNameAllocator(
  seedNames: unknown[] = [],
  options: { fallbackName?: string } = {},
): (preferredName?: unknown) => string {
  const used = new Set(
    Array.isArray(seedNames)
      ? seedNames
        .map((entry) => normalizeCanonicalFileName(entry, options).toLowerCase())
        .filter(Boolean)
      : [],
  );

  return (preferredName: unknown = '') => {
    const canonical = normalizeCanonicalFileName(preferredName, options);
    if (!used.has(canonical.toLowerCase())) {
      used.add(canonical.toLowerCase());
      return canonical;
    }

    const { stem, extension } = splitFileNameParts(canonical);
    let counter = 1;
    while (counter < 10_000) {
      const candidate = buildTrimmedFileName(stem || 'attachment', extension, ` (${counter})`);
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        return candidate;
      }
      counter += 1;
    }

    const forced = buildTrimmedFileName(stem || 'attachment', extension, ` (${Date.now()})`);
    used.add(forced.toLowerCase());
    return forced;
  };
}
