import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readAccessCode() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = process.env.STUDENT_INBOX_DATA_DIR || join(process.env.LOCALAPPDATA || join(root, 'data'), 'StudentInbox');
  return (await readFile(join(directory, 'access.token'), 'utf8')).trim();
}
