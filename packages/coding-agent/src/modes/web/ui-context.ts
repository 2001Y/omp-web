/**
 * ExtensionUIContext implementation bridging the OMP extension/tool-approval
 * dialogs onto the web GUI's ApprovalPanel and QuestionComposer through the
 * driver's ask channel (`approval/requested` / `question/requested` mux frames
 * answered over `POST /api/respond`).
 */

import type { WebAskAnswer, WebAskQuestion } from "@oh-my-pi/web";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogResultItem,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";

/** The driver face this context asks through. */
export interface WebInteractionAsker {
	/** Park one tool approval until the browser answers. */
	askApproval(approval: { toolName: string; reason?: string }): Promise<"allowed-once" | "rejected">;
	/** Park one question batch until the browser answers (undefined = cancelled). */
	askQuestions(questions: WebAskQuestion[]): Promise<WebAskAnswer | undefined>;
	/** Surface one extension notice in the transcript (the TUI status-line toast seat). */
	notify(message: string, level: "info" | "warning" | "error"): void;
}

/** Parse the tool name out of OMP's `Allow tool: <name>` approval prompt. */
function toolNameOfPrompt(title: string): string {
	const match = /^Allow tool: (\S+)/.exec(title);
	return match?.[1] ?? "tool";
}

/** The web-mode UI context. */
export class WebExtensionUIContext implements ExtensionUIContext {
	constructor(private readonly asker: WebInteractionAsker) {}

	// Arrow class fields: consumers destructure these off the instance
	// (`const dialog = ctx.askDialog; dialog(...)`), which would detach `this`.
	select = async (
		title: string,
		options: ExtensionUISelectItem[],
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> => {
		const labels = options.map(getExtensionUISelectOptionLabel);
		// OMP's tool-approval gate is a two-option select; the web client has a
		// dedicated approval panel for exactly that shape.
		if (labels.length === 2 && labels.includes("Approve") && labels.includes("Deny")) {
			const outcome = await this.asker.askApproval({ toolName: toolNameOfPrompt(title), reason: title });
			return outcome === "allowed-once" ? "Approve" : "Deny";
		}
		const answer = await this.asker.askQuestions([
			{
				id: "select",
				question: title,
				options: options.map(option =>
					typeof option === "string"
						? { label: option }
						: { label: option.label, ...(option.description ? { description: option.description } : {}) },
				),
			},
		]);
		const selected = answer?.answers[0]?.selected[0];
		return selected === undefined ? undefined : selected;
	};

	confirm = async (title: string, message: string, _dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> => {
		const answer = await this.asker.askQuestions([
			{ id: "confirm", question: title, detail: message, options: [{ label: "Yes" }, { label: "No" }] },
		]);
		return answer?.answers[0]?.selected[0] === "Yes";
	};

	input = async (
		title: string,
		placeholder?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> => {
		const answer = await this.asker.askQuestions([
			{ id: "input", question: title, ...(placeholder ? { detail: placeholder } : {}) },
		]);
		return answer?.answers[0]?.custom;
	};

	askDialog = async (
		questions: ExtensionAskDialogQuestion[],
		_dialogOptions?: ExtensionUIDialogOptions,
	): Promise<ExtensionAskDialogResult | undefined> => {
		const mapped: WebAskQuestion[] = questions.map(question => ({
			id: question.id,
			question: question.question,
			...(question.header ? { header: question.header } : {}),
			options: question.options.map(option => ({
				label: option.label,
				...(option.description ? { description: option.description } : {}),
			})),
			...(question.multi ? { multiSelect: true } : {}),
		}));
		const answer = await this.asker.askQuestions(mapped);
		if (answer === undefined) return undefined;
		const byId = new Map(answer.answers.map(item => [item.id, item]));
		const results: ExtensionAskDialogResultItem[] = questions.map(question => {
			const item = byId.get(question.id);
			return {
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions: item?.selected ?? [],
				...(item?.custom ? { customInput: item.custom } : {}),
			};
		});
		return { kind: "submit", results };
	};

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.asker.notify(message, type ?? "info");
	}

	onTerminalInput(): () => void {
		return () => {};
	}

	setStatus(_key: string, _text: string | undefined): void {}

	setWorkingMessage(_message?: string): void {}

	setWidget(_key: string, _content: unknown, _options?: ExtensionWidgetOptions): void {}

	setFooter(_factory: unknown): void {}

	setHeader(_factory: unknown): void {}

	setTitle(_title: string): void {}

	setEditorText(_text: string): void {}

	pasteToEditor(text: string): void {
		this.setEditorText(text);
	}

	getEditorText(): string {
		return "";
	}

	editor = async (
		title: string,
		prefill?: string,
		_dialogOptions?: ExtensionUIDialogOptions,
		_editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> => {
		return await this.input(title, prefill);
	};

	addAutocompleteProvider(): void {}

	setEditorComponent(_factory: unknown): void {}

	/** No custom editor factory exists in web mode (the composer is the client's own). */
	getEditorComponent(): undefined {
		return undefined;
	}

	custom(): Promise<never> {
		return Promise.reject(new Error("omp-web: custom components are not supported in web mode"));
	}

	get theme(): Theme {
		return theme;
	}

	async getAllThemes(): Promise<Array<{ name: string; path: string | undefined }>> {
		return [];
	}

	async getTheme(_name: string): Promise<Theme | undefined> {
		return theme;
	}

	async setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		return { success: false, error: "omp-web: theme switching is not supported in web mode" };
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(_expanded: boolean): void {}
}
