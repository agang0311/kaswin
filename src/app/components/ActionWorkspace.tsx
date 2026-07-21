import type { ReactNode } from "react";
import type { FinalizeState, RaffleMetadata } from "../../raffle/types";
import type { RoundActionTab } from "../state-machine";
import type { TranslationValues } from "../i18n";
import { ExplorerLink } from "./ExplorerLink";

interface ActionWorkspaceProps {
  activeIndexerRequirement?: ReactNode;
  actionTab: RoundActionTab;
  buyCostTooltip: string;
  buyBlockedReason?: string;
  buyNotice?: string;
  canBuy: boolean;
  canCloseEmpty: boolean;
  canDraw: boolean;
  canRefund: boolean;
  canTopUpCarrier: boolean;
  drawBlockedReason?: string;
  emptyCloseCostTooltip: string;
  feedback?: ReactNode;
  feedbackTarget: "create" | "buy" | "draw" | "refund" | "carrier" | "close";
  finalized?: FinalizeState;
  formatKas(value: bigint): string;
  isBuying: boolean;
  isClosingEmpty: boolean;
  isFinalizing: boolean;
  isRefunding: boolean;
  isToppingUpCarrier: boolean;
  metadata: Pick<RaffleMetadata, "covenant" | "roundId">;
  network: string;
  onBuy(): void;
  onCloseEmpty(): void;
  onDraw(): void;
  onRefund(): void;
  onTopUpCarrier(): void;
  onSelectTab(tab: RoundActionTab): void;
  parsedTicketQuantity: number;
  payoutCostTooltip: string;
  purchaseTotal: bigint;
  refundAvailable: boolean;
  refundBlockedReason?: string;
  refundCostTooltip: string;
  refundProgress: { cursor: number; total: number } | null;
  remainingTickets: number;
  round: { maxTickets: number; minTickets: number; soldTickets: number; status: string };
  setTicketQuantity(value: string): void;
  setTopUpCarrierKas(value: string): void;
  shortValue(value: string, length: number): string;
  t(key: string, values?: TranslationValues): string;
  ticketQuantity: string;
  topUpCarrierKas: string;
  supportsCarrierTopUp: boolean;
}

