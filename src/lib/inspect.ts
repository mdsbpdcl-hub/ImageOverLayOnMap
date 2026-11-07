import { cleanHeaders, parseSample } from '../engine/csv';
import type { Encoding } from '../engine/types';

/** Re-reads only the heading row (first 256 KB) using a user-chosen delimiter/encoding. */
export async function inspectWith(file: File, delimiter: string, encoding: Encoding) {
  const head = await file.slice(0, 256 * 1024).arrayBuffer();
  const text = new TextDecoder(encoding).decode(head, { stream: true });
  const rows = parseSample(text, delimiter, 1);
  const rawHeaders = rows[0] ?? [];
  const { headers, warnings } = cleanHeaders(rawHeaders);
  if (headers.length === 1) warnings.push('Only one column detected: check the delimiter.');
  return { rawHeaders, headers, warnings };
}
