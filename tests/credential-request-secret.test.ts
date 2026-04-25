import test from "node:test";
import assert from "node:assert/strict";
import { getCredentialRequestSecret } from "../src/credential-display.js";

test("getCredentialRequestSecret formats Cline OAuth tokens as workos bearer values without registry state", () => {
	const secret = getCredentialRequestSecret("cline", {
		type: "oauth",
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
	});

	assert.equal(secret, "workos:access-token");
});
