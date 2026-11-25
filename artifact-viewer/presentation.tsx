import { useEffect, useRef, useState } from "react";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS } from "@aiden0z/pptx-renderer";
import { currentReviewTarget } from "./reveal";
export default function Presentation({ bytes }: { bytes: ArrayBuffer }) {
  const container = useRef<HTMLDivElement>(null),
    viewer = useRef<PptxViewer>(null),
    [count, setCount] = useState(0),
    [slide, setSlide] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const instance = new PptxViewer(container.current!, {
      externalMedia: "block",
      pdfjs: false,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazyMedia: true,
      lazySlides: true,
      onSlideChange: (index) => {
        if (live) setSlide(index);
      },
    });
    viewer.current = instance;
    void instance
      .open(bytes, { renderMode: "slide", lazyMedia: true, lazySlides: true })
      .then(() => {
        if (live) setCount(instance.slideCount);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      viewer.current = null;
      instance.destroy();
    };
  }, [bytes]);
  const go = (index: number) =>
    void viewer.current?.goToSlide(index).catch((e) => setError(e.message));
  useEffect(() => {
    const reveal = (event: Event) => {
      const page = (event as CustomEvent).detail.page;
      if (page && page <= count) go(page - 1);
    };
    window.addEventListener("memcode:reveal", reveal);
    const target = currentReviewTarget();
    if (target?.page && target.page <= count) go(target.page - 1);
    return () => window.removeEventListener("memcode:reveal", reveal);
  }, [count]);
  return (
    <div className="presentation-viewer">
      <header className="slide-toolbar">
        <span>Presentation</span>
        <button
          aria-label="Previous slide"
          disabled={!slide}
          onClick={() => go(slide - 1)}
        >
          ←
        </button>
        <strong>
          {slide + 1} / {count || "…"}
        </strong>
        <button
          aria-label="Next slide"
          disabled={slide >= count - 1}
          onClick={() => go(slide + 1)}
        >
          →
        </button>
      </header>
      {error && (
        <div className="viewer-error" role="alert">
          {error}
        </div>
      )}
      <div className="slide-stage" data-page={slide + 1}>
        {/* The slide is fitted to this, which has no padding of its own. */}
        <div ref={container} />
      </div>
    </div>
  );
}
