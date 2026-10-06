import { useRef, useState } from "react";
import { useNetwork } from "../lib/network-context";
import { networkGroups } from "../lib/networks";
import { useDismiss } from "./dropdown";
import { ChevronDown } from "./Icons";

/** Header dropdown that switches among the live network and the scenario forks. */
export function NetworkSelector() {
  const { key, info, setKey } = useNetwork();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className="net-btn"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={`Chain or scenario: ${info.label}`}
        data-testid="network-selector"
        data-network={key}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={info.isFork ? "dot dot--fork" : "dot dot--live"} />
        <span className="net-btn-text">
          <span className="net-btn-caption">Chain / scenario</span>
          <span className="net-btn-name">{info.label}</span>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu net-menu" aria-label="Choose chain or scenario">
          {networkGroups().map((group) => (
            <div key={group.title}>
              <div className="menu-group-title">{group.title}</div>
              {group.networks.map((n) => (
                <button
                  key={n.key}
                  type="button"
                  className="net-option"
                  aria-pressed={n.key === key}
                  data-testid={`network-option-${n.key}`}
                  onClick={() => {
                    setKey(n.key);
                    setOpen(false);
                  }}
                >
                  <span className={n.isFork ? "dot dot--top dot--fork" : "dot dot--top dot--live"} />
                  <span className="net-option-text">
                    <span className="net-option-name">{n.label}</span>
                    <span className="net-option-desc">{n.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
