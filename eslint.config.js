import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
	{
		ignores: ["node_modules/**", ".test-dist/**", "debug/**"],
	},
	{
		files: ["**/*.ts"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			parser: tseslint.parser,
			globals: {
				...globals.browser,
				...globals.node,
			},
		},
		plugins: {
			"@typescript-eslint": tseslint.plugin,
		},
		rules: {
			"eqeqeq": ["error", "always", { null: "ignore" }],
			"no-constant-binary-expression": "error",
			"no-debugger": "error",
			"no-self-compare": "error",
			"no-unsafe-finally": "error",
			"no-unreachable": "error",
			"valid-typeof": "error",
			"@typescript-eslint/no-duplicate-enum-values": "error",
		},
	},
	{
		files: ["index.ts", "src/**/*.ts"],
		rules: {
			"no-console": "error",
			"no-restricted-syntax": [
				"error",
				{
					selector:
						"CallExpression[callee.object.object.name='process'][callee.object.property.name='stdout'][callee.property.name='write']",
					message: "Extension code must not write directly to stdout.",
				},
				{
					selector:
						"CallExpression[callee.object.object.name='process'][callee.object.property.name='stderr'][callee.property.name='write']",
					message: "Extension code must not write directly to stderr.",
				},
			],
		},
	},
]);
