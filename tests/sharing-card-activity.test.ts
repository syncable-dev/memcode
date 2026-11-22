import { cardActivityScenarios } from "./support/card-activity-scenarios";
import { startStandInMemsync } from "./support/memsync-stand-in";

cardActivityScenarios("stand-in sharing service", async () => {
  const service = await startStandInMemsync();
  return {
    address: service.address,
    tokenFor: (person) => service.tokenFor(person),
    close: () => service.close(),
  };
});
