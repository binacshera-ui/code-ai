import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { RequestHandler } from 'express';
import multer from 'multer';
import { MAX_UPLOAD_FILE_BYTES, MAX_UPLOAD_FILES } from '../shared/uploadLimits.js';
import { decodeMultipartFileName, normalizeCanonicalFileName } from './fileNameNormalizer.js';

export function createCodexUploadMiddleware(uploadRoot: string): RequestHandler {
  const receive = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        fs.mkdir(uploadRoot, { recursive: true })
          .then(() => callback(null, uploadRoot))
          .catch((error) => callback(error, uploadRoot));
      },
      filename: (_req, file, callback) => {
        const originalName = decodeMultipartFileName(file.originalname);
        file.originalname = originalName;
        const safeName = normalizeCanonicalFileName(originalName, { fallbackName: 'attachment' });
        callback(null, `${Date.now()}-${randomUUID()}-${safeName}`);
      },
    }),
    // Preserve the inclusive boundary with both the locked Multer 2.2 parser
    // and newer Multer versions; verify the final file sizes below as well.
    limits: { fileSize: MAX_UPLOAD_FILE_BYTES + 1, files: MAX_UPLOAD_FILES },
  }).array('files', MAX_UPLOAD_FILES);

  // Report the actual Multer completion to the HTTP lifetime tracker, including
  // terminal error responses. A callback that never calls next() is otherwise
  // indistinguishable from an upload that is still writing after disconnect.
  return async (req, res, next) => {
    let error = await new Promise<(Error & { code?: string }) | undefined>((resolve) => receive(req, res, error => resolve(error)));
    const files = Array.isArray(req.files) ? req.files : [];
    const oversized = files.find(file => file.size > MAX_UPLOAD_FILE_BYTES);
    if (!error && oversized) {
      // Newer Multer makes its own Busboy boundary inclusive. Reject the extra
      // byte consistently and clean the same whole batch as a parser failure.
      try {
        await Promise.all(files.map(file => fs.unlink(file.path).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        })));
      } catch (cleanupError) {
        next(cleanupError);
        return;
      }
      error = new multer.MulterError('LIMIT_FILE_SIZE', oversized.fieldname);
    }
    if (!error) return next();
    // Multer removes partial uploads before this callback. Always return JSON,
    // including for malformed multipart data, so the composer can show the error.
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === 'LIMIT_FILE_SIZE';
      const tooMany = error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE';
      res.status(tooLarge ? 413 : 400).json({
        code: error.code,
        error: tooLarge ? 'הגודל המרבי לקובץ הוא 75MB.'
          : tooMany ? `ניתן להעלות עד ${MAX_UPLOAD_FILES} קבצים בבקשה אחת, בשדה files.`
            : 'בקשת העלאת הקבצים אינה תקינה.',
      });
      return;
    }
    res.status(error.code === 'ENOSPC' ? 507 : error.code ? 500 : 400).json({
      error: error.code === 'ENOSPC' ? 'אין מספיק מקום פנוי בשרת להעלאת הקבצים.'
        : 'לא ניתן להעלות את הקבצים. בדקו את החיבור ונסו שוב.',
    });
  };
}
