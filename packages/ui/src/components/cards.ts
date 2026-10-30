import type { ReactElement } from "react";
import type { CardProps } from "./CardShell";

/** Which card draws which kind of device. The Instances page fills it in; a linked Lumina uses it to draw the other Lumina's devices. */
export const CARDS: Record<string, (props: CardProps) => ReactElement> = {};
