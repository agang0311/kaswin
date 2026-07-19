import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { RoundSourceTab } from "../state-machine";

interface SourceWorkspaceProps {
  createPanel: ReactNode;
  embedded: boolean;
  expanded: boolean;
  historyPanel: ReactNode;
  onExpandedChange(expanded: boolean): void;
  onSelectTab(tab: RoundSourceTab): void;
  sourceTab: RoundSourceTab;
  t(key: string): string;
}

/** Keeps the create/history tab state and ARIA relationship identical in every source workspace. */
export function SourceWorkspace(props: SourceWorkspaceProps) {
  if (props.embedded && !props.expanded) return null;
  return (
    <section className={`tabbed-workspace source-workspace${props.expanded ? " expanded" : " collapsed"}${props.embedded ? " embedded" : ""}`}>
      {!props.embedded ? <button
        type="button"
        className="source-workspace-toggle"
        aria-expanded={props.expanded}
        aria-controls="round-source-content"
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <span><strong>{props.t("roundManager.title")}</strong><small>{props.t("roundManager.description")}</small></span>
        <span className="source-workspace-toggle-action">{props.t(props.expanded ? "roundManager.hide" : "roundManager.show")}<ChevronDown size={18} aria-hidden="true" /></span>
      </button> : null}
      {props.expanded ? <div id="round-source-content">
        <div className="workspace-tabs" role="tablist" aria-label={props.t("roundSourceTabs")}>
          <button type="button" id="round-history-tab" className={`workspace-tab participant-source-tab ${props.sourceTab === "history" ? "active" : ""}`} role="tab" aria-selected={props.sourceTab === "history"} aria-controls="round-history-panel" onClick={() => props.onSelectTab("history")}>{props.t("loadHistory")}</button>
          <button type="button" id="round-create-tab" className={`workspace-tab organizer-source-tab ${props.sourceTab === "create" ? "active" : ""}`} role="tab" aria-selected={props.sourceTab === "create"} aria-controls="round-create-panel" onClick={() => props.onSelectTab("create")}>{props.t("createRound")}</button>
        </div>
        {props.sourceTab === "create" ? props.createPanel : props.historyPanel}
      </div> : null}
    </section>
  );
}
