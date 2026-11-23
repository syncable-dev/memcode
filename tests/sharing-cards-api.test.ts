import { cardsApiScenarios } from "./support/cards-api-scenarios";
import { startStandInMemsync } from "./support/memsync-stand-in";

cardsApiScenarios("stand-in sharing service", async () => {
  const service = await startStandInMemsync();
  return {
    address: service.address,
    tokenFor: (person) => service.tokenFor(person),
    close: () => service.close(),
  };
});
