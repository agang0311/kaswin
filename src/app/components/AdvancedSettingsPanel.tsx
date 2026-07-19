import type { ReactNode } from "react";

interface AdvancedSettingsPanelProps {
  children: ReactNode;
  title: string;
}

/** Shared disclosure shell for local-only advanced settings. */
export function AdvancedSettingsPanel({ children, title }: AdvancedSettingsPanelProps) {
  return <details className="technical-section disclosure"><summary>{title}</summary><div className="technical-grid disclosure-body">{children}</div></details>;
}
