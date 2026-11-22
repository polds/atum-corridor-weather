import { isProbeId } from "../../src/domain/brands";
import type { ProbeId } from "../../src/domain/types";

export function probeIdOf(text: string): ProbeId {
	if (!isProbeId(text)) throw new Error(`not a probe id: ${text}`);
	return text;
}
