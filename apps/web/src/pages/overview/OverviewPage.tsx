import { CapacitySection } from "./CapacitySection";
import { Facts } from "./Facts";
import { Hero } from "./Hero";
import { Innovation } from "./Innovation";

export function OverviewPage() {
  return (
    <div className="stack-xl">
      <Hero />
      <Facts />
      <Innovation />
      <CapacitySection />
    </div>
  );
}
