// A scripted stand-in for the GitHub CLI. State lives in FAKE_GH_STATE (JSON):
// { pr: object | null, created: object, mergeMethod: string, calls: string[][] }
import { readFileSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(state));
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const fields = (value) =>
  Object.fromEntries((option("--json") ?? "").split(",").filter(Boolean).map((key) => [key, value[key]]));

const [area, action] = args;
save();
if (area === "pr" && action === "view") {
  if (!state.pr) {
    process.stderr.write("no pull requests found for branch\n");
    process.exit(1);
  }
  if (option("--jq") === ".url") process.stdout.write(state.pr.url + "\n");
  else process.stdout.write(JSON.stringify(fields(state.pr)));
} else if (area === "pr" && action === "create") {
  state.pr = { ...state.created };
  save();
  process.stdout.write("Creating pull request\n" + state.pr.url + "\n");
} else if (area === "pr" && action === "merge") {
  state.pr.state = "MERGED";
  save();
} else if (area === "repo" && action === "view") {
  process.stdout.write(JSON.stringify({ viewerDefaultMergeMethod: state.mergeMethod }));
} else if (area === "pr" && action === "list") {
  process.stdout.write("[]");
} else {
  process.stderr.write("unsupported fake gh call: " + args.join(" ") + "\n");
  process.exit(2);
}
