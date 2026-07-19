import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

type ExplorerValueKind = "address" | "transaction";

interface ExplorerLinkProps {
  className?: string;
  compact?: boolean;
  kind: ExplorerValueKind;
  label?: ReactNode;
  network: string;
  value?: string;
}

function explorerBase(network: string, value: string): string {
  return network === "mainnet" || value.startsWith("kaspa:")
    ? "https://kaspa.stream"
    : "https://tn10.kaspa.stream";
}

function validExplorerValue(kind: ExplorerValueKind, value: string): boolean {
  return kind === "transaction"
    ? /^[0-9a-f]{64}$/i.test(value)
    : /^(?:kaspa|kaspatest):[a-z0-9]+$/i.test(value);
}

function compactValue(value: string): string {
  return value.length > 23 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

export function ExplorerLink({ className = "", compact = true, kind, label, network, value }: ExplorerLinkProps) {
  if (!value || !validExplorerValue(kind, value)) {
    return <span className={className}>{label ?? value}</span>;
  }

  const path = kind === "transaction" ? "transactions" : "addresses";
  const href = `${explorerBase(network, value)}/${path}/${value}`;

  return (
    <a
      className={`explorer-link ${className}`.trim()}
      href={href}
      target="_blank"
      rel="noreferrer"
      title={value}
    >
      <span>{label ?? (compact ? compactValue(value) : value)}</span>
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

export function ExplorerText({ network, text }: { network: string; text: string }) {
  const tokens = text.split(/((?:kaspa|kaspatest):[a-z0-9]+|[0-9a-f]{64})/gi);

  return <>{tokens.map((token, index) => {
    if (/^(?:kaspa|kaspatest):[a-z0-9]+$/i.test(token)) {
      return <ExplorerLink key={`${token}-${index}`} kind="address" network={network} value={token} />;
    }
    if (/^[0-9a-f]{64}$/i.test(token)) {
      return <ExplorerLink key={`${token}-${index}`} kind="transaction" network={network} value={token} />;
    }
    return token;
  })}</>;
}
