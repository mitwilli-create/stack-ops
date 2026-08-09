import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    ...receipt,
  })}\n`);
}
