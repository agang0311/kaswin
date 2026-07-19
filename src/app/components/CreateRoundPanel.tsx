import { RefreshCw } from "lucide-react";
import { DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI, REGISTRY_MARKER_REFUND_FEE_SOMPI, REGISTRY_PAYMENT_FEE_SOMPI } from "../../kaspa/transactions";
import type { RaffleMetadata } from "../../raffle/types";
import type { ReactNode } from "react";
import type { TranslationValues } from "../i18n";

type RefundTimeoutPart = "months" | "days" | "hours" | "minutes" | "seconds";

interface CreateRoundPanelProps {
  canStartNewRound: boolean;
  createCostTooltip: string;
  createRegistryAddress: string;
  covenantCarrierSompi: string;
  finalized: boolean;
  feedback?: ReactNode;
  formatKas(value: bigint): string;
  isCreatingRound: boolean;
  maxPurchaseBatches: number;
  metadata: Pick<RaffleMetadata, "ticketPrice" | "maxTickets" | "minTickets" | "maxBatches">;
  minimumTicketPrice: string;
  networkId: string;
  onCreate: () => void;
  onRegistryAddressChange(value: string): void;
  onResetRegistry(): void;
  onTimeoutChange(key: RefundTimeoutPart, value: string): void;
  onUpdateMetadata(field: "ticketPrice" | "maxTickets" | "minTickets" | "maxBatches", value: string | number): void;
  refundTimeoutDisplay: string;
  refundTimeoutFields: ReadonlyArray<{ key: RefundTimeoutPart; labelKey: string }>;
  refundTimeoutParts: Record<RefundTimeoutPart, string>;
  recommendedMaxBatches: number;
  registryAddress: string;
  registryMarkerRefundAmount: bigint;
  setCarrierSompi(value: string): void;
  sompiToKasInput(value: string): string;
  kasInputToSompi(value: string): string;
  t(key: string, values?: TranslationValues): string;
  usesAutoRefundRegistry: boolean;
  usesDefaultRegistry: boolean;
}

