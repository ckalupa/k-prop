import fs from "node:fs";
import path from "node:path";

const source = process.argv[2];
const outputDir = process.argv[3];
const maxStatements = 300;

if (!source || !outputDir) {
  console.error("Usage: node split-seed.mjs <source.sql> <output-directory>");
  process.exit(1);
}

const text = fs.readFileSync(source, "utf8");
const lines = text.split(/\r?\n/);

const statements = [];
let current = [];

for (const line of lines) {
  const trimmed = line.trim();

  // Remove transaction wrappers and the final validation SELECT.
  if (
    trimmed === "BEGIN TRANSACTION;" ||
    trimmed === "COMMIT;" ||
    trimmed.startsWith("PRAGMA foreign_keys") ||
    trimmed.startsWith("-- Validation summary")
  ) {
    continue;
  }

  // Stop before the final UNION-based validation query.
  if (trimmed.startsWith("SELECT 'teams' AS table_name")) {
    break;
  }

  if (!trimmed || trimmed.startsWith("--")) {
    continue;
  }

  current.push(line);

  if (trimmed.endsWith(";")) {
    statements.push(current.join("\n"));
    current = [];
  }
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

let fileNumber = 1;

for (let start = 0; start < statements.length; start += maxStatements) {
  const batch = statements.slice(start, start + maxStatements);

  const contents = [
    "BEGIN TRANSACTION;",
    ...batch,
    "COMMIT;",
    "",
  ].join("\n");

  const filename = `${String(fileNumber).padStart(3, "0")}.sql`;
  fs.writeFileSync(path.join(outputDir, filename), contents, "utf8");
  fileNumber++;
}

console.log(`Statements found: ${statements.length}`);
console.log(`Chunk files created: ${fileNumber - 1}`);
console.log(`Output directory: ${outputDir}`);
