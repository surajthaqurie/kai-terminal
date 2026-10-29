/**
 * Test doubles for rendering <App /> under jsdom: a TerminalView stand-in
 * that records its latest props (so tests can fire `onExit`,
 * `onCwdResolved`, …) and lightweight stubs for the lazy-loaded modals.
 * State lives in `registry`, shared between the vi.mock factories and the
 * test file (both resolve to this single module instance).
 */
import { createElement, forwardRef, useEffect, useImperativeHandle } from "react";

type AnyProps = Record<string, any>;

export const registry = {
  /** Latest props per mounted pane (sessionId -> props). */
  panes: new Map<string, AnyProps>(),
  /** How many times each pane's TerminalView stand-in has rendered. */
  renders: new Map<string, number>(),
  /** `<sessionId>:<method>` for every imperative call App makes on a pane. */
  refCalls: [] as string[],
  /** Latest props per stubbed modal/panel, keyed by stub name. */
  modals: {} as Record<string, AnyProps | undefined>,
  /** Handlers registered through the mocked tauri `listen`. */
  listeners: {} as Record<string, (event: unknown) => void>,
  reset() {
    this.panes.clear();
    this.renders.clear();
    this.refCalls.length = 0;
    this.modals = {};
    this.listeners = {};
  },
};

export const TerminalViewStub = forwardRef<unknown, AnyProps>((props, ref) => {
  registry.panes.set(props.sessionId, props);
  registry.renders.set(props.sessionId, (registry.renders.get(props.sessionId) ?? 0) + 1);
  useImperativeHandle(ref, () => {
    const call = (method: string) => () => {
      registry.refCalls.push(`${props.sessionId}:${method}`);
    };
    return {
      clear: call("clear"),
      toggleSearch: call("toggleSearch"),
      resetModes: call("resetModes"),
      refit: call("refit"),
      focus: call("focus"),
      pasteText: (text: string) => registry.refCalls.push(`${props.sessionId}:paste:${text}`),
      copySelection: async () => {
        registry.refCalls.push(`${props.sessionId}:copy`);
        return "";
      },
    };
  });
  useEffect(
    () => () => {
      registry.panes.delete(props.sessionId);
    },
    [props.sessionId]
  );
  return createElement("div", { "data-testid": "terminal", "data-session": props.sessionId });
});
TerminalViewStub.displayName = "TerminalViewStub";

/** `openKey` is the boolean prop that says whether the stub is open. */
export function makeModalStub(name: string, openKey: "isOpen" | "open" | null) {
  return function ModalStub(props: AnyProps) {
    registry.modals[name] = props;
    const open = openKey ? Boolean(props[openKey]) : true;
    return createElement("div", { "data-testid": name, "data-open": String(open) });
  };
}
