import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TEST_ROOT = ".test-dist/tests";

function collectCompiledTestFiles(directory) {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				return collectCompiledTestFiles(entryPath);
			}
			return entry.isFile() && entry.name.endsWith(".test.js") ? [entryPath] : [];
		})
		.sort();
}

const testFiles = collectCompiledTestFiles(TEST_ROOT);
if (testFiles.length === 0) {
	throw new Error(`No compiled test files found in ${TEST_ROOT}.`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
	stdio: "inherit",
});

if (result.error) {
	throw result.error;
}

process.exitCode = result.status ?? 1;
