import type {
  ContextBinding,
  ContextPack,
  ContextRequest,
  EvidenceItem,
  GraphClient,
} from "./contracts";
import { requestSchema } from "./contracts";
import { hash, normalizedPath, sourceRevision } from "./source";
import { fitPack, type PendingPage } from "./budget";
import type { RetrievalAssistant } from "./local-model";
import { scopedQuery } from "./query";
import { refreshConstraints } from "./constraints";
import { retrieve } from "./workflow";
import { hasSavedReadUncertainty } from "./saved-read";
import { finishPack, initialPack, resumePack } from "./lifecycle";

interface Cached {
  evidence: EvidenceItem[];
  candidates: ContextPack["candidates"];
  unknown: string[];
  truncated: string[];
  files: string[];
  ambiguous: boolean;
}
const WORKFLOW = "broker-v1";
export class ContextBroker {
  private cache = new Map<string, Cached>();
  private pages = new Map<string, PendingPage>();
  constructor(
    private readonly engine: GraphClient,
    readonly binding: ContextBinding,
    private readonly assistant?: RetrievalAssistant,
    private readonly diagnostic?: (record: unknown) => void | Promise<void>,
  ) {
    if (!binding.project.path || !binding.project.repoId)
      throw new Error("Context broker requires a verified repository binding");
    binding.scope = binding.scope.map(normalizedPath);
    if (
      binding.scope.some(
        (p) => p.startsWith("/") || p.includes("..") || /^[a-z]:/i.test(p),
      )
    )
      throw new Error("Context visibility must use repository-relative paths");
  }
  async execute(raw: unknown): Promise<ContextPack> {
    const request = requestSchema.parse(raw),
      started = performance.now();
    const source = await sourceRevision(this.binding.project.path!);
    if (source.branch !== this.binding.branch)
      throw new Error(
        "The bound goal branch changed. The host must stop or rebind this worker.",
      );
    const coverage: ContextPack["coverage"] = {
      status: "partial",
      unknown: [],
      truncated: [],
      constraintsRemaining: 0,
      canAct: true,
    };
    const calls: string[] = [],
      query = scopedQuery(this.engine, this.binding, calls, coverage);
    const before = await query("get_query_revision", {
      repo_id: this.binding.project.repoId,
    });
    const pack = initialPack(
      this.binding,
      request,
      source,
      before,
      calls,
      coverage,
      this.assistant,
    );
    if (request.continuation)
      return resumePack(this.binding, request, pack, this.pages, query);
    const key = this.cacheKey(request, pack),
      cached = pack.revision.graphReady ? this.cache.get(key) : undefined;
    const result = cached
      ? this.restore(cached, pack)
      : await retrieve(request, {
          binding: this.binding,
          pack,
          query,
          assistant: this.assistant,
        });
    if (
      !cached &&
      pack.revision.graph &&
      pack.revision.graphReady &&
      !hasSavedReadUncertainty(pack.coverage) &&
      !result.ambiguous
    )
      this.remember(key, pack, result);
    // Governance is refreshed on every request; it never comes from the retrieval cache.
    await refreshConstraints(this.binding, request, pack, result.files, query);
    await finishPack(this.binding, pack, query, result.ambiguous, started);
    if (!pack.revision.stable || hasSavedReadUncertainty(pack.coverage))
      this.cache.delete(key);
    await this.diagnostic?.({ request, pack });
    this.prunePages();
    return fitPack(pack, request.budgetChars, this.pages);
  }
  private cacheKey(request: ContextRequest, pack: ContextPack): string {
    return hash(
      JSON.stringify([
        WORKFLOW,
        pack.binding,
        pack.revision.fingerprint,
        pack.revision.graph,
        request,
        this.assistant?.model,
      ]),
    );
  }
  private restore(
    cached: Cached,
    pack: ContextPack,
  ): { files: string[]; ambiguous: boolean } {
    pack.evidence = structuredClone(cached.evidence);
    pack.candidates = structuredClone(cached.candidates);
    pack.coverage.unknown.push(...cached.unknown);
    pack.coverage.truncated.push(...cached.truncated);
    pack.telemetry.cacheHit = true;
    return { files: cached.files, ambiguous: cached.ambiguous };
  }
  private remember(
    key: string,
    pack: ContextPack,
    result: { files: string[]; ambiguous: boolean },
  ): void {
    this.cache.set(key, {
      evidence: structuredClone(pack.evidence),
      candidates: structuredClone(pack.candidates),
      unknown: [...pack.coverage.unknown],
      truncated: [...pack.coverage.truncated],
      ...result,
    });
    if (this.cache.size > 32)
      this.cache.delete(this.cache.keys().next().value!);
  }
  private prunePages(): void {
    for (const [token, page] of this.pages)
      if (page.expires < Date.now()) this.pages.delete(token);
    while (this.pages.size > 64)
      this.pages.delete(this.pages.keys().next().value!);
  }
}