export function ActionWorkspace(props: ActionWorkspaceProps) {
  const { t } = props;
  const actionFeedback = (target: ActionWorkspaceProps["feedbackTarget"]) => props.feedback && props.feedbackTarget === target
    ? <div className="action-feedback inline-action-feedback">{props.feedback}</div>
    : null;
  const hasCurrentRound = Boolean(props.metadata.roundId || props.metadata.covenant);
  const isEmptyRound = props.metadata.covenant?.soldTickets === 0;
  const isClosedEmptyRound = !props.metadata.covenant && props.round.soldTickets === 0 && props.round.status === "Closed";
  return (
    <section className="tabbed-workspace action-workspace">
      <div className="workspace-tabs" role="tablist" aria-label={t("actionTabs")}>
        <button type="button" id="round-buy-tab" className={`workspace-tab ${props.actionTab === "buy" ? "active" : ""}`} role="tab" aria-selected={props.actionTab === "buy"} aria-controls="round-buy-panel" onClick={() => props.onSelectTab("buy")}>{t("buyTickets")}</button>
        <button type="button" id="round-payout-tab" className={`workspace-tab ${props.actionTab === "payout" ? "active" : ""}`} role="tab" aria-selected={props.actionTab === "payout"} aria-controls="round-payout-panel" onClick={() => props.onSelectTab("payout")}>{t("drawPay")}</button>
      </div>
      {props.actionTab === "buy" ? (
        <section id="round-buy-panel" className="workspace-panel action-pane" role="tabpanel" aria-labelledby="round-buy-tab">
          {props.metadata.covenant && !props.finalized ? <>
            <div className="pane-heading"><p className="eyebrow">{t("participant")}</p><h2>{t("buyTickets")}</h2></div>
            <div className="purchase-form"><label className="field quantity-field"><span>{t("quantity")}</span><input type="number" inputMode="numeric" min="1" max={props.remainingTickets} step="1" value={props.ticketQuantity} onChange={(event) => props.setTicketQuantity(event.target.value)} /></label></div>
            <dl className="purchase-summary"><div><dt>{t("total")}</dt><dd>{props.formatKas(props.purchaseTotal)}</dd></div><div><dt>{t("remaining")}</dt><dd>{props.remainingTickets.toLocaleString()}</dd></div></dl>
            <p className="fee-disclosure">{props.buyCostTooltip}</p>
            {props.buyNotice ? <p className="action-status-note rescue-buy-notice" role="status">{props.buyNotice}</p> : null}
            {props.buyBlockedReason ? <p className="action-status-note" role="status">{props.buyBlockedReason}</p> : null}
            <button type="button" className="wide" onClick={props.onBuy} disabled={!props.canBuy}>{props.isBuying ? t("buyingTickets") : t(props.parsedTicketQuantity === 1 ? "buyTicketButton.one" : "buyTicketButton", { count: Number.isInteger(props.parsedTicketQuantity) && props.parsedTicketQuantity > 0 ? props.parsedTicketQuantity.toLocaleString() : "" })}</button>
            {actionFeedback("buy")}
          </> : <div className="workspace-empty"><p className="eyebrow">{t("participant")}</p><h2>{t("buyTickets")}</h2><p>{t("buyRoundFirst")}</p></div>}
        </section>
      ) : (
        <section id="round-payout-panel" className="workspace-panel action-pane" role="tabpanel" aria-labelledby="round-payout-tab">
          <div className="pane-heading"><p className="eyebrow">{t("covenantAction")}</p><h2>{isEmptyRound && props.refundAvailable ? t("closeEmptyRound") : t("drawPayout")}</h2></div>
          {!hasCurrentRound ? <div className="workspace-empty"><p>{t("buyRoundFirst")}</p></div> : props.finalized ? <><div className="winner-block"><span>{t("winner")}</span><strong>{t("winnerTicket", { ticket: props.finalized.winnerTicketId })}</strong><p className="mono"><ExplorerLink compact={false} kind="address" network={props.network} value={props.finalized.winnerAddress} /></p><p><ExplorerLink kind="transaction" network={props.network} value={props.finalized.payoutTxId} label={t("paidInTransaction", { tx: props.shortValue(props.finalized.payoutTxId, 10) })} /></p></div>{actionFeedback("draw")}</> : isClosedEmptyRound ? <><div className="winner-block empty-close-complete"><span>{t("closeEmptyRound")}</span><strong>{t("emptyRoundClosed")}</strong></div>{actionFeedback("close")}</> : <>
            {props.activeIndexerRequirement}
            <p className="pane-copy">{isEmptyRound
              ? props.refundAvailable ? t("emptyRoundCanClose") : t("buyBeforeDraw")
              : props.round.soldTickets >= props.round.maxTickets
                ? t("soldOutCanDraw")
                : props.round.soldTickets > 0
                  ? props.refundAvailable
                    ? props.metadata.covenant && props.metadata.covenant.soldTickets < props.round.minTickets
                      ? t("timeoutMustRefund", { sold: props.metadata.covenant.soldTickets.toLocaleString(), min: props.round.minTickets.toLocaleString() })
                      : t("timeoutCanDraw")
                    : t("ticketsRemain", { count: props.remainingTickets.toLocaleString() })
                  : t("buyBeforeDraw")}</p>
            {props.drawBlockedReason || props.refundBlockedReason ? <p className="action-status-note" role="status">{props.drawBlockedReason || props.refundBlockedReason}</p> : null}
            {props.supportsCarrierTopUp && props.metadata.covenant ? <div className="carrier-top-up-panel">
              <div><strong>{t("carrierTopUp.title")}</strong><p>{t("carrierTopUp.description")}</p></div>
              <label className="field compact-field"><span>{t("carrierTopUp.amount")}</span><input type="number" inputMode="decimal" min="0.19" step="0.01" value={props.topUpCarrierKas} onChange={(event) => props.setTopUpCarrierKas(event.target.value)} /></label>
              <button type="button" className="secondary" onClick={props.onTopUpCarrier} disabled={!props.canTopUpCarrier}>{props.isToppingUpCarrier ? t("carrierTopUp.submitting") : t("carrierTopUp.button")}</button>
              {actionFeedback("carrier")}
            </div> : null}
            <p className="fee-disclosure payout-fee-disclosure">{isEmptyRound && props.refundAvailable ? props.emptyCloseCostTooltip : props.payoutCostTooltip}</p>
            <div className="button-row primary-settlement-actions">
              {isEmptyRound && props.refundAvailable
                ? <button type="button" onClick={props.onCloseEmpty} disabled={!props.canCloseEmpty}>{props.isClosingEmpty ? t("closingEmptyRound") : t("closeEmptyRound")}</button>
                : <button type="button" onClick={props.onDraw} disabled={!props.canDraw}>{props.isFinalizing ? t("drawingPaying") : t("drawPay")}</button>}
            </div>
            {actionFeedback(isEmptyRound && props.refundAvailable ? "close" : "draw")}
            {!isEmptyRound ? <details className="safety-exit-disclosure" open={props.canRefund || Boolean(props.refundBlockedReason && props.refundAvailable)}>
              <summary>{t("safetyExit.title")}</summary>
              <div className="safety-exit-body">
                <p>{t("safetyExit.description")}</p>
                <p className="fee-disclosure">{props.refundCostTooltip}</p>
                <button type="button" className="secondary refund-action-button" onClick={props.onRefund} disabled={!props.canRefund}>{props.isRefunding && props.refundProgress ? t("refundingProgress", { cursor: props.refundProgress.cursor.toLocaleString(), total: props.refundProgress.total.toLocaleString() }) : props.isRefunding ? t("refunding") : t("refundAfterTimeout")}</button>
                {actionFeedback("refund")}
              </div>
            </details> : null}
          </>}
        </section>
      )}
    </section>
  );
}
