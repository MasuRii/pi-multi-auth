const KILO_REQUEST_HEADERS = {
	"X-KILOCODE-EDITORNAME": "Pi",
} as const;

export function buildKiloRequestHeaders(): Record<string, string> {
	return { ...KILO_REQUEST_HEADERS };
}
