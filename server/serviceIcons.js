// Creative roadmap, Phase 1 wave 1b — generated service icons. One image per
// service, named by the service id, no index (the file existing + the
// service's own `iconImage` timestamp field is all the state there is).
// data/service-icons/ is gitignored.
//
// A service id is slugified from its name in serviceStore.js (`[a-z0-9-]`,
// maybe with a `-<epoch>` disambiguator), so it's a safe filename — but it
// arrives from the client on these routes, so validate the shape anyway
// before it's ever joined into a path.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_ICON_DIR = path.join(__dirname, 'data', 'service-icons');

export function isValidServiceId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
}

export function serviceIconPath(id) {
  if (!isValidServiceId(id)) return null;
  return path.join(SERVICE_ICON_DIR, `${id}.png`);
}

export async function saveServiceIcon(id, buffer) {
  const target = serviceIconPath(id);
  if (!target) throw new Error('invalid service id');
  await fs.mkdir(SERVICE_ICON_DIR, { recursive: true });
  await fs.writeFile(target, buffer);
  return target;
}

// Best-effort — called when an icon is cleared and when its whole service is
// deleted (routes/services.js), so a missing file is a non-error.
export async function deleteServiceIcon(id) {
  const target = serviceIconPath(id);
  if (!target) return;
  await fs.unlink(target).catch(() => {});
}
