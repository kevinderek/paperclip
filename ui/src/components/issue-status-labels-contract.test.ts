import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  BLOCKED_STATUS_LABEL,
  ISSUE_STATUS_LABEL_OVERRIDES,
  issueStatusLabelOverride,
} from "../lib/issue-status-labels";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;

const NAIVE_TITLE_CASE = 'return status.replace(/_/g, " ").replace(/\\b\\w/g, (c) => c.toUpperCase());';

/** Elk oppervlak dat de issue-status `blocked` als woord toont. */
const ISSUE_STATUS_SURFACES = [
  "../components/IssuesList.tsx",
  "../components/LegacyIssuesList.tsx",
  "../components/ActivityCharts.tsx",
  "../components/KanbanBoard.tsx",
  "../components/IssueLinkQuicklook.tsx",
  "../components/StatusIcon.tsx",
  "../components/IssueFiltersPopover.tsx",
  "../components/search/SearchFilterBar.tsx",
];

describe("issue-statuslabel blocked -> In afwachting", () => {
  it("hernoemt alleen blocked, en laat de opgeslagen waarde met rust", () => {
    expect(BLOCKED_STATUS_LABEL).toBe("In afwachting");
    expect(Object.keys(ISSUE_STATUS_LABEL_OVERRIDES)).toEqual(["blocked"]);
    expect(issueStatusLabelOverride("blocked")).toBe("In afwachting");

    for (const status of ISSUE_STATUSES.filter((s) => s !== "blocked")) {
      expect(issueStatusLabelOverride(status)).toBeUndefined();
    }
  });

  it("haalt het label op elk issue-statusoppervlak uit de gedeelde kaart", () => {
    for (const path of ISSUE_STATUS_SURFACES) {
      const text = source(path);
      expect(text, path).toContain("lib/issue-status-labels");
      expect(text, path).toMatch(/BLOCKED_STATUS_LABEL|issueStatusLabelOverride/);
    }
  });

  it("laat de overige zes labels per oppervlak ongewijzigd", () => {
    const listBody =
      [
        "",
        '  backlog: "Backlog",',
        '  todo: "Todo",',
        '  in_progress: "In progress",',
        '  in_review: "In review",',
        '  done: "Done",',
        '  blocked: "In afwachting",',
        '  cancelled: "Cancelled",',
      ].join("\n");

    for (const path of ["../components/IssuesList.tsx", "../components/LegacyIssuesList.tsx"]) {
      const match = source(path).match(
        /const issueStatusLabels: Record<IssueStatus, string> = \{([\s\S]*?)\n\};/,
      );
      expect(match, path).not.toBeNull();
      expect(match?.[1].replace(/BLOCKED_STATUS_LABEL/g, '"In afwachting"'), path).toBe(listBody);
    }

    const charts = source("../components/ActivityCharts.tsx").match(
      /const statusLabels: Record<string, string> = \{([\s\S]*?)\n\};/,
    );
    expect(charts?.[1].replace(/BLOCKED_STATUS_LABEL/g, '"In afwachting"')).toBe(
      [
        "",
        '  todo: "To Do",',
        '  in_progress: "In Progress",',
        '  in_review: "In Review",',
        '  done: "Done",',
        '  blocked: "In afwachting",',
        '  cancelled: "Cancelled",',
        '  backlog: "Backlog",',
      ].join("\n"),
    );
  });

  it("laat de mechanische afleiders voor de overige zes ongemoeid", () => {
    for (const path of ["../components/KanbanBoard.tsx", "../components/StatusIcon.tsx"]) {
      expect(source(path), path).toContain(NAIVE_TITLE_CASE);
    }
    expect(source("../components/IssueLinkQuicklook.tsx")).toContain(
      "return words.charAt(0).toUpperCase() + words.slice(1);",
    );
  });

  it("raakt de runstatus-vertaling in IssueRunLedger niet", () => {
    const ledger = source("../components/IssueRunLedger.tsx");
    expect(ledger).not.toContain("issue-status-labels");
    expect(ledger).toContain(
      'function statusLabel(status: string) {\n  return status.replace(/_/g, " ");\n}',
    );
  });

  it("laat de blokkade-redenzinnen met hun eigen copy staan", () => {
    // "Blocked · waiting on active sub-task X" is een diagnose van de blokkade,
    // niet de statusnaam; die zinnen staan vast in drie bestaande tests.
    const icon = source("../components/StatusIcon.tsx");
    expect(icon).toContain("return `Blocked · waiting on active sub-task ${");
    expect(icon).toContain('if (!blockerAttention || blockerAttention.state === "none") return BLOCKED_STATUS_LABEL;');
  });
});