/**
 * Interaction (approval/question) vocabulary bridged between the driver's
 * ExtensionUIContext implementation and the browser's ApprovalPanel /
 * QuestionComposer. Mirrors the dsh `approval/requested` + `question/requested`
 * mux frames and their `/api/respond` payloads (see PROVENANCE.md in the
 * omp-web workspace root).
 */

/** One pending tool approval shown in the ApprovalPanel. */
export interface WebApprovalAsk {
	/** Stable approval id echoed by the respond payload. */
	approvalId: string;
	/** Tool about to run. */
	toolName: string;
	/** Why the host asked (the OMP approval prompt). */
	reason?: string;
}

/** One selectable option of a question. */
export interface WebAskOption {
	label: string;
	description?: string;
}

/** One question shown in the QuestionComposer. */
export interface WebAskQuestion {
	id: string;
	question: string;
	detail?: string;
	header?: string;
	options?: WebAskOption[];
	multiSelect?: boolean;
}

/** The human's answer to a question batch. */
export interface WebAskAnswer {
	answers: Array<{ id: string; selected: string[]; custom?: string }>;
}

/** One ask crossing the wire as an answerable server-request. */
export type WebAskRequest =
	| { kind: "approval"; approval: WebApprovalAsk }
	| { kind: "question"; questions: WebAskQuestion[] };

/** The settled outcome of one ask. */
export type WebAskOutcome =
	| { kind: "approval"; outcome: "allowed-once" | "rejected" }
	| { kind: "question"; answer: WebAskAnswer | undefined };

/** Payload of the `/api/respond` body for an approval (ApprovalResponsePayload). */
export interface WebApprovalResponseValue {
	sessionId: string;
	approvalId: string;
	outcome: "allowed-once" | "rejected";
}

/** Payload of the `/api/respond` body for a question (QuestionResponsePayload). */
export interface WebQuestionResponseValue {
	sessionId: string;
	answer: WebAskAnswer;
}

/** Narrow an unknown respond value into an approval payload. */
export function parseApprovalResponse(value: unknown): WebApprovalResponseValue | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.sessionId !== "string" ||
		typeof candidate.approvalId !== "string" ||
		(candidate.outcome !== "allowed-once" && candidate.outcome !== "rejected")
	) {
		return undefined;
	}
	return { sessionId: candidate.sessionId, approvalId: candidate.approvalId, outcome: candidate.outcome };
}

/** Narrow an unknown respond value into a question payload. */
export function parseQuestionResponse(value: unknown): WebQuestionResponseValue | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	const answer = candidate.answer;
	if (typeof answer !== "object" || answer === null || !Array.isArray((answer as { answers?: unknown }).answers)) {
		return undefined;
	}
	return { sessionId: candidate.sessionId as string, answer: answer as WebAskAnswer };
}
