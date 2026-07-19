/**
 * Provision the Google Sheet control surface: creates the six tabs, writes the
 * header rows, adds the Status dropdown, and freezes the header. Requires:
 *   SHEET_STORE=google, GOOGLE_SHEETS_SPREADSHEET_ID, and a service account
 *   (GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON) with edit
 *   access to the spreadsheet.
 *
 * Usage: node scripts/provision-sheet.ts
 */
import { buildContainer } from '../src/boot/container.ts';
import { logger } from '../src/shared/logger.ts';

async function main(): Promise<void> {
  const c = buildContainer();
  if (c.sheet.kind !== 'google') {
    logger.warn(
      'SHEET_STORE is not "google" — nothing to provision. Set SHEET_STORE=google, GOOGLE_SHEETS_SPREADSHEET_ID, and a service account, then re-run.',
    );
    c.close();
    return;
  }
  logger.info('provisioning Google Sheet…', { spreadsheetId: c.config.sheets.spreadsheetId });
  await c.sheet.init(); // ensureSchema(): tabs + headers + Status dropdown + frozen header row
  logger.info('Google Sheet provisioned successfully. Add products with Status=NEW to begin.');
  c.close();
}

main().catch((e) => {
  logger.error('provision-sheet failed', { error: (e as Error).message });
  process.exit(1);
});
