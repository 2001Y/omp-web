/**
 * OMP settings catalog projection: folds the unified settings registry
 * (single source of truth) into the wire catalog the web
 * settings sections render from — one tab per section, one group per titled
 * block, one field per UI-bearing setting. Pure data adaptation.
 */

import type { WebOmpSettingsCatalog, WebSettingField, WebSettingOption, WebSettingTab } from "@oh-my-pi/web";
import type { Settings } from "../../config/settings";
import { type AnyUiMetadata, SETTING_TABS, TAB_GROUPS, TAB_METADATA } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import { orderedSettings } from "../../config/all-settings";


function optionsOf(ui: AnyUiMetadata | undefined): WebSettingOption[] | undefined {
	const raw = ui?.options;
	if (raw === undefined || raw === "runtime") return undefined;
	return raw.map(option => ({
		value: option.value,
		label: option.label,
		...(option.description !== undefined ? { description: option.description } : {}),
	}));
}

/**
 * Project the settings schema + live values into the web catalog. Settings
 * without UI metadata and conditioned rows (no side-effect-free predicate)
 * are omitted. Number fields without options and arrays render as the
 * client's free-form input (comma-split arrays, Number() coercion).
 */
export function ompSettingsCatalog(
	settings: Settings,
	models: ReadonlyArray<{
		provider: string;
		id: string;
		name?: string;
		contextWindow?: number | null;
		maxTokens?: number | null;
		cost?: { input?: number; output?: number } | undefined;
		reasoning?: unknown;
		input?: readonly string[];
	}> = [],
	roles: ReadonlyArray<{ id: string; name: string; tag?: string; model?: string; thinking?: string }> = [],
	providers: ReadonlyArray<{ id: string; name: string; connected: boolean; credentialCount: number }> = [],
): WebOmpSettingsCatalog {
	const byTab = new Map<string, Map<string, WebSettingField[]>>();
	const groupOrder = new Map<string, string[]>();
	for (const handle of orderedSettings()) {
		const key = handle.id;
		const definition = handle.definition;
		const ui = handle.ui;
		if (ui === undefined) continue;
		const tabId = ui.tab;
		if (!TAB_GROUPS[tabId as keyof typeof TAB_GROUPS]) continue;
		let fields: WebSettingField[];
		let type: WebSettingField["type"];
		const options = optionsOf(ui);
		if (definition.type === "boolean") {
			fields = push(tabId, ui.group);
			type = "boolean";
		} else if (definition.type === "enum") {
			fields = push(tabId, ui.group);
			type = "enum";
		} else if (definition.type === "number") {
			fields = push(tabId, ui.group);
			type = "number";
		} else if (definition.type === "string") {
			if (ui.options === "runtime") continue; // runtime-populated submenu (no static options)
			fields = push(tabId, ui.group);
			type = "string";
		} else if (definition.type === "array") {
			fields = push(tabId, ui.group);
			type = "array";
		} else {
			continue;
		}
		let value: unknown;
		try {
			// Layered value only (what the settings panel shows and edits):
			// environment-supplied values are never projected to the client.
			value = handle.layered(settings);
		} catch {
			continue;
		}
		fields.push({
			key,
			label: ui.label,
			description: ui.description,
			...(ui.warning !== undefined ? { warning: ui.warning } : {}),
			type,
			value: value === undefined ? definition.default : value,
			default: definition.default,
			...(type === "enum" && handle.enumValues !== undefined
				? {
						options: options ?? handle.enumValues.map(value => ({ value, label: value })),
					}
				: options !== undefined && type !== "boolean"
					? { options }
					: {}),
			...(handle.isCredential ? { secret: true } : {}),
		});
	}
	const tabs: WebSettingTab[] = [];
	for (const [tabId, groups] of byTab) {
		const order = groupOrder.get(tabId) ?? [];
		const tab: WebSettingTab = {
			id: tabId,
			label: TAB_METADATA[tabId as keyof typeof TAB_METADATA]?.label ?? tabId,
			groups: [],
		};
		const ungrouped = groups.get("");
		if (ungrouped !== undefined && ungrouped.length > 0) {
			tab.groups.push({ label: "", fields: ungrouped });
		}
		for (const groupLabel of order) {
			const fields = groups.get(groupLabel);
			if (fields !== undefined && fields.length > 0) tab.groups.push({ label: groupLabel, fields });
		}
		tabs.push(tab);
	}
	// Tabs render in the schema's declared SETTING_TABS order.
	tabs.sort((left, right) => {
		const leftIndex = SETTING_TABS.indexOf(left.id as (typeof SETTING_TABS)[number]);
		const rightIndex = SETTING_TABS.indexOf(right.id as (typeof SETTING_TABS)[number]);
		return (
			(leftIndex === -1 ? SETTING_TABS.length : leftIndex) - (rightIndex === -1 ? SETTING_TABS.length : rightIndex)
		);
	});
	// Model roles and provider connections ride the catalog as top-level
	// blocks (their dedicated sections render them, not the tab form).
	return {
		tabs,
		models: models.map(model => ({
			value: `${model.provider}/${model.id}`,
			label: model.name ?? model.id,
			provider: model.provider,
			...(model.contextWindow != null && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
			...(model.maxTokens != null && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
			...(model.cost !== undefined && (model.cost.input ?? 0) > 0 ? { inputPrice: model.cost.input } : {}),
			...(model.cost !== undefined && (model.cost.output ?? 0) > 0 ? { outputPrice: model.cost.output } : {}),
			...(model.reasoning === true ? { reasoning: true } : {}),
			...(model.input?.includes("image") === true ? { vision: true } : {}),
		})),
		modelRoles: roles.map(role => ({ ...role })),
		providers: providers.map(entry => ({ ...entry })),
	};

	function push(tabId: string, group: string | undefined): WebSettingField[] {
		let groups = byTab.get(tabId);
		if (groups === undefined) {
			groups = new Map();
			byTab.set(tabId, groups);
			// Groups render in the schema's declared TAB_GROUPS order.
			groupOrder.set(tabId, [...(TAB_GROUPS[tabId as keyof typeof TAB_GROUPS] ?? [])]);
		}
		const label = group ?? "";
		let fields = groups.get(label);
		if (fields === undefined) {
			fields = [];
			groups.set(label, fields);
			const order = groupOrder.get(tabId) ?? [];
			if (label !== "" && !order.includes(label)) order.push(label);
		}
		return fields;
	}
}
