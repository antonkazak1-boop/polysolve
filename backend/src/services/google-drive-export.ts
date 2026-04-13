import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/**
 * Download a publicly accessible file via Drive API v3 (needs API key with Drive API enabled).
 */
export async function downloadDriveFileMedia(fileId: string, apiKey: string, destPath: string): Promise<void> {
  const url = `${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media&key=${encodeURIComponent(apiKey)}`;
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 600_000,
    validateStatus: (s) => s === 200,
  });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(res.data));
}

/**
 * Fallback: public "uc?export=download" flow (large files need confirm token in HTML).
 */
export async function downloadDriveFilePublicUc(fileId: string, destPath: string): Promise<void> {
  const base = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  const first = await axios.get<ArrayBuffer>(base, {
    responseType: 'arraybuffer',
    maxRedirects: 5,
    timeout: 600_000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const buf = Buffer.from(first.data);
  const peek = buf.subarray(0, Math.min(8000, buf.length)).toString('utf8');
  const looksHtml = peek.includes('<html') || peek.includes('<!DOCTYPE') || peek.includes('confirm=');

  if (!looksHtml) {
    fs.writeFileSync(destPath, buf);
    return;
  }

  const html = buf.toString('utf8');
  const confirm =
    html.match(/confirm=([\w-]+)/)?.[1] ??
    html.match(/confirm%3D([\w-]+)/)?.[1];
  if (!confirm) {
    throw new Error(
      'Google Drive returned HTML without confirm token. Set GOOGLE_DRIVE_API_KEY (recommended) or ORACLE_ELIXIR_2026_DRIVE_FILE_ID with a public file.',
    );
  }

  const url2 = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=${encodeURIComponent(confirm)}`;
  const res2 = await axios.get<ArrayBuffer>(url2, {
    responseType: 'arraybuffer',
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 600_000,
  });
  fs.writeFileSync(destPath, Buffer.from(res2.data));
}