export function CreateRoundPanel(props: CreateRoundPanelProps) {
  const { t } = props;
  return (
    <section id="round-create-panel" className="workspace-panel" role="tabpanel" aria-labelledby="round-create-tab">
      {props.canStartNewRound ? (
        <>
          <div className="pane-heading">
            <p className="eyebrow">{t("organizer")}</p>
            <h2>{props.finalized ? t("createNextRound") : t("createARound")}</h2>
          </div>
          <div className="form-grid create-parameters-grid">
            <label className="field compact-number-field">
              <span>{t("ticketPriceKas")}</span>
              <input inputMode="decimal" value={props.sompiToKasInput(props.metadata.ticketPrice)} onChange={(event) => props.onUpdateMetadata("ticketPrice", props.kasInputToSompi(event.target.value))} />
            </label>
            <label className="field compact-number-field">
              <span>{t("totalTickets")}</span>
              <input type="number" min={1} max={1_000_000} value={props.metadata.maxTickets} onChange={(event) => props.onUpdateMetadata("maxTickets", Number(event.target.value))} />
            </label>
            <label className="field compact-number-field">
              <span>{t("minimumTickets")}</span>
              <input type="number" min={1} max={props.metadata.maxTickets} value={props.metadata.minTickets} onChange={(event) => props.onUpdateMetadata("minTickets", Number(event.target.value))} />
            </label>
            <label className="field compact-number-field">
              <span>{t("maximumPurchaseBatches")}</span>
              <input type="number" min={1} max={props.maxPurchaseBatches} value={props.metadata.maxBatches} onChange={(event) => props.onUpdateMetadata("maxBatches", Number(event.target.value))} />
            </label>
          </div>
          <div className={`batch-recommendation${(props.metadata.maxBatches ?? 0) > props.recommendedMaxBatches ? " warning" : ""}`} role="note">
            <span>{t((props.metadata.maxBatches ?? 0) > props.recommendedMaxBatches ? "maxBatchesRecommendationExceeded" : "maxBatchesRecommendation", {
              duration: props.refundTimeoutDisplay,
              recommended: props.recommendedMaxBatches.toLocaleString(),
              maximum: props.maxPurchaseBatches.toLocaleString(),
              selected: (props.metadata.maxBatches ?? 0).toLocaleString()
            })}</span>
            {(props.metadata.maxBatches ?? 0) !== props.recommendedMaxBatches ? (
              <button type="button" className="inline-suggestion-button" onClick={() => props.onUpdateMetadata("maxBatches", props.recommendedMaxBatches)}>
                {t("useRecommendedBatches")}
              </button>
            ) : null}
          </div>
          <p className="create-parameter-note">{t("ticketPriceRefundFloor", { minimum: props.minimumTicketPrice })}</p>

          <section className="registry-config" aria-labelledby="registry-config-title">
            <div className="registry-field-row">
              <label className="field">
                <span id="registry-config-title">{t("registryAddress")}</span>
                <input value={props.createRegistryAddress} onChange={(event) => props.onRegistryAddressChange(event.target.value.trim())} placeholder={props.networkId === "mainnet" ? "kaspa:..." : "kaspatest:..."} aria-describedby="registry-cost-details" />
              </label>
              <button type="button" className="icon-button secondary" onClick={props.onResetRegistry} disabled={!props.registryAddress || props.usesDefaultRegistry} aria-label={t("useDefaultRegistry")}>
                <RefreshCw size={17} />
              </button>
            </div>
            <dl id="registry-cost-details" className="registry-cost-details">
              <div><dt>{t("sentToRegistry")}</dt><dd>{props.usesAutoRefundRegistry ? props.formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI) : props.formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI)}</dd></div>
              <div><dt>{t("registryPaymentFee")}</dt><dd>{t("registryPaymentFeeDetail", { fee: props.formatKas(REGISTRY_PAYMENT_FEE_SOMPI) })}</dd></div>
              <div><dt>{t("automaticMarkerRefund")}</dt><dd>{props.usesAutoRefundRegistry ? t("registryRefundDefault", { marker: props.formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI), refund: props.formatKas(props.registryMarkerRefundAmount), fee: props.formatKas(REGISTRY_MARKER_REFUND_FEE_SOMPI) }) : t(props.usesDefaultRegistry ? "registryRefundRetained" : "registryRefundCustom", { amount: props.formatKas(DEFAULT_RAFFLE_REGISTRY_MARKER_SOMPI) })}</dd></div>
            </dl>
            <p className="registry-note">{props.usesDefaultRegistry ? t(props.usesAutoRefundRegistry ? "registryDefaultNote" : "registryRetainedNote") : t("registryCustomNote")}</p>
          </section>

          <details className="disclosure compact-disclosure">
            <summary>{t("drawRefundTimeout", { duration: props.refundTimeoutDisplay })}</summary>
            <div className="duration-grid disclosure-body">
              {props.refundTimeoutFields.map((field) => (
                <label className="field compact-field" key={field.key}>
                  <span>{t(field.labelKey)}</span>
                  <input inputMode="numeric" min={0} type="number" value={props.refundTimeoutParts[field.key]} onChange={(event) => props.onTimeoutChange(field.key, event.target.value)} />
                </label>
              ))}
            </div>
          </details>

          <p className="fee-disclosure organizer-fee-disclosure">{props.createCostTooltip}</p>
          <button type="button" className="wide secondary organizer-create-button" onClick={props.onCreate} disabled={props.isCreatingRound || !props.canStartNewRound}>
            {props.isCreatingRound ? t("creatingRound") : props.finalized ? t("createNextRound") : t("createRound")}
          </button>
        </>
      ) : (
        <div className="workspace-empty"><p className="eyebrow">{t("organizer")}</p><h2>{t("roundInProgress")}</h2><p>{t("roundInProgressDetail")}</p></div>
      )}
      {props.feedback ? <div className="action-feedback inline-action-feedback">{props.feedback}</div> : null}
    </section>
  );
}
