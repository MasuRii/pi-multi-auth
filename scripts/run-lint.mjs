import { spawnSync } from "node:child_process";

const result = spawnSync(
	process.execPath,
	["./node_modules/typescript/bin/tsc", "-p", "tsconfig.json", "--pretty", "false"],
	{ encoding: "utf-8" },
);

if (result.error) {
	throw result.error;
}

if (result.status !== 0) {
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}
	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
	process.exitCode = result.status ?? 1;
} else {
	process.stdout.write("[]\n");
}
