import { AcfFieldGroup } from '../models/acf';
import { parseAcfJson } from '../parsers/acfJsonParser';
import { AcfIndex } from '../services/acfResolver';

/** Build an AcfIndex from every ACF JSON file: raw contents, or contents with their path. */
export function buildAcfIndex(contents: (string | { text: string; file: string })[]): AcfIndex {
  const groups: AcfFieldGroup[] = [];
  for (const c of contents) {
    groups.push(...(typeof c === 'string' ? parseAcfJson(c) : parseAcfJson(c.text, c.file)));
  }
  return new AcfIndex(groups);
}
