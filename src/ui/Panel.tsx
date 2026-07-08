import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  eyebrow?: string;
  children: ReactNode;
}

export function Panel({ title, eyebrow, children }: PanelProps) {
  return (
    <section className="panel">
      <div className="panel-heading">
        {eyebrow ? <span>{eyebrow}</span> : null}
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

