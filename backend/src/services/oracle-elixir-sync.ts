import * as path from 'path';
import * as fs from 'fs';
import { downloadDriveFileMedia, downloadDriveFilePublicUc } from './google-drive-export';
import { importOracleElixirFile } from './oracle-elixir-import';

export const ORACLE_ELIXIR_2026_FILENAME = '2026_LoL_esports_match_data_from_OraclesElixir.csv';

/** Публичный CSV 2026 в этой папке (имя фиксированное). Если Oracle перезальёт файл новым id — задай ORACLE_ELIXIR_2026_DRIVE_FILE_ID. */
export const DEFAULT_ORACLE_ELIXIR_2026_FILE_ID = '1hnpbrUpBMS1TZI7IovfpKeZfWJH1Aptm';

function dataDir(): string {
  return path.join(process.cwd(), 'data', 'oracle-elixir');
}

export function getOracleElixir2026DownloadPath(): string {
  return path.join(dataDir(), ORACLE_ELIXIR_2026_FILENAME);
}

/**
 * Download 2026 CSV from Google Drive, then import into DB.
 * Без настроек: публичная ссылка `uc?export=download` и зашитый file id (см. DEFAULT_ORACLE_ELIXIR_2026_FILE_ID).
 * Опционально: GOOGLE_DRIVE_API_KEY — скачивание через alt=media (если uc начнёт капризничать).
 * Переопределить id: ORACLE_ELIXIR_2026_DRIVE_FILE_ID (если в Drive появится новый файл с тем же именем).
 */
export async function syncOracleElixir2026FromDrive(): Promise<{
  ok: boolean;
  destPath: string;
  fileId?: string;
  importResult?: { imported: number; skipped: number; errors: number };
  error?: string;
}> {
  const destPath = getOracleElixir2026DownloadPath();
  const apiKey = process.env.GOOGLE_DRIVE_API_KEY?.trim();
  const fileId =
    process.env.ORACLE_ELIXIR_2026_DRIVE_FILE_ID?.trim() || DEFAULT_ORACLE_ELIXIR_2026_FILE_ID;

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (apiKey) {
      await downloadDriveFileMedia(fileId, apiKey, destPath);
    } else {
      await downloadDriveFilePublicUc(fileId, destPath);
    }

    const importResult = await importOracleElixirFile(destPath);
    const ok = importResult.errors === 0 || importResult.imported > 0;
    return { ok, destPath, fileId, importResult };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, destPath, fileId: fileId ?? undefined, error: msg };
  }
}
