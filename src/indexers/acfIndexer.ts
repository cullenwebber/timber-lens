import { AcfFieldGroup } from '../models/acf';
import { parseAcfJson } from '../parsers/acfJsonParser';
import { AcfIndex } from '../services/acfResolver';

/** Build an AcfIndex from the raw contents of every ACF JSON file. */
export function buildAcfIndex(contents: string[]): AcfIndex {
  const groups: AcfFieldGroup[] = [];
  for (const raw of contents) {
    groups.push(...parseAcfJson(raw));
  }
  return new AcfIndex(groups);
}
