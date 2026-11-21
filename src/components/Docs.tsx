import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CirclePlay,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { guideArticles, type GuideDestination } from "../guide-content";
import { GuideFlow } from "./GuideFlow";
import { GuidePreview } from "./GuidePreview";
import "../styles-docs.css";
export function Docs({
  onStartGuide,
  onWatchTour,
  onGo,
  initialArticle = "start",
}: {
  onStartGuide: (action: "resume" | "restart") => void;
  onWatchTour: () => void;
  onGo: (destination: GuideDestination) => void;
  initialArticle?: string;
}) {
  const [selected, setSelected] = useState(initialArticle),
    [search, setSearch] = useState("");
  useEffect(() => setSelected(initialArticle), [initialArticle]);
  useEffect(() => {
    document
      .querySelector(".workspace-scroll")
      ?.scrollTo({ top: 0, behavior: "instant" });
  }, [selected]);
  const article =
      guideArticles.find((item) => item.id === selected) ?? guideArticles[0],
    filtered = guideArticles.filter((item) =>
      [item.title, item.summary, ...item.steps, ...(item.details ?? [])]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
    ),
    groups = [...new Set(guideArticles.map((item) => item.group))];
  return (
    <section className="docs-suite" aria-label="MemCode user guide">
      <aside className="docs-index">
        <label className="docs-search">
          <Search size={13} />
          <input
            aria-label="Search the user guide"
            placeholder="Find an answer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              aria-label="Clear guide search"
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </label>
        <nav aria-label="Guide topics">
          {groups.map((group) => (
            <div key={group}>
              {filtered.some((item) => item.group === group) && (
                <h3>{group}</h3>
              )}
              {filtered
                .filter((item) => item.group === group)
                .map((item) => (
                  <button
                    key={item.id}
                    aria-current={article.id === item.id ? "page" : undefined}
                    onClick={() => setSelected(item.id)}
                  >
                    {item.title}
                    {article.id === item.id && <ChevronRight size={12} />}
                  </button>
                ))}
            </div>
          ))}
          {!filtered.length && (
            <p className="docs-no-results">
              No matching topic. Try “goal”, “worker” or “review”.
            </p>
          )}
        </nav>
      </aside>
      <article className="docs-article" key={article.id}>
        <div className="docs-breadcrumb">
          <BookOpen size={12} /> THE MEMCODE GUIDE<span>/</span>
          {article.group}
        </div>
        <h2>{article.title}</h2>
        <p className="docs-lead">{article.summary}</p>
        {article.id === "start" && (
          <>
            <GuideFlow onTopic={setSelected} />
            <div className="docs-start-actions">
              <button className="button primary" onClick={() => onStartGuide("resume")}>
                <Sparkles size={14} />
                Guide me through
                <ArrowRight size={14} />
              </button>
              <button className="button secondary" onClick={onWatchTour}>
                <CirclePlay size={15} /> Watch product tour
              </button>
            </div>
          </>
        )}
        {article.id !== "start" && (
          <GuidePreview
            topic={article.id}
            title={article.title}
            caption={article.caption}
          />
        )}
        <ol className="docs-steps">
          {article.steps.map((step, index) => (
            <li key={index}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
        {article.note && (
          <aside className="docs-note">
            <Check size={14} />
            <p>{article.note}</p>
          </aside>
        )}
        {article.details?.length ? (
          <section className="docs-details" aria-labelledby="docs-details-heading">
            <h3 id="docs-details-heading">In more detail</h3>
            {article.details.map((detail, index) => (
              <p key={index}>{detail}</p>
            ))}
          </section>
        ) : null}
        <footer className="docs-article-footer">
          {article.destination && (
            <button
              className="button secondary"
              onClick={() => onGo(article.destination!)}
            >
              Open{" "}
              {article.destination === "board"
                ? "Workspace"
                : article.destination === "fleet"
                  ? "Decisions"
                  : article.destination.charAt(0).toUpperCase() +
                    article.destination.slice(1)}
              <ArrowRight size={13} />
            </button>
          )}
          {article.id !== "start" && (
            <button
              className="docs-text-button"
              onClick={() => onStartGuide("restart")}
            >
              Restart guided setup
              <Sparkles size={12} />
            </button>
          )}
        </footer>
        {article.related?.length && (
          <div className="docs-related">
            <h3>Continue when you need it</h3>
            <div>
              {article.related
                .map((id) => guideArticles.find((item) => item.id === id))
                .filter(Boolean)
                .map((item) => (
                  <button key={item!.id} onClick={() => setSelected(item!.id)}>
                    {item!.title}
                    <ArrowRight size={12} />
                  </button>
                ))}
            </div>
          </div>
        )}
      </article>
    </section>
  );
}
