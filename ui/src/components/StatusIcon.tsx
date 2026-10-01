import { useState } from "react";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { BLOCKED_STATUS_LABEL, issueStatusLabelOverride } from "../lib/issue-status-labels";
import type { ParkIssuePatch } from "../lib/park-issue";
import { ParkIssueDialog } from "./ParkIssueDialog";
import { StatusGlyph, type StatusGlyphSize } from "./StatusGlyph";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

const allStatuses = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled", "blocked"];

/** De waarde waarop de server een parkeerstap afdwingt: `blocked` blijft `blocked`. */
const PARKED_STATUS = "blocked";

/**
 * Extra velden die de picker meestuurt naast de status. Alleen de
 * parkeerstap levert iets mee: `unblockDescriptor` is de escape die de server
 * al accepteert (`createIssueBaseSchema`), zodat een mens een taak zelf in "In
 * afwachting" kan zetten zonder blokker. De aanroeper plakt dit fragment in
 * dezelfde PATCH als de status.
 */
export interface StatusChangeExtras {
  unblockDescriptor?: ParkIssuePatch["unblockDescriptor"];
}

function statusLabel(status: string): string {
  const renamed = issueStatusLabelOverride(status);
  if (renamed) return renamed;
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface StatusIconProps {
  status: string;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
  onChange?: (status: string, extras?: StatusChangeExtras) => void;
  className?: string;
  /** Optional layout wrapper around the glyph. Does not change glyph dimensions. */
  glyphContainerClassName?: string;
  showLabel?: boolean;
  /** Glyph size (PAP-243a). Default `md` (16px); lists/detail/mentions use `lg` (20px). */
  size?: StatusGlyphSize;
  /** Issue-titel/-identifier, alleen gebruikt in de titel van de parkeer-dialoog. */
  issueLabel?: string | null;
}

function blockedAttentionLabel(blockerAttention: IssueBlockerAttention | null | undefined) {
  // Zonder aandachtsreden staat hier de statusnaam zelf; met een reden begint de
  // zin met het woord "Blocked" als diagnose van de blokkade, niet als statuslabel.
  if (!blockerAttention || blockerAttention.state === "none") return BLOCKED_STATUS_LABEL;

  if (blockerAttention.reason === "active_child") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return `Blocked · waiting on active sub-task ${blockerAttention.sampleBlockerIdentifier}`;
    }
    if (count === 1) return "Blocked · waiting on 1 active sub-task";
    return `Blocked · waiting on ${count} active sub-tasks`;
  }

  if (blockerAttention.reason === "active_dependency") {
    const count = blockerAttention.coveredBlockerCount;
    if (count === 1 && blockerAttention.sampleBlockerIdentifier) {
      return `Blocked · covered by active dependency ${blockerAttention.sampleBlockerIdentifier}`;
    }
    if (count === 1) return "Blocked · covered by 1 active dependency";
    return `Blocked · covered by ${count} active dependencies`;
  }

  if (blockerAttention.reason === "stalled_review") {
    const count = blockerAttention.stalledBlockerCount;
    const leaf = blockerAttention.sampleStalledBlockerIdentifier ?? blockerAttention.sampleBlockerIdentifier;
    if (count === 1 && leaf) return `Blocked · review stalled on ${leaf}`;
    if (count === 1) return "Blocked · review stalled with no clear next step";
    return `Blocked · ${count} reviews stalled with no clear next step`;
  }

  if (blockerAttention.reason === "attention_required") {
    const count = blockerAttention.attentionBlockerCount || blockerAttention.unresolvedBlockerCount;
    const attentionCopy = `${count} ${count === 1 ? "blocker needs" : "blockers need"} attention`;
    const coveredCount = blockerAttention.coveredBlockerCount;
    if (coveredCount > 0) {
      return `Blocked · ${attentionCopy}; ${coveredCount} covered by active work`;
    }
    return `Blocked · ${attentionCopy}`;
  }

  return BLOCKED_STATUS_LABEL;
}

/**
 * Task/issue status indicator — renders the unified, color-blind-safe
 * {@link StatusGlyph} (one distinct shape per status). With `onChange` it also
 * acts as a status picker (popover). This one component drives every standalone
 * status surface: list, kanban, detail header, properties row + picker flyout,
 * sub-task / blocked-by pills, blocked inbox, quicklook, sibling nav, filters,
 * search, columns, dashboard.
 *
 * A "covered" blocked task (waiting on active work) maps to the `in_queue`
 * glyph — the blocked shape recoloured blue — while the full blocked reason
 * still rides on the accessible label.
 */
export function StatusIcon({ status, externalConversationState, blockerAttention, onChange, className, glyphContainerClassName, showLabel, size = "md", issueLabel }: StatusIconProps) {
  const [open, setOpen] = useState(false);
  const [parking, setParking] = useState(false);
  const displayStatus = status === "in_review" && externalConversationState === "waiting" ? "idle" : status;
  const isCoveredBlocked = status === "blocked" && blockerAttention?.state === "covered";
  const ariaLabel = status === "blocked" ? blockedAttentionLabel(blockerAttention) : statusLabel(displayStatus);
  const glyphStatus = isCoveredBlocked ? "in_queue" : displayStatus;

  const glyphIcon = (
    <StatusGlyph
      status={glyphStatus}
      size={size}
      className={cn(onChange && !showLabel && "cursor-pointer", className)}
      title={ariaLabel}
    />
  );
  const glyph = glyphContainerClassName ? (
    <span className={glyphContainerClassName} data-status-glyph-container="true">
      {glyphIcon}
    </span>
  ) : glyphIcon;

  if (!onChange) {
    return showLabel ? (
      <span className="inline-flex items-center gap-1.5">
        {glyph}
        <span className="text-sm">{statusLabel(displayStatus)}</span>
      </span>
    ) : (
      glyph
    );
  }

  const trigger = showLabel ? (
    <button
      type="button"
      aria-label={`Change status (current: ${ariaLabel})`}
      className="inline-flex min-h-5 items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors"
    >
      {glyph}
      <span className="text-sm">{statusLabel(displayStatus)}</span>
    </button>
  ) : (
    <button
      type="button"
      data-slot="icon-button"
      aria-label={`Change status (current: ${ariaLabel})`}
      className="inline-flex cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring"
    >
      {glyph}
    </button>
  );

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-40 p-1" align="start">
          {allStatuses.map((s) => (
            <Button
              key={s}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start gap-2 text-xs", s === status && "bg-accent")}
              onClick={() => {
                setOpen(false);
                // In "In afwachting" parkeren gaat niet zonder escape: de server
                // weigert `blocked` zonder blokker, interactie of approval. Vraag
                // dan wie de taak eruit haalt, en stuur de descriptor mee in dezelfde
                // PATCH. Een issue dat al geparkeerd is, hoeft niet door de stap heen.
                if (s === PARKED_STATUS && status !== PARKED_STATUS) {
                  setParking(true);
                  return;
                }
                onChange(s);
              }}
            >
              <StatusIcon status={s} size="lg" />
              {statusLabel(s)}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      {/* Alleen monteren als hij echt nodig is: een dichte dialoog op elke
          statusknop kost een query-client en een portal per kaart. */}
      {parking ? (
        <ParkIssueDialog
          open
          onOpenChange={setParking}
          issueLabel={issueLabel}
          onConfirm={(patch) => onChange(patch.status, { unblockDescriptor: patch.unblockDescriptor })}
        />
      ) : null}
    </>
  );
}
