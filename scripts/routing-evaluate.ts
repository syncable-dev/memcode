import { readFile } from "node:fs/promises";
import {
  evaluateRouting,
  routingEvaluationSchema,
} from "../runtime/routing-calibration";

if (process.argv.length !== 3)
  throw Error(
    "Usage: node --import tsx scripts/routing-evaluate.ts <frozen-outcomes.json>",
  );

const raw: unknown = JSON.parse(await readFile(process.argv[2], "utf8"));
const parsed = routingEvaluationSchema.safeParse(raw);
if (!parsed.success) {
  const fields = parsed.error.issues
    .slice(0, 10)
    .map((issue) => issue.path.join("."));
  throw Error(
    `Invalid routing evaluation fields: ${fields.join(", ") || "input"}`,
  );
}
console.log(JSON.stringify(evaluateRouting(parsed.data), null, 2));
