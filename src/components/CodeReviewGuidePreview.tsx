import { useState } from "react";

const examples = [
  {
    label: "Overview",
    file: "review-overview",
    width: 1035,
    height: 185,
    alt: "Maintainability 85 out of 100 across three changed functions. Two findings, including one high priority. One of one recorded checks passed.",
    caption:
      "The recorded check passed, yet the review found two concerns. The score describes the maintainability of the measured functions. Read the findings before accepting the work.",
  },
  {
    label: "A finding",
    file: "review-finding",
    width: 1033,
    height: 244,
    alt: "An expanded high-priority finding links to invitations.ts, line 48, and offers Recorded evidence, See in changes, Discuss finding and Dismiss with reason.",
    caption:
      "An expired sign-in could lose the invitation. The finding takes you to the affected line. Open its evidence or ask the reviewer which path through the code leads to this behavior.",
  },
  {
    label: "Before & after",
    file: "review-quality",
    width: 554,
    height: 823,
    alt: "Before and after measurements for two matched functions, one addition and one removal. The matched functions’ average maintainability rises from 76 to 87.",
    caption:
      "Two functions could be matched before and after this change. Their average cognitive complexity fell from 9 to 2. The function table also shows the measurements available for each added or removed function.",
  },
];

export function CodeReviewGuidePreview() {
  const [selected, setSelected] = useState(0);
  const example = examples[selected];
  return (
    <figure
      className="guide-preview review-guide"
      aria-label="Example story review"
    >
      <div className="review-guide-bar">
        <strong>Example review</strong>
        <div
          className="review-guide-options"
          role="group"
          aria-label="Review images"
        >
          {examples.map((item, index) => (
            <button
              key={item.file}
              type="button"
              aria-pressed={selected === index}
              onClick={() => setSelected(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="review-guide-image">
        <img
          src={`/guide/${example.file}.png`}
          width={example.width}
          height={example.height}
          alt={example.alt}
          decoding="async"
        />
      </div>
      <figcaption aria-live="polite">{example.caption}</figcaption>
    </figure>
  );
}
