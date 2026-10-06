import { Audiences } from "./Audiences";
import { CapacitySection } from "./CapacitySection";
import { Hero } from "./Hero";
import { HowItWorks } from "./HowItWorks";

export function OverviewPage() {
  return (
    <div className="stack-xl">
      <Hero />
      <CapacitySection />
      <HowItWorks />
      <Audiences />
    </div>
  );
}
