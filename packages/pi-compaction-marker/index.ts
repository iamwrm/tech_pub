import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import compactionKeptMarker from "./0010-compaction-kept-marker.ts";

export default function piCompactionMarker(pi: ExtensionAPI) {
	compactionKeptMarker(pi);
}
