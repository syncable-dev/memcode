/** The most workers MemCode runs at the same time; a review counts as one too. */
export const maxWorkerSlots = 50;

/** What Settings offers, smallest first. The last choice is the limit. */
export const workerSlotChoices = [
  1,
  2,
  3,
  4,
  6,
  8,
  12,
  16,
  24,
  32,
  maxWorkerSlots,
];
