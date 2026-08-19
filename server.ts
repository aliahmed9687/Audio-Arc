import express from 'express';
import path from 'path';
import fs from 'fs';
import * as archiverModule from 'archiver';
const archiver: any = (archiverModule as any).default || archiverModule;
import { createServer as createViteServer } from 'vite';
import {
  getVideoMetadata,
  convertToMp3,
  conversionsCache,
  ensureYtDlp,
  extractVideoId,
  formatBytes,
  sanitizeFilename,
  hasCustomCookies,
  saveCustomCookies,
  clearCustomCookies,
} from './server/downloader.ts';

const PORT = parseInt(process.env.PORT || '3000', 10);

async function startServer() {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Ensure yt-dlp binary is primed in the background
  ensureYtDlp().catch((err) => console.error('Error pre-warming yt-dlp:', err));

  // 1. Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 2. Fetch video metadata
  app.get('/api/info', async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: 'Missing "url" query parameter.' });
      }

      const videoId = extractVideoId(url);
      if (!videoId) {
        return res.status(400).json({
          error: 'Invalid YouTube link format. Please provide a standard YouTube video link or Shorts URL.',
        });
      }

      const info = await getVideoMetadata(url);
      return res.json({ success: true, data: info });
    } catch (err: any) {
      console.error('Error fetching video metadata:', err);
      return res.status(500).json({
        error: err.message || 'Failed to fetch video details from YouTube.',
      });
    }
  });

  // 3. Convert video to MP3
  app.post('/api/convert', async (req, res) => {
    try {
      const { url, bitrate = '256', trimStart, trimEnd, customTitle, customArtist } = req.body;

      if (!url) {
        return res.status(400).json({ error: 'Missing "url" in request body.' });
      }

      const videoId = extractVideoId(url);
      if (!videoId) {
        return res.status(400).json({ error: 'Invalid YouTube link.' });
      }

      // Allowed bitrates
      const validBitrates = ['128', '192', '256', '320'];
      const chosenBitrate = validBitrates.includes(String(bitrate)) ? String(bitrate) : '256';

      console.log(`Starting conversion for URL: ${url} at ${chosenBitrate} kbps`);

      const result = await convertToMp3({
        url,
        bitrate: chosenBitrate as any,
        trimStart: trimStart?.trim() || undefined,
        trimEnd: trimEnd?.trim() || undefined,
        customTitle: customTitle?.trim() || undefined,
        customArtist: customArtist?.trim() || undefined,
      });

      return res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('Conversion endpoint error:', err);
      return res.status(500).json({
        error: err.message || 'An error occurred during audio conversion.',
      });
    }
  });

  // 4. Download converted MP3 file with support for custom title & artist
  app.get('/api/download/:id', (req, res) => {
    const fileId = req.params.id;
    const item = conversionsCache.get(fileId);

    const downloadsDir = path.join(process.cwd(), 'downloads');
    const filePath = item?.filePath || path.join(downloadsDir, `${fileId}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File expired or not found. Please convert again.' });
    }

    const titleOverride = (req.query.title as string)?.trim();
    const artistOverride = (req.query.artist as string)?.trim();
    let filename = item?.fileName || `${fileId}.mp3`;
    if (titleOverride || artistOverride) {
      const cleanT = titleOverride || item?.title || 'Track';
      const cleanA = artistOverride || item?.artist || 'Artist';
      filename = sanitizeFilename(`${cleanT} - ${cleanA}`) + '.mp3';
    }

    const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, escape);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/"/g, '')}"; filename*=UTF-8''${encodedFilename}`
    );

    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  });

  // 4b. Update ID3 info in memory cache for completed track
  app.post('/api/update-tags', (req, res) => {
    const { id, title, artist } = req.body;
    if (!id) return res.status(400).json({ error: 'Missing track id' });
    const item = conversionsCache.get(id);
    if (item) {
      if (title) item.title = String(title).trim();
      if (artist) item.artist = String(artist).trim();
      item.fileName = sanitizeFilename(`${item.title} - ${item.artist}`) + '.mp3';
      conversionsCache.set(id, item);
      return res.json({ success: true, data: item });
    }
    return res.json({ success: true, data: { id, title, artist } });
  });

  // 5. In-browser audio streaming with HTTP 206 Partial Content range support
  app.get('/api/stream/:id', (req, res) => {
    const fileId = req.params.id;
    const item = conversionsCache.get(fileId);

    const downloadsDir = path.join(process.cwd(), 'downloads');
    const filePath = item?.filePath || path.join(downloadsDir, `${fileId}.mp3`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Audio file not found.' });
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const partialStart = parts[0];
      const partialEnd = parts[1];

      const start = parseInt(partialStart, 10);
      const end = partialEnd ? parseInt(partialEnd, 10) : total - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'audio/mpeg',
      });

      const stream = fs.createReadStream(filePath, { start, end });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': total,
        'Content-Type': 'audio/mpeg',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });

  // 6. Conversion history
  app.get('/api/history', (req, res) => {
    const list = Array.from(conversionsCache.values()).reverse();
    res.json({ success: true, data: list });
  });

  // 7. Delete from history
  app.delete('/api/history/:id', (req, res) => {
    const fileId = req.params.id;
    const item = conversionsCache.get(fileId);
    if (item && fs.existsSync(item.filePath)) {
      try {
        fs.unlinkSync(item.filePath);
      } catch (err) {
        console.error('Error unlinking file:', err);
      }
    }
    conversionsCache.delete(fileId);
    res.json({ success: true });
  });

  // 8. Batch Download as ZIP
  app.post('/api/batch-zip', (req, res) => {
    try {
      const { ids, title = 'AudioArc-Batch' } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No files specified for batch download.' });
      }

      const downloadsDir = path.join(process.cwd(), 'downloads');
      const validFiles: { filePath: string; fileName: string }[] = [];

      for (const id of ids) {
        const item = conversionsCache.get(id);
        const candidatePath = item?.filePath || path.join(downloadsDir, `${id}.mp3`);
        if (fs.existsSync(candidatePath)) {
          validFiles.push({
            filePath: candidatePath,
            fileName: item?.fileName || `${id}.mp3`,
          });
        }
      }

      if (validFiles.length === 0) {
        return res.status(404).json({ error: 'None of the requested files were found on the server.' });
      }

      const zipFilename = `${title}-${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => {
        console.error('Archive generation error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to generate ZIP archive.' });
        }
      });

      archive.pipe(res);

      for (const f of validFiles) {
        archive.file(f.filePath, { name: f.fileName });
      }

      archive.finalize();
    } catch (err: any) {
      console.error('Batch ZIP endpoint error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Internal server error while building ZIP.' });
      }
    }
  });

  // 9. Cookie management for restricted YouTube tracks
  app.get('/api/cookies', (req, res) => {
    res.json({ success: true, hasCookies: hasCustomCookies() });
  });

  app.post('/api/cookies', (req, res) => {
    const { cookies } = req.body;
    if (!cookies || typeof cookies !== 'string' || cookies.trim().length < 10) {
      return res.status(400).json({ error: 'Please provide valid Netscape or cookies.txt text.' });
    }
    const success = saveCustomCookies(cookies);
    if (success) {
      res.json({ success: true, message: 'YouTube cookies saved successfully.' });
    } else {
      res.status(500).json({ error: 'Failed to save cookies to server.' });
    }
  });

  app.delete('/api/cookies', (req, res) => {
    clearCustomCookies();
    res.json({ success: true, message: 'YouTube cookies removed.' });
  });

  // Vite middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
