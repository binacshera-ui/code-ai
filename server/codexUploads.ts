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
    // Busboy rejects at the threshold itself. Add one byte to make 75 MiB
    // inclusive, matching the client validator; 75 MiB + 1 is still rejected.
    limits: { fileSize: MAX_UPLOAD_FILE_BYTES + 1, files: MAX_UPLOAD_FILES },
  }).array('files', MAX_UPLOAD_FILES);

  return (req, res, next) => {
    receive(req, res, (error) => {
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
    });
  };
}
