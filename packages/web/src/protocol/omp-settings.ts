/**
 * OMP settings catalog wire shapes (one tab → one web settings section, one
 * group → one titled block, one field → one rendered control). The coding
 * agent projects its unified settings schema into these; the browser settings
 * sections render from them.
 */

/** One selectable choice of an enum/options field. */
export interface WebSettingOption {
	value: string;
	label: string;
	description?: string;
}

/** One rendered settings field. */
export interface WebSettingField {
	key: string;
	label: string;
	description: string;
	warning?: string;
	type: "boolean" | "enum" | "number" | "string" | "array";
	value: unknown;
	default: unknown;
	options?: WebSettingOption[];
	secret?: boolean;
}

/** One titled block inside a tab. */
export interface WebSettingGroup {
	label: string;
	fields: WebSettingField[];
}

/** One web settings tab (one sidebar section in the settings dialog). */
export interface WebSettingTab {
	id: string;
	label: string;
	groups: WebSettingGroup[];
}

/** Selectable model row (the Model Roles browser's data; TUI parity). */
export interface WebModelOption {
	value: string;
	label: string;
	provider: string;
	/** Context window in tokens. */
	contextWindow?: number;
	/** Max output tokens. */
	maxTokens?: number;
	/** Input/output price per million tokens (USD). */
	inputPrice?: number;
	outputPrice?: number;
	reasoning?: boolean;
	vision?: boolean;
}

/** One model-role assignment (the dedicated Model Roles section's data). */
export interface WebModelRole {
	id: string;
	name: string;
	/** Short role tag (DEFAULT/SMOL/…), the TUI selector's badge. */
	tag?: string;
	/** Current assignment ("provider/model"), absent when unset. */
	model?: string;
	/** Explicit thinking selector (minimal…max), absent when following settings. */
	thinking?: string;
}

/** One provider login state (the dedicated Connect section's data). */
export interface WebProviderAccount {
	id: string;
	name: string;
	/** Whether credentials are stored. */
	connected: boolean;
	/** Stored credential count. */
	credentialCount: number;
}

/**
 * One provider login started from the Connect section (the host runs the
 * provider's own OAuth flow; the browser only carries the sign-in itself).
 */
export interface WebAuthLoginAttempt {
	attemptId: string;
	/** Provider the login authenticates (the credential store target). */
	provider: string;
	state: "pending" | "done" | "error";
	/** Browser sign-in surface, present once the flow publishes it. */
	auth?: { url: string; instructions?: string };
	/** Latest progress line reported by the flow. */
	progress?: string;
	/** A prompt the flow is waiting on (an authorization code, an API key…). */
	prompt?: { message: string; secret?: boolean };
	/** Formatted account identity once done (email, optionally with org). */
	identity?: string;
	error?: string;
}

/** The full catalog served by `ompSettings/describe`. */
export interface WebOmpSettingsCatalog {
	tabs: WebSettingTab[];
	/** Selectable models for the role browser. */
	models: WebModelOption[];
	/** Model-role assignments (the dedicated section, not a settings group). */
	modelRoles: WebModelRole[];
	/** Provider login states (the dedicated Connect section). */
	providers: WebProviderAccount[];
}
