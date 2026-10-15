import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { supportedLanguages } from "../src/parse.js";
import { fixturePair, parseToCanonical } from "./kat-runner.js";

// (language, fixture basename) pairs, from upstream tests/test_kat_parsers.py.
const PARSER_FIXTURES: [string, string][] = [
  ["c", "taxonomy"],
  ["cpp", "taxonomy"],
  ["go", "taxonomy"],
  ["java", "Taxonomy"],
  ["javascript", "taxonomy"],
  ["python", "taxonomy"],
  ["rust", "taxonomy"],
  ["solidity", "taxonomy"],
  ["typescript", "taxonomy"],
];

describe("parser KAT snapshots (byte-identical to upstream)", () => {
  const supported = new Set(supportedLanguages());
  for (const [language, base] of PARSER_FIXTURES) {
    it.runIf(supported.has(language))(`${language}/${base}`, async () => {
      const [fixture, snapshot] = fixturePair(language, base);
      const actual = await parseToCanonical(fixture, language);
      expect(actual).toBe(readFileSync(snapshot, "utf8"));
    });
  }
});
