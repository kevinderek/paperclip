import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import {
  buildParkIssuePatch,
  PARK_ACTION_MAX,
  type ParkIssuePatch,
  type ParkOwnerChoice,
} from "@/lib/park-issue";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioCardGroup, type RadioCardOption } from "@/components/ui/radio-card";
import { Textarea } from "@/components/ui/textarea";

/**
 * De parkeerstap van de statuspicker: een mens zet een taak zelf op
 * "In afwachting", ook zonder blokkerende issue.
 *
 * De server weigert die stap zonder escape (de 422 op `enteringBlocked`), dus
 * vraagt deze dialoog wie de taak eruit haalt en wat er moet gebeuren, en
 * stuurt beide velden in één PATCH. `board` is de standaard omdat de server die
 * owner altijd accepteert; `{ userId }` mag alleen als de gebruiker een actief
 * lid van het bedrijf is, en die controle kan falen — de fout van de server
 * komt dan terug in de toast van de aanroepende mutatie.
 */
export function ParkIssueDialog({
  open,
  onOpenChange,
  issueLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Issue-titel of -identifier, voor de dialoogtitel. */
  issueLabel?: string | null;
  onConfirm: (patch: ParkIssuePatch) => void;
}) {
  const [owner, setOwner] = useState<ParkOwnerChoice>("board");
  const [action, setAction] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    enabled: open,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  useEffect(() => {
    if (!open) return;
    setOwner("board");
    setAction("");
    setError(null);
  }, [open]);

  function submit() {
    const result = buildParkIssuePatch({ owner, action, currentUserId });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onConfirm(result.patch);
    onOpenChange(false);
  }

  const ownerOptions: RadioCardOption[] = [
    {
      value: "board",
      title: "The board",
      description: "Someone from the board takes it out of waiting.",
    },
    {
      value: "self",
      title: "Me",
      description: "I take it out of waiting myself.",
      disabled: !currentUserId,
      ...(currentUserId ? {} : { tooltip: "Your account is not known here." }),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Move to In afwachting</DialogTitle>
          <DialogDescription>
            {issueLabel ? `${issueLabel} stops here. ` : ""}
            It keeps its place and a scheduled check still runs: the task stays
            put until that check comes due, and then the agent it is assigned to
            picks it up again. Say who takes it out of waiting and what has to
            happen first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <RadioCardGroup
            value={owner}
            onValueChange={(value) => setOwner(value as ParkOwnerChoice)}
            options={ownerOptions}
            ariaLabel="Who takes this out of waiting"
          />

          <div className="space-y-1.5">
            <label htmlFor="park-issue-action" className="text-sm font-medium">
              What has to happen
            </label>
            <Textarea
              id="park-issue-action"
              value={action}
              maxLength={PARK_ACTION_MAX}
              onChange={(event) => {
                setAction(event.target.value);
                setError(null);
              }}
              placeholder="e.g. Waiting for the supplier to confirm the new price list."
              aria-invalid={error ? true : undefined}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="text-destructive">{error ?? ""}</span>
              <span className="tabular-nums">
                {action.trim().length}/{PARK_ACTION_MAX}
              </span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Move to In afwachting</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
