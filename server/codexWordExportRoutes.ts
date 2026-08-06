import { Router } from 'express';
import {
  buildWordAttachmentDisposition,
  CodexWordExportError,
  exportCodexMarkdownToWord,
} from './codexWordExport.js';

const router = Router();

router.post('/word', async (req, res) => {
  try {
    const document = await exportCodexMarkdownToWord({
      markdown: req.body?.markdown,
      name: req.body?.name,
    });

    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', String(document.bytes.length));
    res.setHeader('Content-Disposition', buildWordAttachmentDisposition(document.filename));
    res.send(document.bytes);
  } catch (error: any) {
    const statusCode = error instanceof CodexWordExportError ? error.statusCode : 500;
    res.status(statusCode).json({
      error: error?.message || 'יצוא Word נכשל.',
    });
  }
});

export default router;
