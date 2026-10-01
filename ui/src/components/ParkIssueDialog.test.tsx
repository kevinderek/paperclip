// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParkIssueDialog } from "./ParkIssueDialog";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

describe("ParkIssueDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    mockAuthApi.getSession.mockReset();
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderOpen() {
    const onConfirm = vi.fn();
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ParkIssueDialog
            open
            onOpenChange={() => undefined}
            issueLabel="PAP-1"
            onConfirm={onConfirm}
          />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { onConfirm };
  }

  /**
   * REK-450, variant A: parkeren is tijdelijk. De monitor overleeft de overgang
   * naar `blocked` en de check gaat af op het afgesproken moment, dus de tekst
   * die zegt dat niemand de taak oppakt en dat de check vervalt is een onwaarheid
   * in de UI. Deze test leest de gerenderde tekst, niet de bron: een paraphrase van
   * een onwaarheid is nog een onwaarheid die niemand controleert, en alleen de
   * weergegeven zin kan ons terugzetten.
   */
  it("does not claim a parked task is unreachable while it waits", async () => {
    await renderOpen();
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/No agent picks it up while it waits/);
    expect(text).not.toMatch(/a scheduled check on it\s+lapses/i);
    expect(text).toMatch(/scheduled check still runs/i);
    expect(text).toMatch(/picks it up again/i);
  });

  it("keeps the label and the owner question", async () => {
    await renderOpen();
    const text = container.textContent ?? "";

    expect(text).toContain("PAP-1 stops here.");
    expect(text).toContain("Move to In afwachting");
    expect(text).toContain("The board");

    // The owner question is a group label rather than visible copy, so it is
    // asserted where a screen reader reads it.
    expect(container.querySelector("[aria-label='Who takes this out of waiting']")).not.toBeNull();
  });
});