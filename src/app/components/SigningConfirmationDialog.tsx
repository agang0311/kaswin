import type { ReactNode } from "react";
import { translate, type Language } from "../i18n";
import { ExplorerLink } from "./ExplorerLink";

export type SigningOperation = "create" | "publish-registry" | "buy" | "top-up-carrier" | "sponsor-refund";

export interface SigningConfirmationPreview {
  operation: SigningOperation;
  network: string;
  address: string;
  inputCount: string;
  payment: string;
  fee: string;
  carrier: string;
  change: string;
  covenant: string;
  registry: string;
  ticketRange: string;
  /** A state identity that must still match when a Buy is confirmed. */
  snapshot?: string;
}

interface SigningConfirmationDialogProps {
  language: Language;
  preview: SigningConfirmationPreview | null;
  onCancel(): void;
  onConfirm(): void;
  confirming?: boolean;
}

const labels: Array<[keyof Omit<SigningConfirmationPreview, "operation" | "snapshot">, string]> = [
  ["network", "signing.network"],
  ["address", "signing.address"],
  ["inputCount", "signing.inputCount"],
  ["payment", "signing.payment"],
  ["fee", "signing.fee"],
  ["carrier", "signing.carrier"],
  ["change", "signing.change"],
  ["covenant", "signing.covenant"],
  ["registry", "signing.registry"],
  ["ticketRange", "signing.ticketRange"]
];

function operationTitle(operation: SigningOperation, t: (key: string) => string): string {
  if (operation === "create") return t("signing.title.create");
  if (operation === "publish-registry") return t("signing.title.registry");
  if (operation === "buy") return t("signing.title.buy");
  if (operation === "top-up-carrier") return t("signing.title.topUpCarrier");
  return t("signing.title.refund");
}

/**
 * This dialog intentionally contains no wallet or RPC calls. A user must see
 * and explicitly accept the immutable preview before an action can sign.
 */
export function SigningConfirmationDialog({ language, preview, onCancel, onConfirm, confirming = false }: SigningConfirmationDialogProps) {
  if (!preview) return null;
  const t = (key: string) => translate(language, key);
  return (
    <div className="signing-confirmation-backdrop" role="presentation">
      <section className="signing-confirmation" role="dialog" aria-modal="true" aria-labelledby="signing-confirmation-title">
        <p className="eyebrow">{t("signing.eyebrow")}</p>
        <h2 id="signing-confirmation-title">{operationTitle(preview.operation, t)}</h2>
        <p className="pane-copy">{t("signing.description")}</p>
        <dl className="stat-list dense signing-preview">
          {labels.map(([key, label]) => {
            const isAddress = key === "address" || key === "covenant" || key === "registry";
            return <div key={key}><dt>{t(label)}</dt><dd className={isAddress ? "mono" : undefined}>{isAddress ? <ExplorerLink compact={false} kind="address" network={preview.network} value={preview[key]} /> : preview[key] as ReactNode}</dd></div>;
          })}
        </dl>
        <p className="signing-note">{t("signing.note")}</p>
        <div className="button-row">
          <button type="button" className="secondary" onClick={onCancel} disabled={confirming}>{t("signing.cancel")}</button>
          <button type="button" onClick={onConfirm} disabled={confirming}>{confirming ? t("signing.preparing") : t("signing.confirm")}</button>
        </div>
      </section>
    </div>
  );
}
