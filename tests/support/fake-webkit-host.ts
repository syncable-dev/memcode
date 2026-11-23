import type { NativeHost } from "../../runtime/host";

export interface FakeSurface {
  nativeId: string;
  owner: string;
  opener: string | null;
  profile?: string;
  url: string;
  title: string;
  loading: boolean;
  loads: number;
  history: string[];
  position: number;
  visible: boolean;
  bounds?: unknown;
}

/** Stands in for `src-tauri/src/browser/macos`: same methods, same replies. */
export class FakeWebKitHost implements NativeHost {
  readonly calls: Array<{ method: string; input: any }> = [];
  readonly surfaces = new Map<string, FakeSurface>();
  titles = new Map<string, string>();
  private next = 1;

  async call<T>(method: string, input: any = {}): Promise<T> {
    this.calls.push({ method, input });
    return this.reply(method, input) as T;
  }

  /** A page opened a window, as WebKit's createWebView would. */
  popup(opener: string, url: string) {
    const parent = this.surfaces.get(opener)!;
    const surface = this.surface(parent.owner, opener);
    this.load(surface, url);
    return surface;
  }

  /** The human clicked a link inside the native surface. */
  follow(nativeId: string, url: string) {
    this.load(this.surfaces.get(nativeId)!, url);
  }

  private surface(owner: string, opener: string | null) {
    const surface: FakeSurface = {
      nativeId: `native-${this.next++}`,
      owner,
      opener,
      url: "about:blank",
      title: "",
      loading: false,
      loads: 0,
      history: [],
      position: -1,
      visible: false,
    };
    this.surfaces.set(surface.nativeId, surface);
    return surface;
  }

  private load(surface: FakeSurface, url: string, record = true) {
    if (record) {
      surface.history.splice(surface.position + 1, Infinity, url);
      surface.position = surface.history.length - 1;
    }
    surface.url = url;
    surface.loads++;
    surface.title = this.titles.get(url) ?? new URL(url).host;
  }

  private owned(input: any) {
    const surface = this.surfaces.get(input.nativeId);
    if (!surface) throw Error("Browser surface not found");
    if (surface.owner !== input.taskId)
      throw Error("Browser surface belongs to another work item");
    return surface;
  }

  private reply(method: string, input: any): unknown {
    switch (method) {
      case "browser_create": {
        const surface = this.surface(input.taskId, null);
        surface.profile = input.profile;
        return { nativeId: surface.nativeId };
      }
      case "browser_pages":
        return [...this.surfaces.values()]
          .filter((surface) => surface.owner === input.taskId)
          .map(({ nativeId, opener, url, title, loading, loads }) => ({
            nativeId,
            opener,
            url,
            title,
            loading,
            loads,
          }));
      case "browser_navigate":
        this.load(this.owned(input), input.url);
        return null;
      case "browser_history": {
        const surface = this.owned(input);
        const step = { back: -1, forward: 1, reload: 0 }[input.action as string]!;
        const position = surface.position + step;
        if (position >= 0 && position < surface.history.length) {
          surface.position = position;
          this.load(surface, surface.history[position], false);
        }
        return null;
      }
      case "browser_surface": {
        const shown = this.owned(input);
        for (const surface of this.surfaces.values()) surface.visible = false;
        shown.visible = input.visible;
        if (input.bounds) shown.bounds = input.bounds;
        return null;
      }
      case "browser_hide_all":
        for (const surface of this.surfaces.values()) surface.visible = false;
        return null;
      case "browser_close":
        this.owned(input);
        this.surfaces.delete(input.nativeId);
        return null;
      case "browser_close_task":
        for (const [id, surface] of this.surfaces)
          if (surface.owner === input.taskId) this.surfaces.delete(id);
        return null;
      case "browser_close_all":
        this.surfaces.clear();
        return null;
      case "browser_capture":
        this.owned(input);
        return { data: "iVBORw0KGgo=", width: 1280, height: 800 };
      default:
        throw Error(`Unknown browser surface operation ${method}`);
    }
  }
}
