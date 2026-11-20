/**
 * Kai UI primitives: thin React components over the design-system classes in
 * `src/styles/primitives/`. They add structure and accessibility (labels,
 * roles, types), never new visuals. See docs/DESIGN_SYSTEM.md.
 */
export { Badge, type Tone } from "./Badge";
export { Banner } from "./Banner";
export { Button, type ButtonVariant } from "./Button";
export { Dialog } from "./Dialog";
export { IconButton } from "./IconButton";
export { Kbd } from "./Kbd";
/** The menu primitive already exists: `PopupMenu` (menu button + roving focus). */
export { PopupMenu as Menu, type MenuEntry } from "../PopupMenu";
