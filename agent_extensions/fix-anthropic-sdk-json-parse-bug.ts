// https://github.com/earendil-works/pi/issues/2681
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

export default function (pi: ExtensionAPI) {
	let failedMessageTimestamp: number | undefined;

	pi.on("agent_end", (event) => {
		const last = event.messages[event.messages.length - 1];
		if (!last || last.role !== "assistant") return;

		const msg = last as AssistantMessage;
		if (msg.stopReason !== "error" || !msg.errorMessage) return;
		if (!/control character/i.test(msg.errorMessage)) return;

		failedMessageTimestamp = msg.timestamp;

		setTimeout(() => {
			pi.sendUserMessage(
				"Your edit tool call failed. Read the file, then use the write tool to write the complete updated file instead.",
			);
		}, 100);
	});

	pi.on("context", (event) => {
		if (failedMessageTimestamp === undefined) return;
		const ts = failedMessageTimestamp;
		failedMessageTimestamp = undefined;

		return {
			messages: event.messages.filter((m) => {
				if (m.role !== "assistant") return true;
				const msg = m as AssistantMessage;
				return msg.timestamp !== ts;
			}),
		};
	});
}
