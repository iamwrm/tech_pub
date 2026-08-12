import { stripVTControlCharacters } from "node:util";

/**
 * Convert model/provider text into inert terminal text for string widgets.
 * Keep printable Unicode, tabs, and newlines; remove VT sequences, C0/C1
 * controls, carriage returns, and lone surrogate halves.
 */
export function sanitizeDisplayText(input: string): string {
  const stripped = stripVTControlCharacters(input)
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufff9-\ufffb]/g, "");

  let output = "";
  for (let index = 0; index < stripped.length; index++) {
    const code = stripped.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = stripped.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += stripped.slice(index, index + 2);
        index++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    output += stripped[index];
  }
  return output;
}
