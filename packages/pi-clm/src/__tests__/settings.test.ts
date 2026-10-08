import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyOverrides, CLM_SETTINGS, defaultClmSettings, sanitizeOverrides } from "../settings.ts";

describe("CLM settings", () => {
	test("every panel choice, once applied, shows as a listed choice (so cycling moves on)", () => {
		const base = defaultClmSettings({});
		for (const descriptor of CLM_SETTINGS) {
			for (const choice of descriptor.choices ?? []) {
				const applied = applyOverrides(base, descriptor.parse(choice, "/bundled/house-brief.md"));
				assert.ok(
					descriptor.choices!.includes(descriptor.format(applied, {})),
					`${descriptor.label}: "${choice}" shows as "${descriptor.format(applied, {})}"`,
				);
			}
		}
	});

	test("stored overrides keep well-formed values and drop the rest", () => {
		assert.deepEqual(
			sanitizeOverrides({
				budget: 200_000,
				reserve: 0,
				reminders: [0.5, 0.9],
				guard: "off",
				cap: null,
				steering: "brief.md",
				oneTool: true,
			}),
			{ overrides: { budget: 200_000, reserve: 0, reminders: [0.5, 0.9], guard: "off", cap: null, steering: "brief.md", oneTool: true }, ignored: [] },
		);
		assert.deepEqual(
			sanitizeOverrides({ reminders: "50/75", budget: -1, cap: 50, compaction: "sometimes", trailer: "yes", compactTarget: 0.5, capHead: 1 }),
			{ overrides: { capHead: 1 }, ignored: ["reminders", "budget", "cap", "compaction", "trailer", "compactTarget"] },
		);
		assert.deepEqual(sanitizeOverrides(null), { overrides: {}, ignored: [] });
		assert.deepEqual(sanitizeOverrides(["budget"]), { overrides: {}, ignored: ["overrides"] });
	});
});
