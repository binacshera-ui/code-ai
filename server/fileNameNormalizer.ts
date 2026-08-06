import path from 'node:path';

const INVISIBLE_UNICODE_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/gu;
const DISALLOWED_CHAR_PATTERN = /[<>:/\\|?*\u0000-\u001f]/gu;
const COLLAPSIBLE_SEPARATOR_PATTERN = /[ _.-]{2,}/gu;
const MAX_FILE_NAME_LENGTH = 180;
const MAX_EXTENSION_LENGTH = 40;

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
